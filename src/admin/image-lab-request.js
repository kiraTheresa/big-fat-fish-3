export const maxReferenceBytes = 20 * 1024 * 1024;
export const referenceTypes = ['image/png', 'image/jpeg', 'image/webp'];

const gpt = {
  protocol: 'images',
  maxReferences: 4,
  fields: [
    { name: 'size', label: '输出尺寸', value: '1024x1024', placeholder: '宽x高', suggestions: ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '3840x2160', '2160x3840'] },
    { name: 'quality', label: '质量', value: 'medium', options: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { name: 'transparent', label: '透明背景 PNG', check: true },
  ],
};

export const imageLabModels = {
  'gpt-image-2.5-flare-vip': { label: 'GPT Image 2.5 Flare VIP', ...gpt },
  'gpt-image-2.5-sunburst-vip': { label: 'GPT Image 2.5 Sunburst VIP', ...gpt },
  'grok-imagine-image-2.0': {
    label: 'Grok Imagine 2.0',
    protocol: 'images',
    maxReferences: 3,
    fields: [
      { name: 'resolution', label: '分辨率', options: ['1k', '2k'], generationOnly: true },
      { name: 'aspect_ratio', label: '画幅比例', options: ['1:1', '16:9', '4:3', '3:2', '2:1', '19.5:9', '20:9', '21:9', '5:2', '9:16', '3:4', '2:3', '1:2', '9:19.5', '9:20'] },
      { name: 'quality', label: '质量', options: ['low', 'medium'], generationOnly: true },
      { name: 'n', label: '出图数量（按张计费）', min: 1, max: 10, value: '1', generationOnly: true },
    ],
  },
  'gemini-nano-banana-2.1': {
    label: 'Nano Banana 2.1',
    protocol: 'gemini',
    maxReferences: 14,
    fields: [
      { name: 'imageSize', label: '分辨率', options: ['1K', '2K', '4K'] },
      { name: 'aspectRatio', label: '画幅比例', options: ['1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] },
      { name: 'thinkingLevel', label: '思考级别', options: ['minimal', 'medium', 'high'] },
      { name: 'mimeType', label: '输出格式', options: ['image/png', 'image/jpeg'] },
      { name: 'compressionQuality', label: 'JPEG 压缩质量', min: 0, max: 100, jpegOnly: true },
      { name: 'responseModalities', label: '输出内容', value: 'IMAGE', options: ['IMAGE', 'TEXT + IMAGE'], required: true },
      { name: 'webSearch', label: '网页搜索（按检索计费）', check: true },
      { name: 'imageSearch', label: '图片搜索（按检索计费）', check: true },
    ],
  },
};

export const defaultImageLabModel = 'gpt-image-2.5-flare-vip';

export function imageLabEndpoint(model, operation) {
  return imageLabModels[model].protocol === 'gemini'
    ? `/v1beta/models/${model}:generateContent` : `/v1/images/${operation}`;
}

function gptSize(size) {
  const dimensions = typeof size === 'string' && /^(\d{1,4})x(\d{1,4})$/.exec(size.trim());
  const width = Number(dimensions?.[1]);
  const height = Number(dimensions?.[2]);
  if (!dimensions || width % 16 || height % 16 || Math.max(width, height) > 3840
    || Math.max(width, height) > 3 * Math.min(width, height) || width * height < 655360 || width * height > 8294400) {
    throw new Error('尺寸需为宽x高，边长为 16 的倍数且最多 3840，比例不超过 3:1，总像素为 655360–8294400');
  }
  return `${width}x${height}`;
}

function fieldValues(form, fields, operation) {
  const values = {};
  for (const field of fields) {
    const value = form.get(field.name);
    if (value === null || value === '') continue;
    if (field.generationOnly && operation === 'edits') throw new Error(`${field.label}只用于文生图`);
    if (field.jpegOnly && form.get('mimeType') !== 'image/jpeg') throw new Error('压缩质量只适用于 JPEG');
    if (typeof value !== 'string' || (field.options && !field.options.includes(value)) || (field.check && value !== '1')) {
      throw new Error(`${field.label}的值不受支持`);
    }
    if (field.min !== undefined && (!/^\d+$/.test(value) || Number(value) < field.min || Number(value) > field.max)) {
      throw new Error(`${field.label}需为 ${field.min}–${field.max} 的整数`);
    }
    values[field.name] = field.min === undefined ? value : Number(value);
  }
  return values;
}

function geminiRequest(prompt, values, references) {
  const { imageSize, aspectRatio, mimeType, compressionQuality, thinkingLevel, responseModalities, webSearch, imageSearch } = values;
  const searchTypes = { ...(webSearch && { webSearch: {} }), ...(imageSearch && { imageSearch: {} }) };
  const imageConfig = {
    ...(imageSize && { imageSize }),
    ...(aspectRatio && { aspectRatio }),
    ...(mimeType && { imageOutputOptions: { mimeType, ...(compressionQuality !== undefined && { compressionQuality }) } }),
  };
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }, ...references.map((file) => ({
      inlineData: { mimeType: file.type, data: `[文件 ${file.name}，${file.size} 字节]` },
    }))] }],
    generationConfig: {
      responseModalities: webSearch || imageSearch || responseModalities === 'TEXT + IMAGE' ? ['TEXT', 'IMAGE'] : ['IMAGE'],
      ...(Object.keys(imageConfig).length && { imageConfig }),
      ...(thinkingLevel && { thinkingConfig: { thinkingLevel } }),
    },
    ...(Object.keys(searchTypes).length && { tools: [{ googleSearch: { searchTypes } }] }),
  };
}

export function buildImageLabRequest(form) {
  const model = form.get('model') ?? defaultImageLabModel;
  if (!Object.hasOwn(imageLabModels, model)) throw new Error('请选择已接入的绘图模型');
  const profile = imageLabModels[model];
  const operation = form.get('operation');
  if (operation !== 'generations' && operation !== 'edits') throw new Error('请选择文生图或参考图编辑');
  const prompt = form.get('prompt')?.trim?.();
  if (!prompt || prompt.length > 4000) throw new Error('请输入 1–4000 字的提示词');
  const references = form.getAll('reference').filter((file) => typeof file === 'string' || file.name || file.size);
  if (operation === 'edits' && !references.length) throw new Error('编辑图片需要至少一张参考图');
  if (operation === 'generations' && references.length) throw new Error('文生图模式不能附带参考图');
  const limit = profile.protocol === 'gemini' ? 14 * 1024 * 1024 : maxReferenceBytes;
  if (references.length > profile.maxReferences || references.some((file) => !referenceTypes.includes(file.type) || !file.size)
    || references.reduce((total, file) => total + file.size, 0) > limit) {
    throw new Error(`请选择最多 ${profile.maxReferences} 张 PNG、JPEG 或 WebP，合计不超过 ${limit / 1024 / 1024} MiB`);
  }
  const values = fieldValues(form, profile.fields, operation);
  const endpoint = imageLabEndpoint(model, operation);
  if (profile.protocol === 'gemini') {
    return { model, endpoint, protocol: profile.protocol, references, request: geminiRequest(prompt, values, references) };
  }
  const { transparent, ...parameters } = values;
  if (parameters.size) parameters.size = gptSize(parameters.size);
  const request = { model, prompt, response_format: 'b64_json', ...parameters };
  if (transparent) Object.assign(request, { background: 'transparent', output_format: 'png' });
  return { model, endpoint, protocol: profile.protocol, references, request };
}
