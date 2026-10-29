# 图片与表情包文件存储

所有媒体位于 `DATA_DIR/media`，默认是项目下的 `data/media`。启动时自动创建两个目录，现有 Docker Compose 的 `./data:/app/data` 已覆盖它们，不需要额外挂载。数据目录已被 Git 和 Docker 构建上下文忽略。

```text
data/media/
├── generated/                 # 绘图原图，按 UTC 日期分目录
│   └── 2026-10-29/
│       └── <UUID>/
│           ├── image.png      # 扩展名按原始文件头识别
│           └── metadata.json
└── memes/                     # 表情包库
    └── <UUID>/
        ├── image.gif
        └── metadata.json
```

## 绘图自动归档

`generateImage()` 在返回图片前保存原始字节，覆盖 `/draw`、聊天绘图工具和 Prompt 控制台真实绘图。当前调用链使用上游 `data[0]` 的一张图片；Base64 和 URL 下载两种返回形式都会保存。模拟绘图不产生文件。原有 Prompt 测试图片仍用于控制台预览。

元数据包含版本、UUID、UTC 时间、文件名、MIME、字节数、SHA-256，以及提示词、会话、模型和请求尺寸。尺寸是请求参数，不是测量出的像素大小。文件路径只由内部 UUID 和日期生成，提示词与会话不参与路径拼接。不保存 API 密钥和上游临时下载 URL。

返回值为 `{ b64, asset }`，`asset.path` 相对于 `DATA_DIR/media`。保存失败会记录警告，并返回 `asset: null`；已生成的图片仍正常进入发送流程，不因磁盘错误重新调用付费绘图。未知图片格式按 `.bin` 保存原始内容，便于检查。

上线前已经发到 QQ 的图片没有自动归档，无法从聊天记录里的文字占位还原；这次也不迁移控制台旧测试图片。

## 表情包存储接口

`src/store/media-store.js` 提供 `saveMemeImage(buffer, { name, tags })`，接收原始图片 Buffer，支持按文件头识别 PNG、JPEG、GIF、WebP，不转码、不压缩，保留 GIF 原始动画数据。格式识别不等于完整图片解码校验。名称和标签只写元数据，不作为文件名。

```js
import { readFile } from 'node:fs/promises';
import { saveMemeImage } from './src/store/media-store.js';

const asset = await saveMemeImage(await readFile('/path/to/开心.gif'), {
  name: '开心', tags: ['开心', '肥鱼'],
});
console.log(asset.path);
```

示例从项目根目录以 Node ESM 运行；自定义 `DATA_DIR` 时使用与 Bot 相同的环境。也可以先将已有素材手动放到 `memes/` 暂存，但目前不会自动扫描、生成元数据或发送。此阶段只提供文件基础，尚无导入指令、管理页面、搜索或自动选表情能力；生成图片也不会自动加入表情包库。

## 保留与备份

媒体不受日志/事件的 `RETENTION_DAYS` 清理影响，暂时长期保留，没有自动去重或容量淘汰。同一内容保存多次会分配不同 UUID。备份整个 `data/media` 即可同时保留原图和元数据，移动后相对引用仍有效。提示词与会话信息属于本地数据，备份时一并保管。

每份资产先在隐藏临时目录写入图片和元数据，文件 fsync 后再重命名目录发布；普通写入失败会清理该临时目录。强制断电/终止可能留下 `.<UUID>.tmp`，不应视为完整资产；停机后确认无写入可手动清理。不改写或自动删除已有媒体。

修改源码后需重启本地 Bot；Docker 部署需重新构建并启动容器后，自动归档才会生效。
