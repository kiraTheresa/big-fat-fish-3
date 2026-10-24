# Bot 核心设计：分层、模块与消息流

> 版本：v0.1 · 2026-10-24
> 定位：讲清 Bot 核心的模块划分、分层职责与**一条消息的完整流通路径**。
> 姊妹文档：[qq-chatbot-architecture.md](./qq-chatbot-architecture.md)（项目方向与边界），本文不重复。

---

## 1. 总览：分层管道 + 横切组件

核心思想一句话：**入站一串筛选，出站一个收口，中间才轮到业务**。

```mermaid
flowchart TB
    subgraph MAIN["主管道（消息数据流，单向）"]
        C1["L1 连接层 connection/<br/>收帧 · 发帧 · 重连"]
        D1["L2 分发层 dispatch/<br/>事件路由 · 筛选"]
        T1["L3 处理层 triggers/<br/>触发器链（业务）"]
        S1["L4 发送层 sender/<br/>队列 · 限流收口"]
        C1 --> D1 --> T1 --> S1
    end

    SCH["scheduler/ 定时任务<br/>（预留，旁路）"] --> S1
    CFG["config.js 配置"] -.-> C1
    LOG["utils/logger.js 日志"] -.-> MAIN
    STORE["data/ 持久化（预留）"] -.-> SCH

    style MAIN fill:#f0fdf4,stroke:#86efac
    style SCH fill:#fff7ed,stroke:#fdba74
```

读图要点：

- **主管道四层**：数据只能从上往下流，禁止跨层乱穿（L3 不 import L1，只通过 `ctx.reply()` 把消息交给 L4）；
- **定时任务是旁路**：它没有"收到消息"这个起点，直接把生成好的消息插进发送层——这就是发送层必须是全项目唯一出口的原因；
- **横切组件**（配置/日志/持久化）不属于任何一层，被所有层共享，用虚线表示。

---

## 2. 消息怎么流（核心节）

### 2.1 入站：三层筛选

每一帧从 WS 到达后，要过三道门，任何一道不过就直接丢弃，到不了业务代码：

```mermaid
flowchart LR
    A["WS 帧到达"] --> B{"筛选① 格式<br/>JSON 可解析？"}
    B -- 否 --> X1["丢弃"]
    B -- 是 --> C{"筛选② 类型<br/>有 echo？"}
    C -- "是（API 响应）" --> R["echo 匹配 → 回调 Promise"]
    C -- "否（事件）" --> D{"筛选③ post_type<br/>=== 'message'？"}
    D -- "meta_event / notice / request" --> X2["忽略（预留）"]
    D -- message --> E["构造 ctx → 触发器链"]

    style X1 fill:#fef2f2,stroke:#fca5a5
    style X2 fill:#fef2f2,stroke:#fca5a5
    style E fill:#f0fdf4,stroke:#86efac
```

| 筛选 | 在哪层 | 作用 |
|---|---|---|
| ① JSON 可解析 | L1 | 挡掉坏帧/非 JSON 数据 |
| ② 有 `echo` 字段 | L1 | 区分"API 响应"和"事件"——两者走同一条 WS，全靠 echo 区分 |
| ③ `post_type === 'message'` | L2 | MVP 只处理消息事件；心跳/戳一戳/加群请求全部拦下 |

**筛选的意义**：业务代码（触发器）看到的事件都是"干净的、确定是聊天消息"的数据，不需要自己判断乱七八糟的情况。

### 2.2 生成与出站：命中即处理

过了三道门的消息进入触发器链，匹配成功就生成回复，然后统一出站：

```mermaid
flowchart LR
    E["ctx 进触发器链"] --> M{"按注册顺序逐个 match()<br/>命中即停"}
    M -- "全部不中" --> X["静默丢弃（不是所有消息都要回）"]
    M -- "命中某个触发器" --> H["handle(ctx)<br/>生成回复内容"]
    H --> Q["入发送队列"]
    Q -->|"每 1s 出队一条（防风控）"| API["callApi(action, params, echo)"]
    API --> RET["NapCat 回 retcode=0<br/>echo 匹配 → resolve"]

    style H fill:#f0fdf4,stroke:#86efac
    style X fill:#fef2f2,stroke:#fca5a5
```

出站为什么收口到一个队列：**QQ 对发消息的频率有限制**，全项目不管几个模块要发消息，都排同一条队、按固定间隔出门，风控风险只在这一个点管理。

### 2.3 完整生命周期：一条 ping 的旅行

以群聊里发 `ping` 为例，从 QQ 到回复的全链路：

```mermaid
sequenceDiagram
    participant Q as QQ 服务器
    participant N as NapCat(:3001)
    participant C as L1 连接层
    participant D as L2 分发层
    participant T as L3 触发器链
    participant S as L4 发送层

    Note over N,C: WS 已建立 · Bearer token 鉴权通过
    Q->>N: 群消息 "ping"（QQ NT 协议）
    N->>C: 推送 message 事件（JSON，含 raw_message="ping"）
    C->>C: 筛选①②：JSON ✓ · 无 echo ✓ → 上抛
    C->>D: onEvent(事件)
    D->>D: 筛选③：post_type=message ✓ · 构造 ctx（含 reply()）
    D->>T: 按注册顺序匹配
    T->>T: ping 触发器 match 命中 → handle → ctx.reply("pong")
    T->>S: reply 交给发送队列
    S->>C: 出队（1s 间隔）→ callApi("send_group_msg", {...})
    C->>N: { action, params, echo: "7" }
    N->>Q: 发送群消息 "pong"
    N-->>C: { retcode: 0, data: {message_id}, echo: "7" }
    C-->>S: echo 匹配 → Promise resolve（发送确认）
```

三个容易忽略的细节：

1. **`ctx.reply()` 不是立即发送**，只是入队——真正的发送由队列节奏决定；
2. **API 调用是异步的**：发出去只是"提交"，收到 `retcode=0` 那条响应才算"确认"；
3. **响应和事件走同一条 WS**：N-->>C 的那条响应靠 `echo: "7"` 找到对应的 Promise，这就是 echo 匹配机制。

---

## 3. 分层职责速查

| 层 | 目录 | 职责一句话 | 关键决策 | 禁止事项 |
|---|---|---|---|---|
| L1 连接 | `src/connection/` | 字节与协议：收帧、发帧、重连、echo 匹配 | 正向 WS + Bearer 鉴权 + 15s 调用超时 | 出现任何业务词汇 |
| L2 分发 | `src/dispatch/` | 筛选与路由：决定什么事件能到业务层 | MVP 只放行 message 事件 | 写业务 if-else |
| L3 处理 | `src/triggers/` | 触发器链：一条消息触发什么回复 | 注册式、按序匹配、命中即停 | 触发器之间互相调用 |
| L4 发送 | `src/sender/` | 出站收口：队列 + 限流 | 固定 1s 间隔 | 提供绕过队列的接口 |

---

## 4. 处理层怎么组织（带过）

触发器契约：`{ name, match(event) → boolean, handle(ctx) }`

- **加功能 = 加文件 + index.js 一行注册**，分发器永不修改；
- **按注册顺序匹配，命中即停**：一条消息只触发一个回复，避免刷屏；
- MVP 的"类 Chat"行为完全够用：关键词/命令 → 固定或拼接回复（`ping → pong` 即首个实例）；
- 将来接 LLM：LLM 调用塞进某个触发器的 `handle` 内部，架构不变（呼应架构文档第 9 节）。

---

## 5. 通用组件（横切）

| 组件 | 位置 | 状态 | 说明 |
|---|---|---|---|
| 配置 | `src/config.js` | ✅ | env 优先 + 默认值，全项目唯一配置来源 |
| 日志 | `src/utils/logger.js` | ✅ | 统一格式 `[时间] LEVEL 消息` |
| 发送队列 | `src/sender/sender.js` | ✅ | 1s 固定间隔，全项目唯一出站口 |
| 持久化 | `data/` | 预留 | 定时任务落盘，重启恢复 |
| 权限 | 未建 | 预留 | 管理员命令需要，一个 QQ 号白名单即可 |
| 调度器 | `scheduler/` | 预留 | 旁路直插发送层，见第 1 节 |

---

## 6. MVP 范围与现状

| 项 | 状态 |
|---|---|
| L1 连接层（鉴权/重连/echo） | ✅ 已实现 |
| L2 分发层（message 筛选 + ctx） | ✅ 已实现 |
| L3 触发器链 + ping | ✅ 已实现（闭环验证进行中） |
| L4 发送层（队列限流） | ✅ 已实现 |
| 心跳监控 / 事件去重 | ⏸ 遇到问题再补（保险丝项） |
| 调度器 / 持久化 / 权限 | 下一期 |

MVP 验收标准就一条：**群里发 `ping`，机器人回 `pong`，日志里能看到完整流通路径**。
