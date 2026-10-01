# open-assistant Roadmap

**项目定位**：基于 subagents 的个人助手 agent —— 用户个人的 todo 管理 + 长期记忆 + 主动唤醒。
**技术约束**：前后端**全部 TypeScript**。
**日期**：2026-09-30（当前状态一节更新于 2026-10-01）
**依据**：LangChain 官方文档（JS 版）、`deepagents` 包内 `.d.ts` 实读、QwenPaw 源码实读、Karpathy LLM Wiki gist、OpenDesign 前端源码。
**方法论**：结论分三级标注 —— `[实证]` 直接读到代码/类型/原文；`[文档]` 官方文档声称；`[推测]` 推断未验证。

> 调研原始材料在 `.scratch/research/`：
> `langchain-frontend.md`(36KB) · `deepagents-async-subagent.md`(48KB) · `opendesign-ui.md`(65KB) · `karpathy-llm-wiki-gist.md`
> 上一轮的总调研见仓库根的 `调研报告.md`。

---

## 当前状态（2026-10-01 第二次收口）

> 一句话：**基座（M0）已落地；`add-custom-agents` 做到 67/139 —— 智能体注册与配置、工作区绑定、
> 长期记忆、定时任务、项目知识图谱、消息频道都已可用**；子智能体系统与频道运行时接线尚未开始。

### 已实现

**变更 1 · `bootstrap-deep-agent`（已归档，89/89）**

| capability | 内容 |
|---|---|
| `agent-core` | 对话循环 / 流式 / 人设装载 / **首次引导（BOOTSTRAP.md）** / 工具调用可见性 |
| `session-store` | 会话持久化 / 隔离 / 按工作区检索 / 上下文压缩 |
| `workspace` | **本机路径工作区**（非服务端 id）/ 路径约束 / **显式初始化按钮** / 人设保护 / 凭据分离 |
| `chat-ui` | 全中文 / **回合聚合** / 思考展示 / **按类型分发的工具卡片** / 宽窄模式 |
| `file-workspace-ui` | 文件树 / 按类型分流渲染 / **TODO 专用视图** / 改动可见 |
| `todo-store` | JSON 单文件事实源 / 四个 agent 工具 / 原子写 + 409 乐观并发 |
| `app-shell` | 左导航 + 顶栏 + **分段路由** / **可停靠面板** / 导航可配置 / 插槽 / 页面级故障隔离 |

**变更 2 · `add-custom-agents`（进行中，67/139）**

| capability | 状态 | 内容 |
|---|---|---|
| `agent-registry` | ✅ | 智能体定义 / 配置项（人设·模型·工具白名单·审批级别）/ 技能 / **跨工作区长期记忆** |
| `agent-binding` | ✅ | **智能体 ↔ 工作区 1:1**；一个目录只能由一位维护（冲突 409 并指出占用者）；换绑可追溯（keep / archive） |
| `runtime-host` | ✅ | 运行期身份只认绑定（不采信客户端传来的 agent_id）；模型解析链 |
| `agent-scheduling` | ✅ | 定时任务（cron）/ 一次性任务 / 执行器 / 会话归属 |
| `project-wiki` | ✅ | 索引 / 知识图谱（边抽取·声明式 relations·全量重建）/ 归档 / lint |
| `channels` | 🟡 12/56 | 字段类型系统 / 目录 / 凭据库（掩码）/ 有界去重 / 退避 / **QQ 网关客户端（离线测通）**；飞书与运行时接线未做 |
| `channels-ui` | 🟡 22/29 | 配置区块长在智能体配置页 / 字段驱动表单 / 掩码 / 配置状态（未配置·已配置·已启用） |
| `agent-skills` | 🟡 4/14 | 技能装载与渐进披露 |
| `multi-agent-comms` | 🟡 6/20 | 同侪互交（进行中，见 `add-subagent-orchestration`） |
| `session-store` / `todo-store` / `workspace` | — | 本次变更对它们的增量（大部分未开始） |

**验证状态**：后端 **400 pass** · 前端 **194 pass** · 会话库（Node）**14 pass** · 两端 `tsc --noEmit` 干净 ·
`openspec validate --strict` 通过。

### 怎么跑

```bash
bun install
bun run dev:server     # http://localhost:2024（agent + langgraph dev）
bun run dev:web        # http://localhost:3000
bun run smoke          # 后端冒烟
bun run --cwd apps/server test              # 后端测试
bun run --cwd apps/server test:conversation # 会话库测试（必须用 Node 跑）
bun run --cwd apps/web test                 # 前端测试
```
密钥在 `apps/server/.env`（已 gitignore）。截图见 `docs/images/`，项目介绍见 `README.md`。

### 尚未开始

- **子智能体系统（M3）** —— 最大未做项；**D1（子 agent 独立 checkpoint）仍未 spike**
- **频道运行时接线** —— 现在「配好了但没人去连」：agent 启动时读启用频道 → 建网关 → 收到消息灌进会话
- **飞书频道**（QQ 已实现且离线测通）
- **心跳维护（M6）** —— 默认 `HEARTBEAT.md` 已生成，但没有调度器去跑它
- 前端数据层迁 `@langchain/react` v1；`packages/contracts` 共享类型包（目前类型内联在各自 app）

### 已知遗留（不影响主流程）

0. **⚠️ 会话存储不在工作区内（spec 与实际不符，已 spike，待定方案）**
   - spec `session-store` 要求「会话数据落在所属工作区内」「移走工作区不丢历史」；**实际**会话正体在 `apps/server/.langgraph_api/.langgraphjs_api.checkpointer.json`（已 19MB），**所有工作区共用一份**；工作区内只有 `sessions.json` 索引
   - **Spike 结论（已实做）**：给 `createDeepAgent` 传自己的 `SqliteSaver`（指向 `<工作区>/.open-assistant/checkpoints.sqlite`）**被 langgraph dev 忽略** —— 工作区里的 sqlite **0 字节**，而 server 自己的 19MB 文件照写。图确实跑在 **Node 24** 下（`{isBun:false}`），所以 SqliteSaver 能加载，问题不是原生模块而是**平台接管了持久化**
   - `langgraph.json` 允许的键为 `graphs / env / dependencies / http / auth / ui / node_version / api_version / store` —— **没有 `checkpointer` / `database` / `persistence` 开关**，dev server 的存储后端不可配置
   - 附带约束：`better-sqlite3` **在 bun 下完全不可用**（`bun:sqlite` 才是其内置方案），所以 SQLite checkpointer 只能跑在 Node 侧（测试/探针脚本用 bun 跑会报 `ERR_DLOPEN_FAILED`）
   - 三个待选方向：**① 自托管运行时**（不用 `langgraph dev`，自己用现成的 Hono app 暴露 thread/run/SSE，checkpointer 按工作区开库）—— 推荐，且能一并解决下面的 D1；② 保留 dev server，修 spec 迁就现实；③ 双写：跑在 server 但每次结束后把 messages 导出到工作区（副本）

1. **`agent_id` 已有但没接线（2026-10-01 查明）**
   - 我们自己的会话库 schema 里 `threads.agent_id TEXT NOT NULL` + 索引都在，`ListThreadsOptions.agentId` 过滤器也实现了，但**没有任何调用方**
   - 真正在跑的会话在 langgraph 那边，thread metadata 只有 `workspace / graph_id / assistant_id`，**没有 agent_id 维度**；归属暂时记在旁挂的 `.open-assistant/sessions-agents.json`
   - `binding.ts` 的注释写着「等 sqlite `threads.agent_id` 上线后可平滑替换」—— 那个列早就有了，是**没接**
   - 三个方向：**(A) 把 agent_id 写进 langgraph thread metadata**（改动小，且能删掉旁挂文件）← 推荐；(B) 真正启用我们自己的会话库（大改）；(C) 维持现状
   - 附带：`http.ts` 里**一条会话路由都没有**，界面上的会话列表完全来自 langgraph SDK，我们自己的会话库对前端是隐形的

2. **`sessions.sqlite` 是 0 字节空壳** —— 说明会话库在聊天这条路线上从没被打开过（`openConversationDb` 会建表）。全项目里往会话库写线程的唯一运行时调用点是 `jobs/session.ts`

3. **两处未实测的边角**：`prefers-reduced-motion` 下跳过面板位移动画；面板「收起后重开宽度恢复」（只测了停靠↔浮动）

4. **上游 bug 绕过**：provider 省略首个 delta 的 `role` → `ChatMessageChunk` → LangGraph `AgentNode` 硬失败（~25% 概率）。已用 `RobustChatOpenAI` 根因修复（见 `apps/server/src/model.ts`），**值得给 `@langchain/openai` 报 issue**

5. **旧 thread 的 workspace metadata 仍是 id 字符串**（`"default"` 而非绝对路径）—— 当前前端不按工作区过滤 thread 所以无可见问题；将来加过滤时需一次性重写

6. `/cron`、`/memory` 曾经是占位页，现在已是实页；`/settings` 仍偏薄

---

## 0. 先读这里：三个必须先拍板的决策

在开工前必须解决。三个都是**技术冲突**。

### D1. 子 agent「独立 checkpoint」与「自研 create_agent」天然冲突 ⚠️ 最重要

这是本 roadmap 最关键的发现，直接决定架构形态。

`[实证]` `deepagents` 的**同步**子 agent（`SubAgent` / `CompiledSubAgent`）**没有独立 checkpoint**，因为：

```js
// createSubAgent 编译子 agent 时不传 checkpointer
return createAgent({ model, systemPrompt, tools, middleware, name });
// runTask 把父 config 整个 spread 进去（含父的 thread_id）
const subagentConfig = { ...config, metadata: {...}, configurable: {...} };
```

| 需求 | 同步 `SubAgent` | `CompiledSubAgent`（自研 createAgent） | `AsyncSubAgent` |
|---|---|---|---|
| 独立 `thread_id` | ❌ 继承父 | ❌ 除非自行 wrap config | ✅ `threads.create()` |
| checkpoint 持久化 | ❌ 无 checkpointer | ⚠️ 取决于你怎么传 | ✅ 远端独立空间 |
| trace 按子 agent 切分 | ✅ `lc_agent_name` | ✅ | ✅ |
| context(messages) 隔离 | ✅ | ⚠️ 取决于 state 传入 | ✅ |
| 虚拟文件系统隔离 | ❌ `files` 仍继承 | ❌ | ✅ 独立进程 |

**「独立 checkpoint」只有 `AsyncSubAgent` 原生做到**（每次 `threads.create()` → 新 `thread_id`，`taskId === threadId`）。

但需求 8 要求「会话时用 langchain 的 `create_agent` 创建子 agent」+「继承 deepagent 的工具和沙箱」——这指向 `CompiledSubAgent`（它完全绕过 deepagents 默认栈，正是「运行时自研 createAgent」的官方入口）。

**三条可选路径**：

- **A（推荐）**：子 agent 用 `CompiledSubAgent` 形态（自研 `createAgent` + 继承工具/sandbox），但**自己传 checkpointer 并 wrap config 覆盖 `thread_id`**，人工造出独立 checkpoint。`[推测]` 未验证——需要 spike 验证 `checkpoint_ns` 是否会污染。
- **B（最稳）**：需要独立 checkpoint 的子 agent 走 `AsyncSubAgent`（远端 graph / ASGI co-deploy），自研 `createAgent` 作为那个远端 graph 的实现。
- **C（降级）**：接受同步子 agent「trace 独立、checkpoint 共享」，只靠 `lc_agent_name` 过滤。实现最省，但违背需求 8。

**动作**：M0 阶段用 1 天做 A vs B 的 spike。

### D2. 前端方案：**直接采用 `deep-agents-ui`**（已定）

上一轮在 OpenDesign / QwenPaw / LangChain 官方三份材料间犹豫。现在结论明确：

- **基座 = `langchain-ai/deep-agents-ui`**（1706★，35 文件 / 2914 行）—— 官方为 Deep Agents 做的定制 UI，**直接搬过来改 UI**，不重写
- OpenDesign / QwenPaw 降级为**视觉参考**（OpenDesign 的令牌分层；QwenPaw 的运维面板密度）
- 它的 graph state 契约是 `{ messages, todos, files }`，**反过来约束了后端**：必须暴露 `todos` 与 `files`

**遗留选择（未定）**：基座用 `@langchain/langgraph-sdk/react`（旧 hook 形态，已验证可跑），官方新文档已改用 v1 `@langchain/react` + `stream.subagents` + scoped selector。是「原样搬」还是「搬壳 + 数据层重写为 v1」，待定。

### D3. `[实证]` 子 agent「不继承子 agent 调用能力」是结构性的，无需额外设计

子 agent 默认 middleware 栈**不含 `SubAgentMiddleware`** → 没有 `task` 工具 → 不可能递归。
例外：`mode: "fork"` 会注入但运行时拒绝。
另有 `[实证]` 一个**静默死分支**：`mode: "handoff"` 不报错，被静默当 `isolated` 处理——配错不会报错，注意。

---

## 1. 技术选型

| 层 | 选型 | 依据 |
|---|---|---|
| 语言 | TypeScript（全栈） | 需求 |
| 包管理 / 运行时 | **Bun 1.4.1**（不用 npm / yarn / pnpm） | 需求 |
| Manager agent | `deepagents` npm `createDeepAgent` → 编译好的 LangGraph graph | `[实证]` |
| 子 agent | LangChain v1 JS `createAgent`（`CompiledSubAgent` 或 `AsyncSubAgent` 远端图） | 需求 8，见 D1 |
| Agent server | `langgraph.json` + `@langchain/langgraph-cli` dev server | `[文档]` 方案 A |
| 持久化 | LangGraph `checkpointer`（生产 Postgres；开发 SQLite/内存）+ `store` | `[文档]` |
| 前端基座 | **`langchain-ai/deep-agents-ui`**（35 文件 / 2914 行，直接搬 + 改 UI） | 用户决定 |
| 前端壳 | **Next.js 16** App Router + React 19（由基座决定） | `[实证]` |
| 前端数据层 | 基座原用 `@langchain/langgraph-sdk/react`（旧形态，能跑）；**建议改 v1 `@langchain/react`** | 见 D2 |
| 样式 | 基座：Tailwind 3 + Radix/shadcn；可参考 OpenDesign 三层设计令牌 | `[实证]` |
| 数据面 | 文件系统 + JSON（todo / jobs / config）；graph state 需暴露 `todos` / `files` | 需求 4、7 |

### 前端 API 契约要点 `[实证]`

```tsx
import { useStream, useMessages, useToolCalls, useMessageMetadata } from "@langchain/react";
import type { agent } from "../agent";   // ← 必须 import type，否则 agent 被打进 bundle

const stream = useStream<typeof agent>({ assistantId: "agent", apiUrl: "..." });
```

- **包名**：v1 = `@langchain/react`（1.2.0）；旧的 `@langchain/langgraph-sdk/react` 是 v0，**API 已变**（`branch/setBranch` 删除 → `forkFrom`）。坑：网上多数示例（含 agent-chat-ui）仍是 v0。
- **投影**：`values / messages / toolCalls / interrupt(s) / isLoading / subagents / subgraphs / subgraphsByNode / threadId` + `submit / stop / respond / respondAll / getThread`
- **subagents 是 eagerly discovered, lazily streamed**：`stream.messages` **只含 coordinator 自己的消息**；`stream.subagents` 只是身份快照 `{id, name, namespace, parentId, depth, status}`（**不含消息**）；子消息要 `useMessages(stream, subagent)` 按需订阅，**ref-counted**。
- **类型收窄**：靠 `typeof agent` brand + `InferSubagentNames/InferSubagentState/InferToolCalls/AssembledToolCallFromTool`。**已知缺口**：`stream.subagents` 的 map key 与 scoped `useValues` 不会按名字自动收窄，需预留一层 wrapper。
- **HITL**：`stream.interrupt` 只是 root 镜像；`respond()` 默认从 `getThread()?.interrupts` 取最新未 resolve（含 subgraph，带 namespace）。
- **Time travel**：`useMessageMetadata` → `parentCheckpointId` + `submit(..., { forkFrom })`。
- **Todo 直接白拿**：`TodoListMiddleware` → `stream.values.todos`（`pending → in_progress → completed`）。

---

## 2. 目标架构

```
┌──────────────────── 前端（React + TS） ─────────────────────┐
│ 对话 UI（LangChain v1 useStream）  │ Todo Web │ 运维面板      │
│  · stream.messages（coordinator）  │  JSON    │ cron/heartbeat │
│  · 子 agent 折叠卡（scoped 订阅）   │          │ wiki 浏览      │
│  · interrupt 审批卡                │          │ 文件树          │
│  · todos 列表              │          │                │
└───────────────┬─────────────────────────────────┘
                │ SSE / langgraph-sdk
┌───────────────▼─────────────── 后端（Node + TS） ───────────────┐
│ Manager DeepAgent (manager)                                       │
│  systemPrompt ← AGENTS.md / SOUL.md / PROFILE.md（qwenpaw 式）     │
│  middleware   ← 洋葱模型（qwenpaw 6 钩子语义）                      │
│  tools        ← todo / 文件 / wiki / heartbeat-trigger            │
│  backend      ← 虚拟文件系统（qwenpaw workspace 布局）              │
│  checkpointer ← thread_id = 会话                                  │
├───────────────────────────────────────────────────────────────┤
│ 子 agent 池（createAgent，继承工具+沙箱，无 task 工具）              │
│  各自 thread / checkpoint / trace（见 D1 选型）                     │
├───────────────────────────────────────────────────────────────┤
│ 调度：Cron（jobs.json） · Heartbeat（HEARTBEAT.md + every + 时段）  │
│ 记忆：三层 + 会话压缩（scroll 策略）                                 │
│ Wiki：raw/ → 编译 → wiki/{index,log,summaries,entities}           │
└───────────────────────────────────────────────────────────────┘
```

---

## 3. 里程碑

### M0 · 地基与选型验证（1 周）

目的：**把 D1 的架构风险和小规模可行性验掉**，再铺量。

- [x] 初始化 monorepo（**bun workspace**）：`apps/server`（agent + langgraph dev）· `apps/web`（deep-agents-ui 改）· `packages/contracts`（共享类型，待建）
- [x] 装依赖并跑通最小闭环：`createDeepAgent` → `langgraph.json` → `langgraphjs dev` → 前端连上并请求后端 ✅ `POST /assistants/search 200`
- [ ] **Spike A vs B（D1）**：验证「自研 createAgent 子 agent 能否有真正独立的 checkpoint/trace」
- [x] 确认 D2：采用 `langchain-ai/deep-agents-ui` 作前端基座
- [ ] 定义 `packages/contracts` 的第一批类型（会话、todo、cron job、wiki 页）
- [ ] 把 deep-agents-ui 的数据层从 `@langchain/langgraph-sdk/react`（旧形态）迁到 v1 `@langchain/react`

**已完成部分的备忘**：
- 模型：`qwen-token-plan-cn` + `deepseek-v4.1-flash`，经 `ChatOpenAI` + token-plan 兼容端点直接可用，**无需任何 compat 补丁** —— 但需注意上游 role 缺失 bug（见「当前状态」的遗留 2）
- `files` 契约默认成立（state key 自带 `mimeType` / `created_at` / `modified_at`）
- ✅ `todos` 的问题已解决：它确实不是默认 state key，所以**改为自研四个工具 + `todos.json` 单文件事实源**（见 capability `todo-store`），UI 从文件读而不是从 `stream.values.todos` 读
- ✅ 实际还多做了一整层：**应用外壳（app-shell）**、本机路径工作区、显式初始化与首次引导 —— 这些原不在 M0 里，是随做随加的

**Exit**：前端能对着真 agent 流式输出 token；子 agent checkpoint 隔离有明确结论。

---

### M1 · Manager DeepAgent 内核（1.5 周）→ 需求 2

- [ ] `systemPrompt` 装配：参考 qwenpaw 的 `system_prompt_files = ["AGENTS.md","SOUL.md","PROFILE.md"]`，启动时载入
- [ ] middleware 洋葱（6 个钩子语义）：`on_system_prompt` / `on_model_call` / `on_reply` / `on_compress_context` / `on_acting` / `on_reasoning`
  - `[实证]` qwenpaw 组装顺序（由外到内）：ToolResultPruning → ToolCoordinator → Memory → Langfuse → **插件** → VisualCompression（永远最内层）
  - `[实证]` qwenpaw 的坑：插件 `priority` 声称 "lower = outermost" 但实现是 append 到末尾，**实际只决定插件彼此顺序**
- [ ] HITL：`interruptOn` + `checkpointer`（**两者必须同时有**，否则中断不生效）
- [ ] `permissions`：声明序首匹配 + 默认宽松；要收紧必须先写宽规则再写 deny
- [ ] 定义 manager 的工具集（先不放 `task`，等 M3）

**Exit**：一个能对话、能调工具、能在危险工具上中断等审批的 manager。

---

### M2 · 会话 / checkpoint / 压缩（1.5 周）→ 需求 2

- [ ] **thread_id 设计**：`thread_id` = 会话 id。`[实证]` LangGraph 的 `checkpoint_ns` 用 `|` 拼接子图链，子 agent 挂在 `["tools:<task_id>", ...]` 下
- [ ] 会话持久化：参考 qwenpaw `chats.json` + `dialog/` jsonl（`dialog_path` 默认 `"dialog"`，相对 working_dir）
- [ ] **会话压缩**：直接照搬 qwenpaw 的 `scroll` 策略（默认策略，比 native 压缩更抗膨胀）
  - `ContextCompactConfig`：`compact_threshold_ratio = 0.8`（占 max_input 的比例触发）、`reserve_threshold_ratio = 0.1`（压缩后保留最近 10% 保连续性）
  - `ScrollContextConfig`：durable history 落 `history.db`（SQLite），被驱逐的轮次折叠成**上下文的驱逐索引**，可经沙箱内 `recall_history_python` REPL 召回；`history_retention_days = 30`；`repl_timeout_s = 300`
  - `ToolResultPruningConfig`：`pruning_recent_n = 2`、老消息 `3000` 字节 / 新消息 `50000` 字节、豁免 `.md` 与 `chat_with_agent`、裁掉原文落盘 `offload_retention_days = 30`
  - qwenpaw 的 env 口径：`MEMORY_COMPACT_THRESHOLD=100000` 字符、`KEEP_RECENT=3`、`RATIO=0.7`
- [ ] SSE 重连回放：参考 qwenpaw `TaskTracker.attach_or_start` —— **一个 run、N 个订阅队列 + buffer 先回放**，一份产物同时服务前端与频道，免费获得断线重连
- [ ] 压缩前快照 + 压缩后 flush（qwenpaw `MemoryMiddleware.on_compress_context` 的语义）

**Exit**：长对话不爆上下文；断线重连不丢消息。

---

### M3 · 子 agent 系统（2 周）→ 需求 2 + 8

- [ ] 子 agent 定义：**可自定义参数**（name / description / systemPrompt / model / tools / middleware / skills / interruptOn / responseFormat）
- [ ] 用 `createAgent` 在会话时构造；**继承** manager 的工具与 sandbox backend
- [ ] **不继承**子 agent 调用能力：`[实证]` 结构性满足（不含 `SubAgentMiddleware` → 无 `task`）；**但要显式断言**，防止未来 deepagents 默认栈变化
- [ ] 独立 trace：`[实证]` 靠 `metadata.lc_agent_name = <subagent_type>` + `configurable.ls_agent_type = "subagent"`；LangSmith 用 `filter='has(metadata, \'{"lc_agent_name":"xxx"}\')'` 切分
- [ ] 独立 checkpoint：按 D1 结论落地
- [ ] 批量并发上限：参考 qwenpaw `MAX_SPAWN_BATCH_SIZE = 10` / `MAX_SPAWN_BATCH_CONCURRENCY = 3`
- [ ] 审批回流：子 agent 的审批必须路由回根会话 —— qwenpaw 靠 `root_session_id` + `_spawn_subagent` 标记 + 继承 `approval_route`。**漏掉就会在子层悬空**
- [ ] **同侪互交开关**（需求 8 的按钮）：`allowSiblingInteraction: boolean`。`[实证]` 默认关（避免递归/混乱）。**具体语义留待后续讨论**
- [ ] 前端：子 agent 折叠卡，按 spawn 它的 tool-call id 挂在对应 AI message 下 + 进度条 `complete/total`

**Exit**：manager 能并行起多个子 agent，各自 trace/checkpoint 干净，前端能看到每个子 agent 的活动。

---

### M4 · Todo（1 周）→ 需求 4

- [ ] **JSON schema 设计**（`todos.json`）：id / title / status / priority / due / tags / parent / created / updated / source（user|cron|heartbeat）/ notes
- [ ] 自研工具让 agent 接入：`todo_list` / `todo_create` / `todo_update` / `todo_complete` / `todo_delete`
- [ ] 与 LangChain 官方对齐：`TodoListMiddleware` 暴露 `stream.values.todos`（`pending → in_progress → completed`）——**能用官方就复用，自研只补 JSON 持久化与 todo web 需要而官方没有的字段**
- [ ] Todo Web：从一个极端简单的抽屉开始，先只读后可写

**Exit**：agent 能增删改查 todo；人能在 web 上看和改。

---

### M5 · Cron（1 周）→ 需求 5

字段与功能直接对齐 qwenpaw（`app/crons/models.py` 实读）：

```ts
ScheduleSpec {
  type: "cron" | "once"
  cron?: string              // 5 段；4/3 段会被归一化；不支持秒
  run_at?: datetime          // type=once 必填
  timezone: string = "UTC"
  repeat_every_days?: number
  repeat_end_type?: "never" | "until" | "count"
  repeat_until?: datetime    // 必须晚于 run_at
  repeat_count?: number
}

DispatchSpec {
  type: "channel" = "channel"
  channel: string = DEFAULT_CHANNEL
  target: { user_id, session_id }
  mode: "stream" | "final" = "stream"
  silent: boolean = false    // silent 仅 agent 任务支持
  meta: Record<string, any>
}

JobRuntimeSpec {
  max_concurrency: number = 1
  timeout_seconds: number = 120
  misfire_grace_seconds: number = 600
  share_session: boolean = false   // false → 该 job 用专属的 cron 来源会话
  tool_safety: boolean = false     // true=AUTO(风险工具需审批，可能阻塞无人值守) / false=OFF(全执行)
}

CronJobSpec {
  id?, name, enabled = true
  schedule: ScheduleSpec
  task_type: "text" | "agent" = "agent"
  text?: string              // task_type=text 必填
  request?: CronJobRequest   // task_type=agent 必填（透传给 stream_query）
  dispatch: DispatchSpec
  save_result_to_inbox?: boolean   // 产品规则：text + 周期 默认 OFF，其余默认 ON
  runtime: JobRuntimeSpec
  meta: Record<string, any>
}
```

- [ ] 持久化 `jobs.json`（`version: 2`）+ `CronJobState{next_run_at, last_run_at, last_status, last_error}` + `CronJobExecutionRecord{run_at, status, error, trigger: scheduled|manual}`
- [ ] 调度器 + `misfire_grace_seconds` 错失宽限
- [ ] `[实证]` qwenpaw 的一个细节：crontab 第 5 段（day-of-week）数字编号与 APScheduler 不一致，**在校验期归一化成缩写**（`mon`…`sun`）绕开歧义 —— TS 侧用 cron 库时注意同样问题
- [ ] 执行投递：`dispatch.mode = stream | final`（流式推 vs 只推最终）

**Exit**：能配一条「每天 9:00 提醒我 todo」，到点 agent 真的跑并推到正确会话。

---

### M6 · Memory + Heartbeat + Wiki（2 周）→ 需求 6

这是**最需要先讨论清楚**的一块，因为它是产品差异化的核心。

**Heartbeat（cron 的升级版）** —— qwenpaw 的机制 `[实证]`：

```ts
HeartbeatConfig {
  enabled: boolean = false
  every: string = "6h"            // 支持 "30m" / "1h" / "2h30m" / "90s"
  target: string = "main"          // main | last | inbox
  timeout_seconds: number = 300    // 上限 3600
  active_hours?: { start: "08:00", end: "22:00" }   // 只在活跃时段内跳
}
```

**与 cron 的本质区别** `[实证]`：heartbeat **不是跑任意任务，而是把 `HEARTBEAT.md` 当作 query 交给 agent**。
→ 也就是说 **heartbeat 的"任务"是用户/agent 可编辑的一个文件**，可以随时改它想让 agent 定期想什么。这是很优雅的设计，建议直接采用。

**Wiki（Karpathy LLM Wiki 模式）** —— 原文要点 `[实证]`：

- **三层架构**：
  1. **Raw sources** —— 你策展的原始文档，**不可变**，是 source of truth。LLM 只读不写。
  2. **The wiki** —— LLM 生成的 markdown 目录。**LLM 完全拥有这一层**。摘要页、实体页、概念页、对比页、overview、synthesis。
  3. **The schema** —— 一个文档（`CLAUDE.md` / `AGENTS.md`）告诉 LLM wiki 的结构、约定、工作流。**"这是关键配置文件 —— 它让 LLM 成为一个有纪律的 wiki 维护者而不是通用聊天机器人。"**
- **三个操作**：
  - **Ingest**：读源 → 讨论要点 → 写摘要页 → 更新 index → 更新相关实体/概念页 → 追加 log 条目。**「一个源可能触及 10-15 个 wiki 页」**
  - **Query**：搜相关页 → 读 → 带引用综合回答。**「好的回答应该被归档回 wiki 成为新页」** —— 探索和 ingest 一样能复利
  - **Lint**：周期性体检 —— 页间矛盾、被新源取代的陈旧论断、无入链的孤儿页、被提及但没有独立页的重要概念、缺失的交叉引用、可用 web search 填补的数据缺口
- **两个特殊文件**（**这是"文件夹管理"之外最重要的两个索引**）：
  - `index.md` —— **内容导向**：全 wiki 的目录，每页一行链接 + 一句话摘要（+可选日期/源数），按 category 组织。**每次 ingest 都更新**。回答 query 时**先读 index 再下钻**。`[实证]` 卡帕西原话：「在中等规模（~100 源、数百页）下工作得出奇地好，且避免了 embedding RAG 基础设施」
  - `log.md` —— **时间导向**：append-only 的变更流水。技巧：每条用统一前缀 `## [2026-04-02] ingest | Article Title`，于是 `grep "^## \[" log.md | tail -5` 就能拿到最近 5 条
- **wiki 本体就是一个 markdown 的 git 仓库** → 版本历史、分支、协作全都白拿
- 图片要本地化（LLM 不能一次读完带内联图片的 markdown；先读文字，再单独 view 图片）

**你自己的 llm-wiki 项目已有可复用的具体化** `[实证]`（`E:/llm-wiki`）：

- 目录约定：`wiki/summaries/` 摘要页 · `wiki/entities/<type>/` 实体页 · 另有 `overview / index / log`
- `SCHEMA.md` 就是一个声明式本体：
  ```yaml
  version: 1
  entity_types:
    paper: { label: 论文, folder: wiki/entities/paper/, parent: publication,
             fields: [{name: venue, type: string}] }
    person: { label: 人物, folder: wiki/entities/person/ }
  relations: [{key: 对比, label: 对比}, {key: 引用, label: 引用}]
  page_roles: { summary: wiki/summaries/ }
  ```
- **编译任务包**（`api/services/compile_brief.py`）的设计很值得抄：
  - 待编译 raw 清单（**只给前 2000 字预览，全文由 agent 用 `read_document` 惰性读取**，不进任务包）
  - `SCHEMA.md` 全文（缺失则生成默认）
  - 实体类型与目录约定
  - 已存在 wiki 页清单 + **已编译 source 对照**（以 wiki 页 frontmatter 的 `source:` 为准，而非文件名推断）
  - → 这是「给 agent 一个任务包而不是塞满上下文」的好范式

**本里程碑任务**：

- [ ] `HEARTBEAT.md` + `HeartbeatConfig` + 活跃时段 + target 三态（main/last/inbox）
- [ ] wiki 目录骨架：`raw/`（不可变）· `wiki/index.md` · `wiki/log.md` · `wiki/summaries/` · `wiki/entities/<type>/`
- [ ] `SCHEMA.md` 声明式本体 + 前端可视化编辑
- [ ] **编译 prompt / 剧本**（Ingest 的完整流程 + 每次 ingest 更新 index + 追加 log）
- [ ] **Lint 周期任务**（挂在 heartbeat 或 cron 上）—— 矛盾检测、孤儿页、缺页、陈旧论断
- [ ] Query 答案回填 wiki 的通道
- [ ] 时间设置：wiki 编译用 cron（如每天 23:00），lint 用 heartbeat（如每 6h 在 08:00–22:00 内）

**Exit**：丢一个文档进 `raw/`，agent 能把它编译进 wiki 并更新 index/log；定期自动 lint。

---

### M7 · 文件系统（1 周）→ 需求 7

直接对齐 qwenpaw 的 workspace 布局 `[实证]`：

```
<working-dir>/
├── config.json
├── workspaces/<agent-id>/
│   ├── agent.json              # 智能体配置
│   ├── chats.json              # 对话历史
│   ├── jobs.json               # 定时任务
│   ├── token_usage.json
│   ├── AGENTS.md / SOUL.md / PROFILE.md   # 人设（system prompt 来源）
│   ├── MEMORY.md               # 长期记忆
│   ├── skills/ · skill.json    # 技能
│   ├── memory/                 # 每日记忆
│   └── todos.json              # ← 本项目新增
├── wiki/                       # ← 本项目新增（raw/ + wiki/）
└── skill_pool/
```

- [ ] 用 `CompositeBackend` 组合：真实文件系统（人可读的配置/wiki/todo）+ 虚拟 `StateBackend`（会话内临时文件）
- [ ] 路径约束到沙箱根；保护 `AGENTS.md` 等（`[实证]` qwenpaw `commands.zh.md:359` 把人设与技能运行文件列为**排除项**）
- [ ] `system_prompt_files` 配置项
- [ ] 密钥单独目录（qwenpaw：`~/.qwenpaw.secret/{providers.json, envs.json}`）—— 别和 workspace 混在一起

**Exit**：workspace 布局稳定；agent 读写文件受沙箱约束；人能在前端文件树里看。

---

### M8 · 前端（贯穿 M0–M9，2–3 周）

**对话 UI**（LangChain v1 范式，见 D2）：
- [ ] streaming 文本（渲染 `messages` 而非 `values`——`[实证]` `values` 只在每个 superstep 后整轮更新）
- [ ] 工具调用卡（`stream.toolCalls` 已是解析好的 `AssembledToolCall`）
- [ ] interrupt 审批卡（`stream.interrupt` + `respond()`）
- [ ] 子 agent 折叠卡（scoped `useMessages(stream, subagent)`，见 M3）
- [ ] time-travel 编辑分叉（`useMessageMetadata` → `parentCheckpointId` → `submit({forkFrom})`）
- [ ] 提交队列（`multitaskStrategy: "enqueue"` + `useSubmissionQueue`）
- [ ] todos 列表（`stream.values.todos`）

**整机信息架构**（OpenDesign 形态）`[实证]`：
- [ ] 三栏：单条 CSS grid，聊天栏宽度用 **`@property` 注册的自定义属性**驱动，靠 grid track 动画展开/收起（200ms 进 / 140ms 出）；分隔条 `role="separator"` + 键盘可操作 + `localStorage` 持久化
- [ ] 消息渲染顺序（有明确产品语义）：`事件 → buildTurnBlocks → shell/prose 交替 → FileOpsSummary → 收尾行 → NextStepActions`
- [ ] composer：Lexical（PlainText + 自定义命令）、可移除 chip、附件、models 选择器 + **可用性状态点**
- [ ] 「下一步动作」按钮组（只填词，不发请求）
- [ ] 列表虚拟化（OpenDesign 阈值 80 条 + 自研 `useMeasuredVirtualWindow`）

**设计令牌** `[实证]`：三层结构 —— 全局 `tokens/material/base` → `ChatRoot.module.css` 的 `--chat-*` **接缝层** → 组件 CSS Modules。**组件只认 `--chat-*`**，这样换主题只改接缝。
（OpenDesign 最有借鉴价值的一层就是这个接缝）

**非对话页**：
- [ ] Todo Web（M4）
- [ ] 运维面板：cron 列表/表单、heartbeat 配置、`HEARTBEAT.md` 编辑
- [ ] wiki 浏览（index 树 + 页渲染 + 图谱可选）
- [ ] 文件树 + `SCHEMA.md` / `AGENTS.md` 编辑
- [ ] 技能/子 agent 管理（含**同侪互交按钮**）

---

## 4. 必须避开的坑（来自三份调研）

1. **`interruptOn` 没有 `checkpointer` 就不生效** —— HITL 静默失效
2. **不要把子 agent 消息混进主 transcript** —— 既是官方设计也是性能边界（ref-counted scoped 订阅）
3. **别用 v0 的 hook 用法** —— `@langchain/langgraph-sdk/react` 的 `branch/setBranch` 已删；agent-chat-ui 仍是 v0，**只可参考视觉，不可参考 API**
4. **`values` 不是 token 级** —— 要流式必须渲染 `messages`
5. **`optimistic` 默认 true、`multitaskStrategy` 默认 `rollback`、`stop()` 默认 cancel** —— 三个默认值都要显式检查
6. **`stream.subagents` 的 key 与 scoped `useValues` 不自动收窄** —— 预留 wrapper
7. **`permissions` 声明序首匹配 + 默认宽松** —— 想收紧必须先写宽规则再写 deny
8. **`memory`（AGENTS.md）在启动时载入** system prompt，不是每轮重读
9. **默认不能静默丢消息** —— qwenpaw 有两处只留 warning（队列满超时、热替换窗口）。**我们要加背压或死信**
10. **"注入用户消息" ≠ "注入 system prompt"** —— qwenpaw 的 `MASTER_PROMPT` 是改写 `input_msgs[-1]`，缺 system 级持久性。人设类内容必须走 system prompt
11. **安全模型是 "trust the LLM"** —— deepagents README 原话；边界要建在工具/沙箱层
12. **Tailwind 装了不等于接上了** —— OpenDesign 的实证

---

## 5. 待确认 / 未验证

| # | 事项 | 状态 |
|---|---|---|
| 1 | **D1** 自研 createAgent 子 agent 独立 checkpoint 的可行性 | `[推测]` 需 spike |
| 2 | **D2** 前端 UI 基调（OpenDesign 结构 + QwenPaw 密度？） | 待你拍板 |
| 3 | `SubagentDiscoverySnapshot.status` 是否真会出现 `"pending"` | 类型有，未跑真机 |
| 4 | `stream.subagents` 的 `id` 是否恒等于 spawn 它的 tool-call id | 文档示例佐证，未逐行确认 |
| 5 | 需求 8「同侪互交」按钮的确切语义 | 你说后面讨论 |
| 6 | `qmd`（本地 markdown 混合检索）是否值得引入 | 规模到了再说；先靠 `index.md` |
| 7 | 会话压缩用 qwenpaw 的 scroll 策略还是 LangGraph 原生 | 倾向 scroll，需验证 TS 侧实现成本 |

---

## 6. 时间线

```
M0 地基+Spike        1w   ████
M1 Manager 内核      1.5w ██████
M2 会话/压缩         1.5w ██████
M3 子 agent 系统     2w   ████████
M4 Todo              1w   ████
M5 Cron              1w   ████
M6 Memory/Heartbeat/Wiki  2w ████████
M7 文件系统          1w   ████
M8 前端              与 M1–M7 并行
                     ─────────────
                     合计 ≈ 11 周（前端并行）
```

---

## 附录 · 一个前端类型骨架（示例，待 M0 定稿）

```ts
// packages/contracts/src/index.ts

export interface Todo {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "low" | "normal" | "high";
  due?: string;
  tags?: string[];
  parent?: string;
  notes?: string;
  source: "user" | "cron" | "heartbeat" | "agent";
  createdAt: string;
  updatedAt: string;
}

export interface SubAgentSpec {
  name: string;
  description: string;
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  skills?: string[];
  /** 需求 8：是否允许与同级 agent 交互。默认 false。语义待定 */
  allowSiblingInteraction: boolean;
  /** D1：是否需要独立 checkpoint/thread（决定走 sync 还是 async） */
  isolatedCheckpoint: boolean;
}

export interface HeartbeatConfig {
  enabled: boolean;
  every: string;              // "6h" / "2h30m" / "30m"
  target: "main" | "last" | "inbox";
  timeoutSeconds: number;     // <= 3600
  activeHours?: { start: string; end: string };
}
```