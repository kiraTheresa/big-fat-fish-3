# 日志、请求与排障

[← 文档目录](README.md)

## 从哪里开始

1. 收不到回复：先看总览的连接、心跳与发送积压，再到运行日志选择会话并切换“全部日志”，检查是否命中、被冷却或策略跳过。
2. 模型慢或报错：到“请求与稳定性”选择日期、用途和来源，从失败原因或调用详情进入本轮链路。
3. 模型成功但没有收到消息：查看 `reply.finished` 的平台确认结果，不能用处理器返回或模型成功代替发送确认。
4. 费用或 token 数值有疑问：看 [用量专题](usage-monitoring.md)，不要用请求失败率倒推扣费。

## 业务事件与链路查询

业务事件统一通过 `logger.event(event, fields)` 写入现有 `data/logs/YYYY-MM-DD.jsonl`。旧的 `logger.info/warn/error/debug` 和旧日志读取继续兼容，不迁移或补写历史记录。

- 公共字段：`schemaVersion`、`id`、`time`、`level`、`event`、`message`。
- 关联字段：`traceId` 标识一次业务处理，`operationId` 标识某次模型调用、工具执行或发送。模型操作 ID 与用量账本 ID 相同；入站事件、消息记录和线上 Prompt run 保存关联的 traceId。
- 业务字段：`sessionKey`、`source`（`live` / `test` / `scheduled` / `admin` / `system`）、`outcome`、`reason`、`elapsedMs`，扩展元数据放在 `data`。
- 业务事件和普通 WARN/ERROR 固定落盘，不受终端 `LOG_LEVEL` / `LOG_SESSION` 过滤；普通 INFO/DEBUG 诊断仍受级别控制。沿用日志保留策略、脱敏、串行写入与写入故障状态。写盘失败不会自动补发消息或重跑模型；业务日志不是可靠消息队列或账本事务。
- 不记录完整请求、工具参数、回复正文或图片。敏感键脱敏，扩展数据超过 16 KiB 时省略。用量、协议原文和 Prompt 调试详情仍由原存储负责。

关键事件包括 `handler.started/finished/skipped/match_failed`、`chat.matched/not_matched/skipped`、`chat.response.ready/failed`、`chat.vision.degraded`、`chat.fallback.queued`、`model.request.started/finished/rejected`、`model.tools.offered`、`model.response.received`、`tool.started/finished`、`reply.queued/started/finished`、`distill.started/finished` 及成功的管理操作。chat 命中原因记录私聊、@、名字呼唤或引用；群聊按既有顺序短路，只记录首个命中条件。工具已提供、模型选择工具与工具实际结果分别记录；复用结果不代表再次执行。

终端默认 `LOG_LEVEL=INFO`，显示命中、命中后跳过、模型请求、工具选择/结果和平台发送确认，不刷入站消息、心跳与元数据 JSON。`DEBUG` 额外显示未命中、处理器返回和发送队列细节；可配合 `LOG_SESSION=g-123` 限定终端会话，其他会话的失败仍按级别显示，完整链路继续落盘。例如 `LOG_LEVEL=DEBUG LOG_SESSION=g-123 npm start`。终端时间使用北京时间。

前端撤掉消息收件箱导航与概览消息流，原协议事件存储、`GET /api/events` 和旧 `#events` 地址继续保留。运行日志默认“仅看失败”，也可切换“全部日志”查看已落盘的 DEBUG/INFO/WARN/ERROR；重置筛选会恢复仅看失败。概览始终聚焦最近失败。失败记录以阶段为单位展示，不代表失败消息数：失败、未知、降级、部分完成及用量账本写入失败均可出现；正常跳过、能力停用和预算拒绝不计入。历史纯文字 WARN/ERROR 无法精确分类，仍保留展示。日志详情可按 traceId 查看包括成功步骤在内的整轮链路；无 ID 的旧记录不推测关联。

发送队列保存每条消息的关联字段，出队时使用原字段，避免多个会话并发时串线。`reply.finished.outcome=confirmed` 仅表示 OneBot 返回成功和有效消息 ID，不代表用户已读；明确拒绝或未连接记 `failed`，超时、中止或无有效消息 ID 记 `unknown`，均不自动重发。`data.waitMs` 为队列等待时间，发送事件的 `elapsedMs` 包含排队时间。

`handler.finished.outcome=completed` 只表示处理器返回，不能当作最终回复成功；模型失败后可能发送兜底，一轮也可能产生多个工具或发送。当前不额外计算整轮回复成功率。模型事件耗时沿用用量账本口径，包括准入预留后的准备和网关处理，不是纯上游推理时间。绘图、表情与用量报告发送也沿用同一发送通道。

鉴权后的 `GET /api/logs` 支持精确筛选：`traceId`、`operationId`、`event`、`sessionKey`、`source`、`outcome`；支持 `failuresOnly=true`（按业务结果筛选失败，分页前过滤，默认 false）、`since` / `until`（日期时间字符串，含边界；直接调用读取函数也可传数值毫秒时间戳），可与 `level`、`q`、`limit`、`before` 游标组合。关键词匹配文案、阶段、原因、工具/模型名、会话和链路 ID。示例：

```text
/api/logs?traceId=<本轮ID>&limit=100
/api/logs?failuresOnly=true&sessionKey=g-123
/api/logs?event=model.request.finished&outcome=failed&source=live
/api/logs?event=reply.finished&outcome=unknown
```

查询结果按追加顺序从新到旧分页，沿用原有 `cursor` / `nextCursor`。看完整链路需继续获取后续页，并按时间/追加顺序阅读。日志文件按 UTC 日期分割，HTTP 查询时间应使用带时区的日期时间字符串。历史中断仅能依据已有记录和用量预留识别，不能把缺少终结事件视为成功。

## 请求与稳定性

管理台 `#requests` 使用只读接口 `GET /api/requests/dashboard`；与其他管理接口相同，需要管理令牌，不触发模型、工具或 QQ 发送。统计沿用本地用量账本，链路详情读取已脱敏的统一业务日志。

- 全页范围：今天、昨天、近 7 天、近 30 天及最多 31 天的自定义日期；按用途、来源和会话筛选。日期使用北京时间，范围左闭右开。
- 摘要：API 请求数、自然分钟请求峰值和平均频率、已知结果失败率、成功请求 P95。汇总始终覆盖全部匹配记录，不受明细分页或异常筛选影响。
- 结果完整性：明确成功 / 失败以外的历史记录和进程中断列为未知，不计入已知结果失败率的分母。P95 使用有耗时记录的成功请求，显示样本量与缺失量，不把缺失当作零。
- 在途峰值：以已完成请求的开始时间与耗时重建本机重叠区间，包含跨入所选范围的调用；排除中断及缺失耗时。它不是账号实时并发，也不能证明上游实际仍在执行。耗时沿用网关口径，可能含准备、下载、落盘等处理。
- 下钻：点击用途或会话改变全页范围；点击柱形时段、失败原因或“仅看异常”只筛选明细。下钻固定统计快照，避免汇总跳动；清除筛选或手动刷新可读取最新数据。查看更早记录时固定统计截止时间并沿游标翻页。新账本记录 `finishedAt`，稍后才完成入账的请求不会改变旧截止点的汇总；旧记录用开始时间加耗时估算完成时间，两者均缺失时只能依据已有开始时间。
- 调用详情仅返回用途、来源、模型、耗时、结果和脱敏后的失败说明。有 `traceId` 时可查询并分页浏览本轮业务日志；历史未记录 ID 或已清理的日志不推测补齐。处理器返回和平台确认不代表用户已读，不据此生成整轮回复成功率。
- 尚未结束的请求未写入完成账本，不计入此页。准入拒绝没有发出 API 请求，可在业务日志中查看，但不计入请求量。账本损坏或读取失败显示错误，不能当作零请求。

接口参数：`period=today|yesterday|7d|30d|custom`、`since` / `until`（自定义）、`kind=chat|vision|distill|draw`、`source=live|test|scheduled|admin|system|unknown`、`sessionKey`。明细支持 `reason`、`failedOnly=true`、`detailSince` / `detailUntil`、`limit`（最多 200）和返回的 `before` 游标；可通过 `asOf` 固定下钻快照。`unknown` 来源表示未记录来源。返回 `totals`、`byTime`、`byKind`、`bySession`、`bySource`、`errors`、`items`、`matchingItems`、`nextCursor` 和 `range`。

本地验证可运行 `node --test test/requests.test.js test/console.test.js test/usage-dashboard.test.js`；可选的 `node scripts/check-request-console.mjs` 使用临时账本和本地管理服务检查筛选、明细、链路、错误恢复与窄屏布局。需已安装 Chromium，也可指定 `CHROME_EXECUTABLE`；可用 `SCREENSHOT_DIR` 保存检查截图。脚本不连接真实 QQ 或模型。

## 记忆提炼失败与退避

日志中的“连续失败退避中”（DEBUG）表示后台记忆提炼连续失败后暂缓调用模型，满一小时后自动恢复尝试，不会阻止普通聊天或表情工具。常见原因包括模型出错、补丁格式不正确或改动了锁定记忆；应查看退避前的失败记录。两个记忆文件的 `- [` 锁定行都必须原样保留，旧发布模板也会追加这一固定约束；容量压缩仅针对非锁定内容，校验失败时不覆盖原文件。

## 开发入口

日志写入与筛选在 `src/utils/logger.js`，终端和网页共用的文案与失败分类在 `src/utils/log-format.js`；请求统计在 `src/usage/requests.js`，页面在 `web/request-view.js` 与 `web/app.js`。日志相关改动可定向选择 `test/logger.test.js`、`test/structured-logger.test.js`、`test/business-trace.test.js`；请求页面检查见上节。
