import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { buildChatRequest } from '../../src/prompt/builder.js';
import { defaultPromptConfig } from '../../src/prompt/defaults.js';

const model = 'Xenova/bge-small-zh-v1.5';
const revision = '75c43b069aac4d136ba6bc1122f995fedcfd2781';
const localModel = new URL('./tmp/model/', import.meta.url);
env.allowRemoteModels = false;
const extract = await pipeline('feature-extraction', fileURLToPath(localModel), {
  dtype: 'q8', local_files_only: true, session_options: { intraOpNumThreads: 1 },
});

async function embed(text) {
  const output = await extract(text, { pooling: 'cls', normalize: true });
  const vector = Array.from(output.data);
  assert.equal(vector.length, 512);
  assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-5, '向量应归一化');
  return vector;
}

const markdown = (await readFile(new URL('./handbook.md', import.meta.url), 'utf8')).trim();
const [heading, , ...body] = markdown.split('\n\n');
const entry = {
  id: 'liang-wenfeng-dad',
  groupId: '10001',
  kind: '群内玩梗',
  text: [heading, ...body].join('\n\n'),
  vector: await embed(markdown),
};
const index = { model, revision, dtype: 'q8', dimensions: entry.vector.length, entries: [entry] };

const settings = defaultPromptConfig();
settings.tools = {};
settings.prompts.toolRules = '';
// shortcut: threshold fits this fixture, recalibrate with labeled queries when the handbook grows.
const threshold = 0.60;
const queryPrefix = '为这个句子生成表示以用于检索相关文章：';
const dadQuestion = '梁文锋是你爹吗？';
const scenarios = [
  { name: '启用群问亲属梗', groupId: '10001', question: dadQuestion, expected: entry.id },
  { name: '启用群问人物是谁', groupId: '10001', question: '梁文锋是谁？', expected: null },
  { name: '未启用群问同一句', groupId: '10002', question: dadQuestion, expected: null },
];

const results = [];
for (const { name, groupId, question, expected } of scenarios) {
  const candidates = index.entries.filter((item) => item.groupId === groupId);
  const queryVector = candidates.length ? await embed(queryPrefix + question) : null;
  // Dot product equals cosine similarity for normalized vectors.
  const ranked = candidates.map((item) => ({
    item,
    cosine: item.vector.reduce((sum, value, i) => sum + value * queryVector[i], 0),
  })).sort((a, b) => b.cosine - a.cosine);
  const best = ranked[0];
  const hit = best?.cosine >= threshold ? best.item : null;
  const systemSuffix = hit
    ? `\n\n## 本轮肥鱼指导手册\n条目：${hit.id}\n类型：${hit.kind}\n${hit.text}`
    : '';
  const { request } = buildChatRequest(settings, {
    event: { message_type: 'group', group_id: groupId, user_id: '1', sender: { nickname: '群友' } },
    text: question,
    nowMs: new Date(2026, 10, 13, 20).getTime(),
    systemSuffix,
  });
  results.push({
    name, groupId, question,
    candidates: ranked.map(({ item, cosine }) => ({ id: item.id, cosine })),
    hit: hit ? { id: hit.id, text: hit.text } : null,
    reason: hit ? '命中' : best ? '低于相似度阈值' : '当前群无适用条目',
    request,
  });
  console.log(`${name}｜${best ? best.cosine.toFixed(4) : '未计算相似度'}｜${hit?.id ?? results.at(-1).reason}`);
}
await extract.dispose();

for (const [i, { name, expected }] of scenarios.entries()) {
  assert.equal(results[i].hit?.id ?? null, expected, name);
  assert.equal(results[i].request.messages[0].content.includes('## 本轮肥鱼指导手册'), Boolean(expected), name);
}

const outputDir = new URL('./tmp/', import.meta.url);
await mkdir(outputDir, { recursive: true });
await writeFile(new URL('index.json', outputDir), JSON.stringify(index, null, 2) + '\n');
await writeFile(new URL('results.json', outputDir), JSON.stringify({ threshold, results }, null, 2) + '\n');
console.log(`索引和完整 DeepSeek 请求已保存到 ${fileURLToPath(outputDir)}`);
