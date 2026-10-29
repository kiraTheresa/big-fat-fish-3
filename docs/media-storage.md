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
        ├── metadata.json     # 必须：类型、发送参数、名称、标签与来源
        ├── image.gif         # 可选：原始文件
        └── preview.png       # 可选：预览，不作为原图发送
```

## 绘图自动归档

`generateImage()` 在返回图片前保存原始字节，覆盖 `/draw`、聊天绘图工具和 Prompt 控制台真实绘图。当前调用链使用上游 `data[0]` 的一张图片；Base64 和 URL 下载两种返回形式都会保存。模拟绘图不产生文件。原有 Prompt 测试图片仍用于控制台预览。

元数据包含版本、UUID、UTC 时间、文件名、MIME、字节数、SHA-256，以及提示词、会话、模型和请求尺寸。尺寸是请求参数，不是测量出的像素大小。文件路径只由内部 UUID 和日期生成，提示词与会话不参与路径拼接。不保存 API 密钥和上游临时下载 URL。

返回值为 `{ b64, asset }`，`asset.path` 相对于 `DATA_DIR/media`。保存失败会记录警告，并返回 `asset: null`；已生成的图片仍正常进入发送流程，不因磁盘错误重新调用付费绘图。未知图片格式按 `.bin` 保存原始内容，便于检查。

上线前已经发到 QQ 的图片没有自动归档，无法从聊天记录里的文字占位还原；这次也不迁移控制台旧测试图片。

## 表情包存储接口

`src/store/media-store.js` 提供统一接口：

```js
saveMeme({ type, data = {}, image = null, preview = null, name = '', tags = [], source = null })
readMeme(id)
```

`type` 明确指定 `image`（自定义图片表情）、`mface`（商城表情）或 `face`（内置表情）。`data` 是未来构建该类型 OneBot 消息段时需要的参数，按 JSON 原样保存，包括扩展字段和数值/字符串类型；存储层不把收到的 `image` 自动推断为商城表情，不解析或执行其中的 URL、文件路径及原始数据。调用方应先识别类型，再传入对应参数。

`image` 和 `preview` 都是可选 Buffer，可以同时为空。二者只支持按文件头识别的 PNG、JPEG、GIF、WebP，不转码、不压缩，保留原始动画字节；格式识别不等于完整图片解码校验。即使商城表情附有图片，未来仍应使用 `mface` 参数发送，不应改为图片段。`preview` 只供预览，不能用于替代原图判断参数是否完整。

新表情元数据版本为 `2`：

| 字段 | 含义 |
| --- | --- |
| `memeType` | `image`、`mface` 或 `face` |
| `send` | `{ type, data }`，保存的消息类型与原始发送参数 |
| `name`、`tags` | 名称和去重后的标签，不参与文件路径 |
| `source` | 可选 JSON 对象，如原消息 ID、会话、接收段类型；默认 `null` |
| `filename`、`mimeType`、`bytes`、`sha256` | 原图描述；无原图时分别为 `null`、`null`、`0`、`null` |
| `preview` | 可选预览文件描述，默认 `null` |
| `missingParameters` | 缺失的基本发送参数列表；保存和读取时计算 |

此外保留 UUID、创建时间和 `kind: 'memes'`。返回值的 `path` 是相对 `DATA_DIR/media` 的原图路径，无原图为 `null`；有预览时返回 `preview.path`。这些路径在读取时计算，不依赖旧主机绝对路径。

基本参数检查规则：`image` 需要本地原图或非空 `data.file`；`mface` 检查 `emoji_id`、`emoji_package_id`、`key`；`face` 检查 `id`。缺失时仍允许保存，例如只有缩略图的素材会记录 `missingParameters: ['file']`。这只是保守的字段完整性检查，**空列表不代表已经验证可发送或能恢复原有动画效果**：远程链接可能过期，原生参数可能失效，QQ/NapCat 版本支持也尚未实测。图片的 `sub_type`、`summary` 由调用方提供并原样保存，不猜测或补造表情属性。

保存本地动画及发送属性：

```js
import { readFile } from 'node:fs/promises';
import { saveMemeImage } from './src/store/media-store.js';

const asset = await saveMemeImage(await readFile('/path/to/开心.gif'), {
  name: '开心', tags: ['开心', '肥鱼'],
  data: { sub_type: 1, summary: '[动画表情]' }, // 传入来源提供的实际属性
});
console.log(asset.path);
```

保存只有原生引用的商城表情（不下载图片）：

```js
import { saveMeme, readMeme } from './src/store/media-store.js';

const asset = await saveMeme({
  type: 'mface', name: '开心', tags: ['开心'],
  data: { emoji_id: '实际表情ID', emoji_package_id: '实际表情包ID', key: '实际key', summary: '[开心]' },
  source: { messageId: '原消息ID', sessionKey: 'g-123', segmentType: 'image' },
});
const stored = await readMeme(asset.id); // stored.send 保留原参数，stored.path 为 null
```

旧接口 `saveMemeImage(buffer, { name, tags, data, source })` 保留，是 `type: 'image'` 的快捷入口；仍要求非空原图。`readMeme(id)` 只接受 UUID，记录不存在返回 `null`，元数据损坏、版本不支持或已声明的文件缺失时抛错。读取旧 v1 图片记录时补出 `send: { type: 'image', data: {} }` 供调用方使用，保留 `version: 1`，不会补造旧记录里没有的表情属性，也不改写旧文件。

示例从项目根目录以 Node ESM 运行；自定义 `DATA_DIR` 时使用与 Bot 相同的环境。存储接口只写入、读取本地文件，不请求网络、不调用 OneBot。手动放入 `memes/` 的散文件不会自动扫描或生成元数据。此阶段尚无自动收集、发送、导入指令、管理页面、搜索或自动选表情能力；生成图片也不会自动加入表情包库。

## 保留与备份

媒体不受日志/事件的 `RETENTION_DAYS` 清理影响，暂时长期保留，没有自动去重或容量淘汰。同一内容保存多次会分配不同 UUID。备份整个 `data/media` 即可同时保留原图和元数据，移动后本地图片相对引用仍有效。提示词、会话信息、商城表情 key 及调用方传入的链接属于本地数据，备份时一并保管；表情参数不会写入日志。相对路径不保证 `send.data` 中外部链接或外部文件路径永久可用。

每份资产先在隐藏临时目录写入图片和元数据，文件 fsync 后再重命名目录发布；普通写入失败会清理该临时目录。强制断电/终止可能留下 `.<UUID>.tmp`，不应视为完整资产；停机后确认无写入可手动清理。不改写或自动删除已有媒体。

修改源码后需重启本地 Bot；Docker 部署需重新构建并启动容器后，自动归档才会生效。
