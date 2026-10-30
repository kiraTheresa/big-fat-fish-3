# 肥鱼说明书

[← 回到项目首页](../README.md)

## 使用与部署

| 想做什么 | 看这里 |
| --- | --- |
| 和肥鱼聊天、看图、画画、教人设与记忆 | [使用指南与指令速查](usage.md) |
| 首次部署、QQ 登录、重启、切换宿主机运行 | [NapCat 与 Bot 部署](napcat-deployment.md) |
| 收藏、搜索、发送和管理表情包 | [肥鱼表情包](memes.md) |
| 配置行为、权限、额度、任务，查看状态和素材 | [管理与公共服务](management.md) |
| 编辑、测试、评审和发布提示词 | [Prompt 工作台](prompt-console.md) |

## 开发与维护

| 想了解什么 | 看这里 |
| --- | --- |
| 当前目录结构、消息流、模块职责与开发命令 | [架构与开发](architecture.md) |
| 默认人设、场景规则与工具描述的位置及生效方式 | [Prompt 文件](../prompts/README.md) |
| 绘图原图、表情素材与元数据如何保存 | [媒体文件存储](media-storage.md) |
| 哪些事件只收件，哪些能触发业务 | [OneBot 接收契约](onebot-reception.md) |
| 正向 WebSocket、事件格式与 API 清单 | [NapCat 协议参考](napcat-protocol.md)（通用清单保留资料快照日期） |
| 管理页面与真实 QQ 的人工检查步骤 | [验收清单](console-acceptance.md) |
| 0.30.0 公开测试版内容、升级与验证边界 | [发布说明](releases/0.30.0.md) |
| 功能演进 | [更新日志](../CHANGELOG.md) |

## 历史归档

以下保留 2026-10-26 的设计和验证背景，**不作为当前功能清单**。其中的旧测试数量、未实现项和默认参数均属于当时记录。

- [阶段状态](archive/2026-10-26-state.md)
- [Bot 核心设计](archive/bot-core-design.md)
- [QQ Chat Bot 架构方向](archive/qq-chatbot-architecture.md)

文档约定：根目录 README 介绍能力和入口，CHANGELOG 保留演进记录；使用、部署与开发说明放在 `docs/`，阶段快照放在 `docs/archive/`，文档图片放在 `docs/assets/`。运行时默认提示词继续放在 `prompts/`。
