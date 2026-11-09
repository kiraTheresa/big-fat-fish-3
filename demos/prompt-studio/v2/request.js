// A local Chat Completions preview, not the live bot's gateway or published configuration.
const specifications = [
  ['memory', 'remember_fact', '按当前用户的明确要求保存事实；成功后才确认。', 'content', '写清事实主体与必要条件'],
  ['memory', 'recall_memory', '读取当前会话已保存的记忆。', null, ''],
  ['memes', 'save_meme', '按当前用户明确的收藏或用途教学请求收藏表情。', 'description', '用户教的名称、情绪或用途'],
  ['memes', 'search_memes', '按主题搜索共享表情库；未指定主题时填全部。', 'query', '主题、情绪，或全部'],
  ['memes', 'send_meme', '只发送本轮搜索返回的一个候选。', 'id', '本轮搜索返回的候选 ID'],
  ['draw', 'draw', '按用户明确要求生成图片。', 'prompt', '完整图片描述'],
];

export function parseHistory(content) {
  let messages;
  try { messages = JSON.parse(content); }
  catch { throw new Error('最近的对话需要是有效 JSON 数组。请保留 role 与 content 字段。'); }
  if (!Array.isArray(messages) || messages.length > 100 || messages.some((m) => !m || !['user', 'assistant'].includes(m.role)
    || typeof m.content !== 'string' || Object.keys(m).some((key) => !['role', 'content'].includes(key)))) {
    throw new Error('历史最多 100 条，每条只包含 role（user / assistant）和字符串 content。');
  }
  return messages.map(({ role, content: text }) => ({ role, content: text }));
}

export function buildRequest(workspace, input) {
  if (typeof workspace.model !== 'string' || !workspace.model.trim()) throw new Error('模型标识不能为空，请回到编辑模式填写。');
  const blocks = workspace.blocks.filter((b) => b.enabled);
  const system = blocks.filter((b) => b.key !== 'history').map((b) => `## ${b.title}\n\n${b.content}`).join('\n\n');
  const history = blocks.filter((b) => b.key === 'history').flatMap((b) => parseHistory(b.content));
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: input }];
  const tools = specifications.filter(([group]) => workspace.tools[group]).map(([, name, description, parameter, parameterDescription]) => ({
    type: 'function', function: { name, description, parameters: {
      type: 'object', properties: parameter ? { [parameter]: { type: 'string', description: parameterDescription } } : {},
      required: parameter ? [parameter] : [], additionalProperties: false,
    } },
  }));
  return { model: workspace.model, messages, ...(tools.length ? { tools } : {}), stream: true, stream_options: { include_usage: true } };
}

export function initialHistory() {
  return JSON.stringify([
    { role: 'user', content: 'Kira：今天事情好多。' },
    { role: 'assistant', content: '忙了一整天吗？' },
    { role: 'user', content: 'Kira：嗯，项目临时加了需求。' },
  ], null, 2);
}
