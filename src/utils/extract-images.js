// 共享 util：从 OneBot 消息对象（事件或历史消息）提取可下载的 image 段（识图专用）。
// extractText 的姊妹篇——那边只认 text 段，这边只认 image 段，识图/文字分流互不纠缠。
// data.url 缺失的段跳过（NapCat 个别实现 url 可空，拉不了就不算数）；
// 调用方按「单次一张」边界自行取 [0]。
export function extractImages(msg) {
  if (!Array.isArray(msg.message)) return [];
  return msg.message.filter(
    (seg) => seg?.type === 'image' && typeof seg.data?.url === 'string' && seg.data.url !== ''
  );
}
