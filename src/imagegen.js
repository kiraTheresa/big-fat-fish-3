// 图像生成客户端（横切组件）：OpenAI Images 协议 /images/generations——全项目唯一绘图出口，
// 与 llm.js 平级（「唯一 LLM 出口」纪律的图像版）。上游可切换（老张中转 / 火山方舟 /
// 任意兼容源）：base_url、key、model、size 全走 config，换上游代码零改动。
// 零新增依赖：Node ≥22 全局 fetch；超时 AbortSignal.timeout；任何失败（网络/超时/非 2xx/
// 响应形状异常）一律 reject，兜底策略由调用方（draw 触发器）决定。
// 响应兼容两种主流形态（上游家族差异，对上层归一为 { b64 } 单一形状）：
//   - data[0].b64_json：GPT Image 家族（老张实测即此形态），直取；
//   - data[0].url：Seedream 家族等返回外链，现下载转 base64（「不落盘、用时现拉」——
//     与看图链路的哲学对称，bot 侧不存任何图片文件）。
import { config } from './config.js';

export async function generateImage(prompt) {
  const res = await fetch(`${config.imageApiBaseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.imageApiKey}`,
    },
    body: JSON.stringify({ model: config.imageModel, prompt, size: config.imageSize }),
    signal: AbortSignal.timeout(config.imageTimeoutMs),
  });
  if (!res.ok) throw new Error(`Image API HTTP ${res.status}`);

  const data = await res.json();
  const item = data.data?.[0];
  if (item?.b64_json !== undefined) return { b64: item.b64_json };
  if (item?.url) {
    // url 形态：现下载转 base64（下载 60s 上限，超时 reject 走调用方兜底）
    const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    if (!imgRes.ok) throw new Error(`图片下载失败 HTTP ${imgRes.status}`);
    return { b64: Buffer.from(await imgRes.arrayBuffer()).toString('base64') };
  }
  throw new Error('Image API 响应缺少 data[0].b64_json/url');
}
