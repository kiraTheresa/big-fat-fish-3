import { config } from '../config.js';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeImageBase64, requestImage } from '../imagegen.js';
import { imageFormat, saveGeneratedImage } from '../store/media-store.js';
import { atomicWriteJson, readJson } from '../platform/persistence.js';
import { logger, redactText } from '../utils/logger.js';
import { buildImageLabRequest, defaultImageLabModel, imageLabModels, referenceTypes } from './image-lab-request.js';

function unavailableReason() {
  if (!config.imageApiKey || !/^https:\/\/api2?\.laozhang\.ai\/v1\/?$/.test(config.imageApiBaseUrl)) {
    return '需要在后端配置老张绘图 API 地址和密钥';
  }
  if (process.env.NODE_USE_ENV_PROXY === '1' || [process.env.NODE_OPTIONS, ...process.execArgv].some((value) => value?.includes('--use-env-proxy'))) {
    return '生图台需要直连老张。请关闭 Node 的环境代理后重启 Bot';
  }
  return '';
}

function outputImage(item) {
  if (typeof item?.b64_json === 'string' && item.b64_json) {
    const b64 = normalizeImageBase64(item.b64_json);
    const [, mimeType] = imageFormat(Buffer.from(b64.slice(0, 16), 'base64'));
    if (referenceTypes.includes(mimeType)) return { mimeType, b64 };
  }
  return null;
}

const taskIdPattern = /^\d{13}-[0-9a-f-]{36}$/;

export function createImageLab() {
  const directory = join(config.dataDir, 'management', 'image-tasks');
  const fileFor = (id) => join(directory, `${id}.json`);
  const save = (task) => atomicWriteJson(fileFor(task.id), task);
  let queue = Promise.resolve();
  let pending = 0;
  let closing = false;

  async function taskIds() {
    const files = await readdir(directory).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    return files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5))
      .filter((id) => taskIdPattern.test(id)).sort().reverse();
  }

  async function read(id) {
    const task = taskIdPattern.test(id) && await readJson(fileFor(id), null);
    if (!task) throw Object.assign(new Error('绘图任务不存在'), { status: 404 });
    return task;
  }

  async function execute(task, references, protocol) {
    if (closing) {
      await save({ ...task, status: 'interrupted', finishedAt: Date.now(), error: '服务已停止，任务未提交给绘图 API。' });
      return;
    }
    task.status = 'running';
    task.startedAt = Date.now();
    await save(task);
    const { model, endpoint } = task;
    const request = structuredClone(task.request);
    if (protocol === 'gemini') {
      const { parts } = request.contents[0];
      for (const [index, file] of references.entries()) {
        parts[index + 1].inlineData.data = Buffer.from(await file.arrayBuffer()).toString('base64');
      }
    }
    try {
      const { items, ...result } = await requestImage(request, {
        references: protocol === 'images' ? references : [], sessionKey: 'system',
        logContext: { source: 'admin' }, timeoutMs: 300000, lab: { model, endpoint, protocol },
      });
      Object.assign(task, result);
      let unavailable = 0;
      for (const item of items) {
        if (!item?.b64_json && !item?.url) continue;
        const image = outputImage(item);
        if (!image) { unavailable++; continue; }
        try {
          const asset = await saveGeneratedImage(image.b64, {
            prompt: task.parameters.prompt, sessionKey: 'system', model, taskId: task.id,
            size: request.size ?? request.resolution ?? request.generationConfig?.imageConfig?.imageSize,
          });
          task.images.push({ key: asset.path.slice(0, -(asset.filename.length + 1)), mimeType: asset.mimeType, filename: asset.filename });
        } catch (err) {
          unavailable++;
          logger.warn('[image-lab] 作品保存失败', { code: err.code ?? 'MEDIA_SAVE_FAILED' });
        }
        await save(task);
      }
      task.status = task.images.length ? 'completed' : 'failed';
      if (unavailable) task.error = `${unavailable} 张结果没有可归档的图片，或写入失败。请先查看上游调用记录。`;
    } catch (err) {
      task.status = 'failed';
      task.error = redactText(err.message);
    }
    task.finishedAt = Date.now();
    await save(task);
  }

  return {
    settings() {
      const reason = unavailableReason();
      return { model: defaultImageLabModel, available: !reason, reason };
    },
    async recover() {
      for (const id of await taskIds()) {
        const task = await read(id);
        if (task.status !== 'queued' && task.status !== 'running') continue;
        await save({ ...task, status: 'interrupted', finishedAt: Date.now(), error: '服务已重启。请核对上游调用记录后再提交。' });
      }
    },
    async list({ before, limit = 20 } = {}) {
      const ids = (await taskIds()).filter((id) => !before || id < before);
      const page = ids.slice(0, Math.min(limit, 50));
      return {
        items: await Promise.all(page.map(async (id) => {
          const { parameters, request, references, usage, text, ...summary } = await read(id);
          return { ...summary, prompt: parameters.prompt.slice(0, 160) };
        })),
        nextCursor: ids.length > page.length ? page.at(-1) : null,
      };
    },
    read,
    async submit(form) {
      const reason = unavailableReason();
      if (reason || closing) throw Object.assign(new Error(reason || '服务正在停止'), { status: 503 });
      const { request, references, model, endpoint, protocol } = buildImageLabRequest(form);
      for (const file of references) {
        const [, mime] = imageFormat(Buffer.from(await file.slice(0, 12).arrayBuffer()));
        if (mime !== file.type) throw new Error('参考图内容与文件格式不符');
      }
      if (closing || pending >= 5) throw Object.assign(new Error('任务队列已满或服务正在停止，请稍后提交'), { status: 503 });
      const createdAt = Date.now();
      const parameters = { model, operation: form.get('operation'), prompt: request.prompt ?? request.contents[0].parts[0].text };
      for (const { name } of imageLabModels[model].fields) {
        const value = form.get(name);
        if (typeof value === 'string') parameters[name] = value;
      }
      const task = {
        id: `${createdAt}-${randomUUID()}`, status: 'queued', createdAt, model, endpoint, request, parameters,
        references: references.map(({ name, type, size }) => ({ name, type, size })), images: [],
      };
      pending++;
      try { await save(task); }
      catch (err) { pending--; throw err; }
      queue = queue.then(() => execute(task, references, protocol)).catch((err) => {
        logger.warn('[image-lab] 无法写入任务状态', { code: err.code ?? 'TASK_SAVE_FAILED' });
      }).finally(() => { pending--; });
      return { id: task.id, status: 'queued' };
    },
    async close() {
      closing = true;
      await queue;
    },
  };
}
