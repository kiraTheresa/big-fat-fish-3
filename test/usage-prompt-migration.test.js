import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'fish-usage-prompt-migration-'));
Object.assign(process.env, { DATA_DIR: root, CONFIG_PATH: join(root, 'none.json') });
const { defaultPromptConfig } = await import('../src/prompt/defaults.js');
const { initializePrompts, configHash } = await import('../src/prompt/store.js');
await mkdir(join(root, 'management'));
after(() => rm(root, { recursive: true, force: true }));

test('adding the report tool upgrades old saved configurations without replacing custom rules; disabled tools stay disabled', async () => {
  const config = defaultPromptConfig();
  delete config.tools.send_usage_report;
  config.prompts.toolRules = '自定义工具规则，不应追加无关表情规则。';
  const version = { id:'builtin',number:0,config,hash:configHash(config) };
  const saved = { schema:1,published:structuredClone(version),versions:[structuredClone(version)],draft:{...structuredClone(version),revision:'before',updatedAt:1},tests:[] };
  await writeFile(join(root,'management','prompts.json'),JSON.stringify(saved));
  const migrated = await initializePrompts();
  assert.equal(migrated.published.config.tools.send_usage_report.enabled,true);
  assert.equal(migrated.published.config.prompts.toolRules,config.prompts.toolRules);
  assert.notEqual(migrated.draft.revision,'before');
  for(const version of [migrated.published,migrated.draft,...migrated.versions]) version.config.tools.send_usage_report.enabled=false;
  await writeFile(join(root,'management','prompts.json'),JSON.stringify(migrated));
  const reloaded=await initializePrompts();
  assert.equal(reloaded.published.config.tools.send_usage_report.enabled,false);
  assert.equal(reloaded.draft.revision,migrated.draft.revision);
});
