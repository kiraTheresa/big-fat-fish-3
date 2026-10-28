# OneBot 11 接收边界

本项目通过 NapCat 的 OneBot 11 正向 WebSocket 接收 QQ 消息。这里的“全类型”指这个现有协议接入面，不代表 QQ 官方开放平台机器人 API、OneBot 12 或每个客户端内部事件。

## 接收与处理分开

连接层接收合法 JSON 对象；匹配 `echo` 的 API 响应继续走调用回调，带非空 `post_type` 的事件交给分发层。分发层先把完整原始事件及归一化元数据放进独立事件收件箱，再决定是否进入原有触发器。

- `message`：群聊和私聊。私聊包含好友、群临时会话和其他子类型；群聊包含普通、匿名和系统提示。
- `notice`：群文件上传、管理员变动、成员增减、禁言、好友添加、群/好友撤回，以及 `notify` 的戳一戳、红包运气王、荣誉变化。
- `request`：好友申请、加群申请和邀请。只收件，不批准或拒绝。
- `meta_event`：生命周期和周期心跳。心跳同时更新连接健康快照。
- `message_sent`：NapCat 等实现的已发送消息扩展，只收件，避免自我回复和重复 bot 历史。
- 其他实现扩展：不靠枚举丢弃，原样保留，默认只收件。

标准定义的 20 种段类型全部可接收：`text`、`face`、`image`、`record`、`video`、`at`、`rps`、`dice`、`shake`、`poke`、`anonymous`、`share`、`contact`、`location`、`music`、`reply`、`forward`、`node`、`xml`、`json`。标准中部分段只标记为发送用途，本项目依然保留实现可能上报的这些段。`file`、`mface` 等非标准扩展也保留；不下载媒体，不展开转发、不执行 XML/JSON 内容。

除戳一戳外，原有业务只处理由 `text`、`at`、`reply`、`image` 组成的消息；任意新增段出现时，整条消息目前仅进入收件箱，混合文本也不会触发回复。群系统提示仅收件。新类型不进入 LLM 会话历史，避免在后续聊天中被隐式处理。纯文本、已有识图、绘图、指令及引用处理保持原有触发器边界。

发给机器人的 `notice/notify/poke` 通知可进入戳一戳触发器；必须有合法的用户、目标与机器人 ID（群聊还须有合法群 ID），且操作者不是机器人自身。开关关闭、无聊天密钥、封禁或冷却中不回复；受理时以文字占位进入会话历史，原始通知仍完整存入收件箱。

## 消息归一化与容错

数组消息保留每段完整数据和扩展字段。CQ 字符串按标准先分段再解码：`&amp;`、`&#91;`、`&#93;` 及参数内 `&#44;` 只解码一次；参数值允许 `=` 和换行。转义后的文字 `[CQ:...]` 不会被二次解释成消息段。无效 CQ 码作为文字保留。原始 `event` 永远保留原输入形式，`segments` 提供归一化数组。

不合法的消息路由 ID、段结构、文本字段只会产生 `malformed` 收件记录，不进触发器。非 JSON、JSON 原始值和非事件对象不进入收件箱。事件处理器的同步异常和异步拒绝均在连接层捕获，后续事件继续接收。

## 持久化与接口

- `DATA_DIR/events/YYYY-MM-DD.jsonl`：按 UTC 接收日期分文件的完整事件收件箱，串行追加。记录含 `id`、毫秒 `receivedAt`、`postType`、`eventType`、`subType`、`sessionKey`、`messageTypes`、`handling`、`issues`、原始 `event` 及可选 `segments`。
- `handling` 为 `trigger_eligible`、`received_only` 或 `malformed`。`trigger_eligible` 仅表示可交给原有触发器，不代表实际命中、通过权限或已回复。
- `readEvents({limit=50,postType,sessionKey,before})` 返回 `{items,nextCursor}`，最新在前；`before` 是稳定的事件 UUID 游标，跨日期分页，单页最多 200 条。坏行跳过；流式读取只保留一页，磁盘扫描仍与保留文件长度相关。指向已清理记录的游标返回空页。
- `getEventStats()` 返回本次进程的保存成功/失败数量、分类/会话计数和最后保存时间；`scope: 'process'` 表示重启后计数重新开始，不伪称历史总数。
- `flushEventStore()` / `flushMessageStore()` 等待各自已提交写入结束，供优雅停机。
- `getConnectionStatus()` 返回连接/重连状态、最近事件/心跳时间、心跳状态和间隔、API 未决数、坏帧和处理异常数；所有时间戳为毫秒，不返回访问令牌。

用户消息正文和昵称仅保存在收件箱及需要的会话历史中。消息接收日志只记录会话、消息 ID 和段类型，避免把内容复制到日志。

本版本验证为本地协议模拟与单元测试；真实 NapCat 是否上报某个标准/扩展事件，仍取决于其版本及上报设置。统一维护任务按 `RETENTION_DAYS` 清理过期收件文件，默认保留 30 天。

## 协议依据

2026-10-26 对照 OneBot 官方规范仓库：

- [消息事件](https://github.com/botuniverse/onebot-11/blob/master/event/message.md)
- [消息段类型](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md)
- [CQ 字符串和转义](https://github.com/botuniverse/onebot-11/blob/master/message/string.md)
- [通知事件](https://github.com/botuniverse/onebot-11/blob/master/event/notice.md)
- [请求事件](https://github.com/botuniverse/onebot-11/blob/master/event/request.md)
- [元事件及心跳](https://github.com/botuniverse/onebot-11/blob/master/event/meta.md)
