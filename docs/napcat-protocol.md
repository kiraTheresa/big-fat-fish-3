# NapCat / OneBot 11 项目接入

[← 文档目录](README.md)

本页只说明当前项目使用的协议、配置和 API。通用接口与字段清单保留在 [历史协议资料](archive/2026-10-24-napcat-protocol.md)，该快照不代表当前 NapCat 全部接口或兼容性。

## 连接与配置

Bot 主动连接 NapCat 的正向 WebSocket，一条连接同时接收事件和调用 API。容器内地址为 `ws://napcat:3001`；宿主机默认 `ws://localhost:3001`，由 `ONEBOT_WS_URL` 配置。Bot 使用 `Authorization: Bearer` 头携带 `ONEBOT_ACCESS_TOKEN`。

| 配置 | 当前项目约定 |
| --- | --- |
| WS 服务 | `bot-core`，监听 `0.0.0.0:3001`，消息段数组格式 |
| 登录与 WebUI | NapCat 的 `6099` 端口；Bot 管理台使用独立的管理令牌和端口 |
| 自动初始化 | 启动脚本同步账号配置和连接令牌；详细接管与备份规则见 [部署说明](napcat-deployment.md#启动时自动完成的配置) |
| API 超时 | `API_TIMEOUT_MS`，默认 15000 ms |
| 断线重连 | `RECONNECT_DELAY_MS`，默认 5000 ms |
| 发送间隔 | `SEND_INTERVAL_MS`，默认每次调用结束后等待 1000 ms |

连接状态由 WebSocket 是否打开决定；生命周期事件进入事件接收层，不是额外的连接门槛。心跳更新最后接收时间、间隔和健康快照；目前没有按心跳缺失主动重连的 watchdog。断开后的重连由 socket 的 close 事件触发。

## 请求与事件分流

`src/connection/onebot.js` 的 `callApi(action, params)` 发送 `{ action, params, echo }`，按 echo 匹配响应；`retcode === 0` 返回 data，否则拒绝并附带错误信息。未连接、超时和停机中止分别返回对应错误。

未匹配 API 响应、具有非空 `post_type` 的合法对象交给分发层。完整事件先进入收件存储，再按消息类型、权限和触发条件判断能否处理。数组消息与 CQ 字符串均有归一化支持；详细资格与容错见 [接收边界](onebot-reception.md)。

## 本项目 API 使用记录

| API | 调用位置 | 用途 |
| --- | --- | --- |
| `send_msg` | `src/sender/sender.js` | 所有群聊／私聊回复、图片、表情与用量报告统一排队发送 |
| `get_group_msg_history` | `src/triggers/chat.js` | 当前消息无图时查询最近群消息，再筛同用户与时间窗内近图 |
| `get_msg` | `src/memes/service.js` | 查询引用消息，按会话和来源规则提取待收藏的表情 |

`send_group_msg`、`send_private_msg`、群管理和好友申请处理接口不由当前业务直接调用；也没有定时主动推送业务。QQ 群角色不直接决定 Bot 管理权限，授权以 [项目权限](management.md#权限) 为准。

发送成功需同时收到 OneBot 成功响应与有效消息 ID。它表示平台确认，不代表用户已读或原生动画播放正常；超时、中止或缺少有效 ID 时结果未知，不自动重发。队列在内存中，详细结果分类见 [日志与排障](observability.md)。

## 消息段与媒体

Bot 可处理的文本、@、引用、图片、内置表情与商城表情，以及其他只收件类型，统一以 [接收边界](onebot-reception.md) 为准。图片发送使用 OneBot `image` 段；本项目内存图片采用 `base64://` 前缀。`face` 与 `mface` 保留原生发送参数，参数完整不等于运行中的 QQ 客户端已验证支持。

协议能力、Bot 实现能力与客户端实际效果分别判断。不要因为通用资料中列出了某个 API，就把它当成已实现的项目功能。

## 验证与参考

接入改动可选择 `test/connection.test.js`、`test/onebot-protocol.test.js`、`test/event-reception.test.js`、`test/sender.test.js`；部署初始化另见 `test/napcat-init.test.js`。这些入口使用本地模拟，不代表真实 NapCat 实例已验证。

字段级参考保留官方入口：[OneBot 11 规范](https://github.com/botuniverse/onebot-11)、[NapCat 配置](https://napneko.github.io/config/basic)、[NapCat API](https://napcat.apifox.cn/)。本轮仅校准项目接入，没有重新核验上游通用接口清单。
