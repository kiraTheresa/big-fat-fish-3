// Shared by the terminal and management UI; never include request or tool payloads.
const stages = {
  'handler.started': '触发器命中', 'handler.finished': '处理器返回', 'handler.match_failed': 'match 异常', 'handler.skipped': '跳过处理',
  'chat.matched': 'chat 命中', 'chat.not_matched': 'chat 未命中', 'chat.skipped': 'chat 跳过',
  'chat.response.ready': '回复已生成', 'chat.response.failed': '回复生成失败', 'chat.fallback.queued': '兜底回复入队', 'chat.vision.degraded': '识图降级为纯文本',
  'model.request.started': '模型请求开始', 'model.request.finished': '模型请求结束', 'model.request.rejected': '模型准入拒绝',
  'model.tools.offered': 'tools 已提供', 'model.response.received': '模型返回',
  'tool.started': '工具调用开始', 'tool.finished': '工具调用结束',
  'reply.queued': '回复入队', 'reply.started': '回复发送开始', 'reply.finished': '回复发送结果',
  'distill.started': '记忆提炼开始', 'distill.finished': '记忆提炼结束',
  'admin.settings.updated': '配置已保存', 'admin.user.updated': '用户权限已修改', 'admin.user.reset': '用户权限已恢复默认',
};
const reasons = {
  private: '私聊', at: '@机器人', nameCall: '名字呼唤', replyQuote: '引用机器人消息',
  no_group_condition: '未满足已启用的群聊触发条件', no_api_key: '未配置模型密钥', not_message: '非聊天消息',
  no_trigger: '没有触发器命中', permission_denied: '权限拒绝', cooldown: '冷却中', empty_content: '内容为空',
  group_at_required: '群聊指令未 @ 机器人',
  FEATURE_DISABLED: '能力已停用', USAGE_LIMIT: '达到调用预算', USAGE_STORAGE: '用量存储异常',
  timeout: '请求超时', upstream_busy: '上游繁忙', upstream_error: '上游错误', rate_limited: '请求限流',
  request_rejected: '请求被拒绝', request_failed: '请求失败', generation_failed: '生成失败',
  ONEBOT_TIMEOUT: '平台确认超时', ONEBOT_NOT_CONNECTED: 'QQ 未连接', ONEBOT_REJECTED: '平台拒绝发送',
  ONEBOT_INVALID_RESPONSE: '平台确认无效', backoff: '连续失败退避中', invalid_patch: '补丁格式无效，水位未推进',
  locked_content_missing: '补丁丢失锁定条目，未应用', patch_not_written: '补丁未落盘，水位未推进',
  partial_patch: '补丁部分落盘，水位仍推进', image_download_failed: '图片下载失败', vision_request_failed: '带图请求失败',
};
const outcomes = {
  success: '成功', failed: '失败', failure: '失败', unknown: '结果未知', interrupted: '已中断', partial: '部分完成', degraded: '已降级',
  confirmed: '平台已确认', completed: '已返回', skipped: '跳过', rejected: '拒绝', generated: '已生成', fallback: '兜底', queued: '已入队',
  tools: '选择工具', text: '未选择工具，返回文本', empty: '未返回文本或工具',
};

export function isLogFailure(entry) {
  if (entry.event) {
    if (entry.outcome === 'skipped') return false;
    if (['model.request.rejected', 'chat.response.failed'].includes(entry.event) && ['FEATURE_DISABLED', 'USAGE_LIMIT'].includes(entry.reason)) return false;
    if (['failed', 'failure', 'unknown', 'interrupted', 'partial', 'degraded', 'rejected'].includes(entry.outcome) || entry.data?.ledgerSaved === false) return true;
  }
  // Historical plain-text warnings cannot be classified more precisely.
  return ['WARN', 'ERROR'].includes(entry.level);
}

export function describeLog(entry) {
  const data = entry.data ?? {};
  return {
    title: entry.event === 'handler.finished' && entry.outcome === 'failed' ? '处理异常' : stages[entry.event] ?? entry.message ?? entry.event ?? '运行记录',
    result: outcomes[entry.outcome] ?? entry.outcome ?? (entry.event ? '' : entry.level),
    detail: [data.trigger, data.name, data.kind, data.model, (Array.isArray(data.names) ? data.names.join(', ') : '') || (entry.event === 'model.tools.offered' ? '无' : ''),
      entry.reason ? reasons[entry.reason] ?? entry.reason : '', data.error,
      data.reused ? '复用已有结果，未重新执行' : '', data.toolChoice === 'none' ? '本轮禁止工具调用' : '',
      data.httpStatus ? `HTTP ${data.httpStatus}` : '', data.ledgerSaved === false ? '用量账本写入失败' : '',
      data.retryInMinutes === undefined ? '' : `约 ${data.retryInMinutes} 分钟后重试`,
      data.characterWritten === false ? 'character.md 未写入' : '', data.memoryWritten === false ? 'memory.md 未写入' : '',
    ].filter(Boolean).join(' · '),
  };
}
