// Explicit collection and library controls. Group commands retain the normal @ gate.
import { matchAt } from '../utils/at.js';
import { extractText } from '../utils/extract-text.js';
import { canManageSession } from '../platform/permissions.js';
import { getPromptConfig } from '../prompt/store.js';
import { logger } from '../utils/logger.js';
import { collectFromEvent, sendStoredMeme } from '../memes/service.js';
import { searchMemes, updateMeme } from '../store/meme-library.js';

const HELP = [
  '本鱼的表情包：',
  '/meme save 名称或含义 — 附一张表情或引用它，教本鱼收藏',
  '/meme list [关键词] — 看当前会话的收藏和 ID',
  '/meme send 名称或ID — 发一个已收藏的表情',
  '/meme rename ID 新名称 — 修改名称/含义',
  '/meme disable ID / enable ID — 停用/恢复',
  '群聊需 @ 本鱼；修改和停用需管理员。各会话的收藏独立。',
].join('\n');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class CommandError extends Error {}
const requireText = (value, usage) => { if (!value || value.length > 300) throw new CommandError(usage); return value; };
const requireId = (id) => { if (!UUID.test(id)) throw new CommandError('请从 /meme list 复制完整表情 ID。'); return id; };

// Dependency injection keeps command behavior testable without a real QQ account.
export function createMemeTrigger({ collect = collectFromEvent, send = sendStoredMeme,
  search = searchMemes, update = updateMeme, settings = getPromptConfig, canManage = canManageSession } = {}) {
  return {
    name: 'meme',
    match(event) { return /^\/(meme|表情)(\s|$)/.test(extractText(event)); },
    async handle(ctx) {
      if (ctx.event.message_type === 'group' && !matchAt(ctx.event)) return;
      const text = extractText(ctx.event).replace(/^\/(meme|表情)\s*/, '').trim();
      const [action = 'help', ...parts] = text.split(/\s+/).filter(Boolean);
      const args = parts.join(' ');
      if (action === 'help') { await ctx.reply(HELP); return; }
      const capability = { save: 'save_meme', list: 'search_memes', send: 'send_meme', rename: 'save_meme', disable: 'save_meme', enable: 'save_meme' }[action];
      if (!capability) { await ctx.reply('没有这个表情指令，发 /meme help 看用法。'); return; }
      if (!settings().tools?.[capability]?.enabled) { await ctx.reply('这项表情能力已关闭，可在 Prompt 工具设置中开启。'); return; }
      try {
        if (action === 'save') {
          const name = requireText(args, '用法：/meme save 名称或含义，并附一张表情或引用它。');
          const { asset, duplicate, refreshed } = await collect(ctx, { name, tags: [] });
          const state = asset.missingParameters?.length ? '已暂存，但缺少原样发送所需信息，暂不能使用。' : refreshed ? '已更新这个表情的原生参数。' : duplicate ? '这个表情已经收藏过了。' : '表情收下了。';
          await ctx.reply(`${state}\n${asset.name || name}\nID：${asset.id}`);
          return;
        }
        if (action === 'list') {
          if (args.length > 300) throw new CommandError('关键词请控制在 300 字以内。');
          const items = await search(ctx.sessionKey, args, { limit: 10, includeUnavailable: true });
          await ctx.reply(items.length ? ['当前会话的表情（最多 10 个，可加关键词查找）：', ...items.map((item) =>
            `${item.name || '未命名'}${item.enabled === false ? '〔已停用〕' : item.missingParameters?.length ? '〔信息不完整〕' : ''}\n${item.id}`)].join('\n')
            : '当前会话还没有匹配的表情。引用一张表情，用 /meme save 名称 教本鱼收藏。');
          return;
        }
        if (action === 'send') {
          const query = requireText(args, '用法：/meme send 名称或完整ID');
          let id = query;
          if (!UUID.test(id)) {
            const matches = (await search(ctx.sessionKey, query, { limit: 20 })).filter((item) => item.name === query);
            if (matches.length !== 1) throw new CommandError(matches.length ? '有同名表情，请用 /meme list 查找并复制完整 ID。' : '没找到这个名称的可用表情，请用 /meme list 查找。');
            id = matches[0].id;
          }
          const result = await send(ctx, id);
          if (!result.ok) await ctx.reply('这次表情发送失败了，没有自动重试。稍后可再试。');
          // The actual sticker is the successful response; no redundant success text.
          return;
        }
        if (!canManage(ctx.event)) throw new CommandError('群聊中的修改、停用和恢复只有管理员可以操作。');
        const id = requireId(parts[0] ?? '');
        if (action === 'rename') {
          const name = requireText(parts.slice(1).join(' '), '用法：/meme rename ID 新名称或含义');
          await update(ctx.sessionKey, id, { name });
          await ctx.reply(`表情名称已改为：${name}`);
        } else {
          if (parts.length !== 1) throw new CommandError(`用法：/meme ${action} ID`);
          await update(ctx.sessionKey, id, { enabled: action === 'enable' });
          await ctx.reply(action === 'enable' ? '表情已恢复使用。' : '表情已停用，收藏仍保留。');
        }
      } catch (error) {
        if (error instanceof CommandError) { await ctx.reply(error.message); return; }
        logger.warn('[meme] 表情指令失败', { action, code: error.code ?? 'MEME_COMMAND_FAILED' });
        await ctx.reply(action === 'save' ? '没能收藏：请附一张表情或引用当前会话里的表情，再试一次。原图或表情参数不完整时可能无法保存。'
          : '这次表情操作没有完成，请确认 ID 属于当前会话且表情仍可用。');
      }
    },
  };
}

export default createMemeTrigger();
