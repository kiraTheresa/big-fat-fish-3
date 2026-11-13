// Preserve the tariff on each attempt; later price changes must not reprice history.
export const USAGE_PRICING = Object.freeze({
  version: 'deepseek-cny-2026-11-04', currency: 'CNY',
  sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  platformUrl: 'https://platform.deepseek.com/', verifiedAt: '2026-11-04',
  validFrom: Date.parse('2026-11-04T00:00:00+08:00'),
  calendarUntil: Date.parse('2027-01-01T00:00:00+08:00'),
  models: {
    flash: { name: 'deepseek-flash', offPeak: { cacheInputNano: 20, inputNano: 1000, outputNano: 4000 } },
    pro: { name: 'deepseek-v4-pro', offPeak: { cacheInputNano: 150, inputNano: 4500, outputNano: 13500 } },
  },
});
export const IMAGE_PRICING = Object.freeze({
  version: 'laozhang-images-2026-11-13', provider: 'laozhang', currency: 'CNY', unit: 'call',
  verifiedAt: '2026-11-13', validFrom: Date.parse('2026-11-13T00:00:00+08:00'),
  sourceUrl: 'https://docs.laozhang.ai/api-capabilities/image-generation-guide',
  rulesUrl: 'https://docs.laozhang.ai/en/api-capabilities/image-billing-and-failures',
  models: ['gpt-image-2.5-flare-vip', 'gpt-image-2.5-sunburst-vip', 'grok-imagine-image-2.0', 'gemini-nano-banana-2.1'],
  callUsd: 0.03, usdCny: 6.7,
  rates: {
    'gpt-image-2.5-flare-vip': { unit: 'call', usd: 0.03 },
    'gpt-image-2.5-sunburst-vip': { unit: 'call', usd: 0.03 },
    'grok-imagine-image-2.0': { unit: 'image', usd: 0.055 },
    'gemini-nano-banana-2.1': { unit: 'call', usd: 0.045, chargeOn200: true },
  },
});
export const isImageUsage = (kind) => kind === 'draw' || kind === 'image_lab';
const FLASH = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'DeepSeek-V4.1-Flash-1017']);
const PRO = new Set(['deepseek-v4-pro', 'DeepSeek-V4-Pro-0813']);
const tier = (model) => FLASH.has(model) ? 'flash' : PRO.has(model) ? 'pro' : null;
const pending = (reason) => ({ status: 'pending', reason });
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

export function snapshotUsagePrice({ baseUrl, model, kind, time }) {
  let provider;
  try {
    const url = new URL(baseUrl);
    if (!url.username && !url.password && !url.search && !url.hash && ['', '/', '/v1', '/v1/'].includes(url.pathname)) {
      if (url.origin === 'https://api.deepseek.com') provider = 'deepseek';
      if (['https://api.laozhang.ai', 'https://api2.laozhang.ai'].includes(url.origin)) provider = 'laozhang';
    }
  } catch { /* Unknown providers must never inherit the official tariff. */ }
  if (isImageUsage(kind)) {
    if (provider !== 'laozhang' || !IMAGE_PRICING.models.includes(model)) return pending('绘图供应商或模型暂无已核对价目');
    if (!Number.isFinite(time) || time < IMAGE_PRICING.validFrom) return pending('调用早于绘图价目核对日期');
    const { version, currency, usdCny } = IMAGE_PRICING;
    const { unit, usd, chargeOn200 = false } = IMAGE_PRICING.rates[model];
    return { status: 'available', version, provider, currency, unit, model, usdCny, chargeOn200,
      [`${unit}Usd`]: usd, [`${unit}Nano`]: Math.round(usd * usdCny * 1e9) };
  }
  if (provider !== 'deepseek') return pending('非官方 DeepSeek 接口，未配置供应商价目');
  const modelTier = tier(model);
  if (!modelTier) return pending('模型暂无已核对价目');
  if (!Number.isFinite(time) || time < USAGE_PRICING.validFrom) return pending('调用早于当前价目核对日期');
  // shortcut: Nov–Dec 2026 has no Chinese public holidays; extend the verified calendar before 2027.
  if (time >= USAGE_PRICING.calendarUntil) return pending('计费日历待更新，暂不估算费用');
  const local = new Date(time + 8 * 3600000);
  const hour = local.getUTCHours();
  const weekday = local.getUTCDay();
  const peak = weekday >= 1 && weekday <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
  const rates = USAGE_PRICING.models[modelTier].offPeak;
  const factor = peak ? 2 : 1;
  return { status: 'available', version: USAGE_PRICING.version, provider: 'deepseek', currency: 'CNY', modelTier,
    band: peak ? 'peak' : 'off-peak', ...Object.fromEntries(Object.entries(rates).map(([key, value]) => [key, value * factor])) };
}

export function estimateUsageCost(record) {
  const price = record.pricing;
  if (!price) return pending('历史记录缺少供应商与价目快照');
  if (price.status !== 'available') return pending(typeof price.reason === 'string' ? price.reason : '价目不可用');
  if (isImageUsage(record.kind) && price.provider === 'laozhang') {
    const rate = IMAGE_PRICING.rates[price.model];
    const unitNano = price[`${price.unit}Nano`];
    if (price.currency !== 'CNY' || !integer(unitNano) || unitNano === 0
      || price.model !== record.model || !rate || price.unit !== rate.unit
      || !!price.chargeOn200 !== !!rate.chargeOn200) return pending('绘图价目快照无效');
    if (integer(record.httpStatus) && record.httpStatus >= 400 && record.httpStatus <= 599) return { status: 'estimated', costNano: 0 };
    // A complete Images response is required: a timeout or truncated body can still be billed upstream.
    if (record.httpStatus !== 200 || record.imageResponseComplete !== true || !integer(record.images)) return pending('绘图结果未完整返回，扣费待确认');
    if (record.imageSearch) return pending('已启用搜索，检索次数与附加费用待供应商账单确认');
    const costNano = unitNano * (price.unit === 'image' ? record.images : price.chargeOn200 || record.images > 0 ? 1 : 0);
    return integer(costNano) ? { status: 'estimated', costNano } : pending('费用超出可精确统计范围');
  }
  if (isImageUsage(record.kind) || price.currency !== 'CNY' || price.provider !== 'deepseek'
    || !['cacheInputNano', 'inputNano', 'outputNano'].every(key => integer(price[key]))) return pending('价目快照无效');
  if (record.responseModel && tier(record.responseModel) !== price.modelTier) return pending('返回模型与请求模型价目不匹配');
  const input = record.prompt_tokens;
  const output = record.completion_tokens;
  const hit = record.prompt_cache_hit_tokens;
  if (record.usageKnown === false || !integer(input) || !integer(output) || !integer(hit)) return pending('用量或缓存拆分未完整返回');
  if (hit > input || (record.prompt_cache_miss_tokens != null && record.prompt_cache_miss_tokens !== input - hit)
    || (record.total_tokens != null && record.total_tokens !== input + output)) return pending('上游用量拆分不一致');
  const costNano = hit * price.cacheInputNano + (input - hit) * price.inputNano + output * price.outputNano;
  if (!integer(costNano)) return pending('费用超出可精确统计范围');
  return { status: 'estimated', costNano };
}
