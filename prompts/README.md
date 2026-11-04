# Prompt 文件

[← 文档目录](../docs/README.md)

这里存放随仓库维护的默认 Prompt。正文与程序逻辑分开：修改措辞、示例和规则时编辑这些文件；加载、变量替换、权限及执行逻辑保留在 `src/`。

| 文件 | 用途 |
|---|---|
| `character.md` | 新会话的初始人设 |
| `response.md` | 群聊和私聊共用的回应规则、语气示例、发送格式 |
| `group.md` / `private.md` | 各场景的差异规则，后接 `response.md` |
| `identity.md` | 身份、发言者、历史与记忆的理解边界 |
| `tool-rules.md` | 工具调用和结果确认规则 |
| `meme-rules.md` | 表情收藏、候选选择、单次发送和模拟模式规则 |
| `tools.json` | 工具及参数的描述文字；工具实现和开关仍由程序管理 |
| `distill.md` | 后台人设与记忆提炼指令 |
| `distill-preservation.md` | 提炼时追加的锁定行保护规则，避免旧发布模板漏掉约束 |
| `scene.md` | 当前时间、场景与静默时长模板 |
| `system.md` | system 正文各部分的顺序和标题 |
| `poke.md` / `poke-system.md` | 戳一戳的默认回复要求及该轮补充模板 |

`src/prompt/defaults.js` 在模块加载时读取这些文件，路径相对模块定位，与启动目录无关。文本统一换行，并去掉文件末尾的一个换行符；文件缺失或为空会报错，不静默退回另一套文字。修改文件后需要重新启动加载，Docker 镜像通过 `COPY prompts ./prompts` 打包。

变量由程序限定：`scene.md` 支持 `{{time}}`、`{{scene}}`、`{{silence}}`；`distill.md` 支持 `{maxBytes}`；`system.md` 支持 `{{character}}`、`{{memory}}`、`{{behavior}}`、`{{identity}}`、`{{toolRules}}`；`poke-system.md` 的 `{{prompt}}` 接收当前配置中的戳一戳要求。组装只替换一次，人设或记忆中长得像变量的文字不会递归展开。

这些文件是默认模板，不会覆盖控制台已经保存的草稿、发布版本或会话人设。已有部署通过控制台编辑、测试、评审和发布；初始人设只作用于新建或重置会话。运行时数据仍位于 `data/`，不要通过删除数据来应用新模板。程序对旧内置规则和新工具存在定向迁移，不能理解为全面覆盖定制配置；发布流程见 [Prompt 工作台](../docs/prompt-console.md)。

这些 Markdown 正文与 `tools.json` 是运行配置；普通文档整理不修改它们。模板改动可选择 `test/prompt-style.test.js` 或 `test/prompt.test.js` 定向验证，真实模型效果按工作台评审。
