## Context

本设计建立在三个已定前提上：

- **`add-custom-agents` 已定数据层**：agent 定义在 agents 根、工作区绑定 agent（一工作区一 agent）、会话落 `<工作区>/.open-assistant/sessions.sqlite`
- **产品形态已定**：一个「个人学习与生活助手」，核心角色为总控编排 / 待办排程 / 编程学习 / 健身训练 / 饮食营养 / 复盘分析
- **用户已拍板**（本变更的输入）：① 画布要，但**只做只读观测型**；② 主 agent 通过 deepagents 原生 `subagents` 调用来完成任务即可，**不需要**调平台的 `ask_agent`；③ 先写 spec 再动手；④ 生活工作区在 E 盘新建一个独立目录；⑤ 采用**架构 A**（单主 agent + N 子 agent）

### 术语

| 词 | 含义 |
|---|---|
| **主 agent** | 工作区绑定的那个 agent，用户的唯一出口 |
| **子 agent** | 主 agent 图内的 `SubAgent`，由 `task` 工具调起，不是平台的 agent，**没有**自己的工作区绑定 |
| **平台 agent** | agents 根下注册、可绑定工作区的 agent（`add-custom-agents` 的产物） |
| **团队** | 一个主 agent 声明的全部子 agent |

本变更的**全部**工作都发生在「主 agent 与子 agent」之间。平台 agent 之间的调用（`ask_agent` / `ask_peer`）不在范围内。

---

## D1. 通信方向：只用同轮委派（`task`）

`multi-agent-comms` 定义了三个方向，本变更**只启用第一个**：

| 方向 | 触发 | 本变更 | 理由 |
|---|---|---|---|
| ① 同轮委派 | `task` | ✅ **启用** | 主 agent 路由给子 agent 并合并结果，正是本产品的核心动作；同轮完成、结果回流、用户只有一个出口 |
| ② 跨工作区调用 | `ask_agent` | ❌ 不启用（保留定义、默认关） | 它解决的是「多个独立 agent 各自一份工作区与记忆」。本产品的数据（待办 / 日志 / 计划 / 配置）**本就应当在同一个生活工作区里共享**；切成多工作区会让「复盘要读训练日志」变成跨工作区难题 |
| ③ 同侪互通 | `ask_peer` | ❌ 不启用（保留定义、默认关） | 同上；且子 agent 的协作可以经主 agent 汇合，不需要横向对话 |

> `gateTool()` 已实现 `ask_peer` 的同侪开关门控，`contactableAgents` 也已存在。**不启用 ≠ 删除**：配置项与门控保留，默认值不变，将来若真出现「某领域需要独立长期记忆」的场景可以再打开。

---

## D2. 团队定义放在哪：**agents 根，不是工作区**

```
<agents 根>/
  zhangsan/
    config.json
    AGENTS.md / SOUL.md / PROFILE.md
    memory/
    skills/
    team/                      ← 新增
      programmer/SPEC.md
      trainer/SPEC.md
      nutritionist/SPEC.md
      reviewer/SPEC.md
```

**为什么放在 agent 定义下、而不是工作区下**：

1. **团队是 agent 的结构，不是数据的结构**。「这个助手有哪几个专职子 agent」属于助手的定义，换工作区不该换掉它。
2. **拓扑稳定性**（见 D3）：团队随工作区变，就意味着「同一张图在不同请求上下文下有不同的 subagents」，这在 LangGraph 里是**有风险**的（见 D3 的两种假设）。放在 agents 根下，团队由 agent 决定；而因为一个工作区绑一个 agent，运行期仍然是确定的。

**唯一例外**：子 agent 的**文件操作落哪个工作区**由运行期 `configurable.workspace` 决定（沿用主 agent 已有的 backend 工厂做法），所以一套团队可以服务多个工作区，读写的却是各自的数据。

---

## D3. 拓扑稳定性与生效边界（**已判定：假设 A 成立**）

> 结论来自 2026-10-01 的 P0 spike，全部用**脚本化模型**（`ScriptedModel` 继承 `BaseChatModel`，按脚本返回带 `tool_calls` 的 `AIMessage`）跑通，**不需要 API key**。
> 脚本：`C:\Users\wt197\.copaw\workspaces\default\spike\probe-*.ts`；报告与原始日志：`spike/findings/01-delegation.md`、`02-topology.md`（+ 同名 `*.log`）。

### 判定结果 `[实证]`

**改 `subagents` 数组不属于图拓扑变化。重建图后，同一个 thread 可以直接用新团队续跑 —— 不报错、不状态错乱、新子 agent 立刻生效。**

| 场景 | 结果 |
|---|---|
| S0 对照：配置不变、同 thread 第二轮 | OK（证明 resume 路径本身通） |
| S1 扩员：`[trainer]` → `[trainer+nutritionist]`，同 thread | OK；新图只调用 `nutritionist`（`trainer` calls=0），**新团队即时生效** |
| S1b 来回切 V1→V2→V1，同 thread | OK（反复改不累积损坏） |
| S2 缩员：`[trainer+nutritionist]` → `[trainer]`，同 thread | OK |
| S4 旧 thread 在新图下可读 | OK（`getState` / `getTuple` 均正常） |

### 为什么是假设 A

- `[实证-源码]` 子 agent 是 `runTask()` 里一次普通的 `subagent.invoke()`（`deepagents/src/middleware/subagents.ts:893-901`，`configurable` 继承父配置）——**不参与父图建图**。父图的节点/边/通道 schema 不随 `subagents` 变化，旧 checkpoint 可直接被新图加载。
- `[实证]` `subagents` 只影响两样东西，且两样都在建图期重新生成：`task` 工具的 description（列给模型看的成员清单）与 `runTask` 的查找表。S6 实测：换图后描述里的成员清单立刻是新团队。
- `[实证]` 子 agent **确实**产生子图命名空间（`tools:<uuid>`，里面装的正是子 agent 自己的对话），但该命名空间是**「父图里那次工具调用的执行位置」的函数**，**与团队名单无关**：命名空间 = 节点名 + `:` + `uuid5(节点名, super-step, task 路径, 父 checkpoint id)`（`@langchain/langgraph/dist/pregel/algo.cjs:259,264-273`）。三条反证：同一个 `trainer` 换轮/换 thread 得到不同 uuid；一轮里并发派 2 个子 agent 得到 2 个 uuid；ns 里搜不到 `trainer`。

### 假设 B 的事实前提被证伪

作业里提到的 `resolveSubagentNamespaces` **不在 deepagents**：deepagents 1.14.1 运行时 56 个导出中含 namespace 的为 `[]`。它属于 **`@langchain/langgraph-sdk@1.12.0`** 的**客户端流式发现**模块（`dist/stream/discovery/namespace-from-history.js`），签名入参是 **`toolCallIds`**（不是子 agent 名），用途是把 tool_call 关联到子图做 UI 关联 —— 不是服务端语义，也不构成跨图恢复的约束。

### 真实的边界（**这条产品必须兜底**）

| 场景 | 同 thread 改团队 | 依据 |
|---|---|---|
| thread **空闲**（`next=[]`，无未完成 task） | ✅ 直接可用 | S1/S1b/S2/S3/CASE D |
| 有 pending task，且引用的子 agent **仍在新团队里** | ✅ 可 resume | CASE A（控制组：pending 本身无害） |
| 有 pending task，且引用的子 agent **被删 / 改名** | ❌ **持续失败，会话卡住** | CASE B / CASE C |
| 有 pending task，子 agent 还在但 `systemPrompt`/`tools`/`model` 改了 | ⚠️ **未测**（旧 tool_call 会用**新定义**重放） | — |

卡住的实证形态（连发 4 次消息全失败，resume×2 + 新消息×2）：

```
Error: invoked agent of type trainer, the only allowed types are `general-purpose`, `nutritionist`
  at runTask (deepagents/dist/langsmith-Bgi_Ta-k.js:3915)
```

**恢复办法（已验证）**：把该子 agent 加回去即立刻恢复，数据没坏、只是卡住。这也说明它与「图拓扑」无关，纯粹是**历史 tool_call 被重放**时名字对不上。

### 落地要求

1. **`agent.ts` 的图出口必须改成工厂函数。** 现在是模块级一次性求值的**对象**导出（`langgraph.json` → `./src/agent.ts:agent`）。`@langchain/langgraph-api/dist/graph/load.mjs:45-60`：函数导出每次 `getGraph` 都重建，对象导出则一直用那一份。改成工厂后**改配置免重启即时生效**，且 `checkpointer` 由平台注入同一实例，**重建图后 thread 数据仍接得上**（正是 S1 在真实架构下的对应形态）。
   - 本条目前是 `[实证-源码]`，未在真实 server 上跑端到端。升级实验见 tasks 5.1。
2. **前端文案不能写「请开始新会话」**，正确语义是「团队已更新，本对话可直接继续」——与「换模型」的体验一致。
3. **删除/改名子 agent 时必须兜底卡住的会话**（见 tasks 5.3）：提示出路，或服务端在 `runTask` 失败时把 pending task 清掉/写回错误 `ToolMessage` 让图继续，或保留一段时间的「墓碑定义」。

### 未验证项（诚实清单）

- `mode: "fork"` 的子 agent 的拓扑行为（预期同样不改变父图，未实测）
- 子 agent 的 `interruptOn`（HITL）中断 × 团队变更
- 真实 server 端到端（本实验用 `MemorySaver` + 直接 `agent.invoke`，未跑 `langgraphjs dev`）
- 生产 `@langchain/langgraph-checkpoint-sqlite` 下的同构行为（命名空间逻辑在 `pregel/algo.cjs` 核心层，与 saver 实现无关，**预期**一致）

---

## D3b. 委派机制的实证边界（同等重要，直接改写了 Requirement）

> 详见 `spike/findings/01-delegation.md`。以下每条都推翻了原先的默认假设。

### 1. 失败**不是**隔离的 —— 一个子 agent 抛错 = 整轮中止 `[实证]`

- 子 agent 模型 throw → `agent.invoke()` **REJECTED**；`main calls = 1`，主 agent **从未被第二次调用**，拿不到任何失败信息。
- **并发场景下，兄弟子任务已算出的结果一并丢弃。** 所以「用并行 + 部分失败」来做容错**是无效的**。
- 机制：deepagents 必带 `wrapToolCall` 中间件 → `ToolNode.js:281` 以 `isMiddlewareError=true` 处理 → `:152` 判的是 `handleToolErrors !== true`，而默认值是**函数**不是 `true` → 一律 rethrow。langchain 那套「错误转 `status:"error"` ToolMessage 让模型自愈」的机制**永不生效**（唯一例外：根因是入参 schema 校验失败 `ToolInvocationError`）。
- **对照组更关键**：主 agent **自己的普通工具**抛错同样掀翻整轮（`§3.6`）。影响面比「子 agent 容错」更广 —— 这是**系统级**行为。
- **缓解方案已验证**：把子 agent 的**模型**包成「永不抛出」（异常转成普通 `AIMessage`）→ 主 agent 正常收到 ToolMessage 并完成。代价是失败变成「一段普通文本」，只能靠约定前缀识别。⇒ 已写进 spec「执行失败的隔离与呈现」。

### 2. `isolated` 隔离的是**对话**，不是**工作区** `[实证]`

子 agent 完整继承父 agent 的文件工作区：能读到父刚写的文件，其写入也回流到父 state。`filterStateForSubagent` 的 `EXCLUDED_STATE_KEYS`（`:3583`）剔除了 `messages`/`todos`/`skillsMetadata` 等，但 **`files` 不在其中**。
⇒ **这正是「架构 A」选型的直接依据**，已在 spec 里写成正式 Requirement（子 agent 与主 agent 共享工作区文件）。

### 3. 回流给主 agent 的**只有最后一条 AI 文本** `[实证]`

`returnCommandWithStateUpdate`（`:3726`）从子 agent 结果里取最后一条有文本的 `AIMessage`；找不到就用兜底字符串 `"Task completed"`。
⇒ 子 agent 中间的工具调用过程**不回流**。`description` 必须明确要求「把结论写进最终回复」。

### 4. 回流顺序 = **请求顺序**，不是完成顺序 `[实证]`

同一条 `AIMessage` 的多个 tool_call 走 `Promise.all`，保持输入顺序（慢 600ms 的仍排在快 150ms 的前面）。
⇒ 不能用「第几条结果」判断完成先后。

### 5. `general-purpose` 是免费赠送且关不掉的子 agent `[实证]`

`task` 工具描述里默认列着它：**用主 agent 的模型、拥有全部工具**，描述写得很有吸引力。`createDeepAgent` 的解构参数里**没有**关闭它的入口。
⇒ 主 agent 手里永远多一个会跟专用子 agent **抢活**的通用子 agent。已写进 spec「内置通用子 agent 的处置」（要求把它作为「运行时内置成员」显式列出）。

### 6. `mode: "handoff"` 是被静默接受的幽灵值 `[实证]`

源码校验特意放行它（`:3842`），类型定义里没有，行为与 `isolated` **逐字节一致**，不报错也不提示。非法值才会报错（`must be "isolated" or "fork"`）。
⇒ 本系统自己校验，拒绝 `handoff`。已写进 spec。

### 7. 显式 `systemPrompt` 会**完全替换**运行时的内置提示词 `[实证]`

传了 `systemPrompt` 之后，主/子 agent 的 system message 就**正好是给的那段文本**，deepagents 内置的基础提示词**一个字都没出现**。
⇒ 主 agent 与子 agent 的系统提示词都必须**自包含**。已写进 spec。

### 8. 说明性隔离（供实现时参照）

| 模式 | 子 agent 看到什么 | 能否再委派 |
|---|---|---|
| `isolated`（默认，推荐） | `[自己的 systemPrompt, human(description)]`，description **逐字**、无包装 | 工具集里**没有** `task`（结构性防递归） |
| `fork` | system = 父 + `\n\n` + 自己（**追加**）；messages = 父对话 + `[preamble + description]`；发起委派的那条 AIMessage 被剥掉 | **有**镜像 `task`，被 `FORKED_CONTEXT_KEY` 运行时拦截 |

> fork 会带上一整个父对话的 token 成本，且官方标注实验性。**本变更只用 `isolated`。**

### 9. 对本变更 Requirement 的净影响

| 原 Requirement / 假设 | 处置 |
|---|---|
| 「单个子任务失败不拖垮整轮」 | ❌ **被推翻** → 改写为「执行失败的隔离与呈现」，并要求**由我们自己在模型层实现**软失败包装 |
| 「进行中的会话不受损」二选一未定 | ✅ 判定：**下一轮直接用新团队**（假设 A） |
| 上下文隔离 | ⚠️ 补上「只隔离对话、不隔离工作区」 |
| 子 agent 能力边界 | ✅ 保持；补充 isolated 是结构性防递归、fork 是运行时拦截 |
| — | ➕ 新增：内置通用子 agent 的处置 / 回流顺序 / 只回流最终文本 / 委派给不存在的子 agent / 系统提示词自包含性 |

---

## D3c. 机制选型已定案：原生 `subagents` + `agent.ts` 工厂函数（**原「自研 task 工具中间件」方案作废**）

> **P0 已定案**（用户拍板，2026-10-01）。本节是给后来者的**防误读**说明。

**采用**：deepagents **原生** `subagents` 数组 + 把 `apps/server/src/agent.ts` 的图出口从**对象**改为**工厂函数**（见 D3 落地要求 1）。

**作废**：原设计稿 §7.2 / §7.3 提出的「**自研 `task` 工具中间件**」方案（自己实现委派工具、自己管子 agent 生命周期与结果回流）—— **本变更不采用，已作废**。后人 MUST NOT 照旧方案实现。

**作废理由**：

1. **原生路线无契约冲突**。`02-topology.md` 已实证「改 `subagents` 数组**不属于图拓扑变化**」：子 agent 在 `task` 工具内部被 `subagent.invoke()`，**不参与父图建图**，父图节点/通道 schema 不变，旧 checkpoint 可直接被新图加载，同一 thread 换团队可直接续跑（`02-topology.md` §2、§4、§8）。自研中间件当初的唯一动机是「怕换团队要换会话」——**这个前提已被证伪**。`[实证-02]`
2. **简单得多**。原生路线只需两处改动：① 解析 `SPEC.md` → 组装 `subagents` 数组（tasks 第 1 节）；② `agent.ts` 改工厂函数（tasks 5.1）。自研中间件则要自己复刻委派工具、结果回流、子会话隔离等一整套语义，且会与 deepagents **必带**的 `wrapToolCall` 中间件栈相互作用（D3b §1 的「快速失败」语义正是这套栈的产物），**引入额外的契约风险**。`[推测]`
3. **原生路线已被 P0 实证覆盖，自研方案零实证**。上下文隔离（D3b §2）、并行真并发（`01-delegation.md` §2.1–2.2）、结果回流形态（§2.2）、失败语义（§3）这些边界，都已用脚本化模型在原生路线上实测过。`[实证-01]`

**仍然保留的自研部分**（因为底层不提供，见 D3b §1）：子 agent 的**模型层软失败包装**（tasks 5.2）。这不是「自研 `task` 工具」，只是给子 agent 的模型加一层 try/catch 包装，把异常转成一条普通结果。

---

## D4. 团队管理界面：只编辑三个字段

`SubAgent.description` **就是路由依据**——模型是看着它决定把任务派给谁的。所以 L2 角色层真正要编辑的东西只有：

| 字段 | 为什么是它 |
|---|---|
| `description` | 路由依据，改它 = 改"什么任务该派给谁" |
| `tools` | 能力边界，改它 = 改"能干什么" |
| `model` | 成本与质量，改它 = 改"谁用什么模型" |

`systemPrompt`（正文）用 Markdown 编辑器（与既有 `AGENTS.md` 编辑体验一致）；`skills`、`mode` 属于进阶项，放折叠区。

**不在这页做**：拓扑连线、拖拽、新增/删除子 agent 的图形化操作——新增/删除子 agent = 建/删目录，用「新建子 agent」按钮 + 目录名输入即可。

---

## D5. 画布：只读观测型（用户拍板）

**是什么**：把一轮里主 agent 与子 agent 的编排结构渲染成图。

**不是什么**（硬约束，写进 spec）：
- 不能在画布上新建 / 删除 / 连线节点
- 不能用画布改执行顺序
- 不是流程编排器（L3 日程编排是另一个东西，本变更不做）

**画的是什么**：

```
        ┌─────────────┐
        │  主 agent   │  ← 根节点，永远存在
        └──────┬──────┘
       ┌───────┼───────┐         边的语义 = "这一次 tool call 派发的"
       ▼       ▼       ▼
  ┌────────┐┌────────┐┌────────┐
  │trainer ││nutrition││program │   节点状态 = running / success / error
  │ ✅     ││  ⏳    ││  ❌    │
  └────────┘└────────┘└────────┘
```

- **节点** = 主 agent（1 个）+ 本轮出现过的子 agent（0..N）
- **边** = 派发它的那次 tool call（用 `tool_call_id` 做外键，和消息流里的 `task` 调用对齐）
- **状态** = 进行中 / 成功 / 失败；**直接映射 SDK 的 `SubagentStatus`**（`pending | running | complete | error`），不自造状态机 `[实证-03 §2v1]`
- **并行** = 同一条消息里的多个 `task` tool call → 并排的子节点
- **交互** = 点节点展开该子 agent 的会话；点边高亮对应的 tool call

---

## D6. 画布数据从哪来（**已定案：v1 + v2 同源为主，v0 降级兜底**）

> 结论来自 `spike/findings/03-canvas-datasource.md` §2–§3（只读观测，仓库零写入）。

**关键判断**：v1 与 v2 **不是二选一，而是同一条代码路径**。`@langchain/langgraph-sdk@1.12.0`（本项目实际安装版本；`apps/web/package.json:20` 声明 `^1.0.3`）的 React 层 `useStream` 已内置 `subagents` 管理器：同一个管理器既做**实时发现**（v1），又在历史重开时用 `reconstructSubagents` + `fetchSubagentHistory` 自动**重建**（v2）。激活它的开关只有一个：`filterSubagentMessages: true`。`[实证-03 §2v1,§2v2]`

| | 数据源 | 承担 | 结论 |
|---|---|---|---|
| **主** | `useStream` 的 `subagents`（`SubagentStreamInterface`，`@langchain/langgraph-sdk@1.12.0 dist/ui/types.d.ts:212`） | 实时发现（v1）+ 历史重开自动重建（v2），**同源** | ✅ **采用** |
| **兜底** | `task` tool call 派生（前端 `ChatMessage.tsx:58-79` 的 `toSubAgents`） | SDK 无该节点时（无 `threadId` / 老轮次 / `subagents` 为空）只能显示 `description` + 最终 output 摘要 | ⚠️ **降级兜底** |

**只差两个 option**（本项目现在一个都没设 —— `useChat.ts:59-70` 只传了 `client / reconnectOnMount / fetchStateHistory / onError`）`[实证-03 §2v1]`：

1. **`filterSubagentMessages: true`（必加）**：默认 `false`，此时 `ui/orchestrator.js:102` 把 `undefined` 直接透传，`orchestrator.js:538` 的守卫 `if (!(this.#options.filterSubagentMessages && …)) return null` 命中 → **永远不会构建 subagents 映射**。不设这个开关，v1/v2 都拿不到东西（`ui/types.d.ts:904,1004`）。
2. **`streamSubgraphs: true`**：默认 `false`，不设则 langgraph 不会把子图 namespace 的 `messages` 事件推给客户端 → 子 agent 节点在**运行中**的会话是空的（状态与结果仍靠 tool message 得到）。要「点节点展开子会话（含运行中）」就必须加（`ui/types.d.ts:935-937`）。

**要改的文件（文件级，见 tasks 第 4 节）**：`useChat.ts:59-70`（加两个 option，**唯一必改的接线路**）、`ChatProvider.tsx`（透出 `subagents / activeSubagents / getSubagent / getSubagentsByMessage`）、`ChatMessage.tsx:58-79`（`toSubAgents` 改为优先取 `getSubagentsByMessage`）、新增画布组件。**零服务端改动**（langgraph dev 的 platform API 本来就返回子图事件，子图 checkpoint 已在内存 saver 里）。`[实证-03 §3]`

**两条必须写死的守卫** `[实证-03 §2v2,§3]`：

- **`namespace` 必须来自 SDK 的 `SubagentStream.namespace`，不能自己拼 `tools:<tool_call_id>`**：子图 `checkpoint_ns` 是 `节点名 + ":" + uuid5(节点名, super-step, task 路径, 父 checkpoint id)`，其中的 uuid **≠ tool_call_id**（`@langchain/langgraph/dist/pregel/algo.cjs:259,264-273`；与 `02-topology.md` §5.2–5.3 的实测一致）。取子会话历史要 `client.threads.getHistory(threadId, { checkpoint: { checkpoint_ns } })`（`api/threads.mjs:118` 的 POST 支持带 ns；**GET 永远强制 `""`**）。
- **不要自己重写 checkpoint 反推**：SDK 已实现「先按 `${task.name}:${task.id}` 猜、失败则用 push 顺序兜底」的两阶段对齐（`ui/subagents.js` 注释），自己重写只会在**并行 tool call** 的顺序对齐上重新踩坑。

**v0 为什么只能兜底**：子 agent 的会话只存在于子图命名空间；deepagents 的 `task` 工具**不会**把子 agent 的内部消息回灌主图 —— `returnCommandWithStateUpdate()` 返回的 `Command.update` 把 `messages` 覆写成**单条 ToolMessage（子 agent 最后一段文本）**，且 `filterStateForSubagent` 的 `EXCLUDED_STATE_KEYS` 显式排除 `"messages"`。所以 v0 只能显示 input/output 摘要，**结构性地做不到**「点节点展开子会话」。`[实证-03 §1,§2v0]`

**拓扑快照仍要落库**（见 tasks 第 3 节）：v1/v2 解决「看得见 + 历史能重建」，但 checkpoint 是 `InMemorySaver` + JSON 快照、**不是数据库**（无索引/无查询，清理时可能丢），且「团队里删掉某子 agent 后旧 thread 会持续报错」（`02-topology.md` CASE B/C）使旧轮次**不可重放**。因此每条 thread 落一份本轮委派快照（`delegations` 表），画布读它做「拓扑冻结 + 跨会话列表/审计」，checkpoint 只作**内容源**。`[实证-03 §3,§4]`

---

## D7. 架构 A 下的定时任务

**现状（实证）**：定时任务是**工作区级**的，落 `<工作区>/.open-assistant/jobs.json`，调度器也按工作区启停（`jobs/store.ts:1-8`、`http.ts:394-400`）。因为一工作区绑一 agent，**事实上 = 每个 agent 一份**。

**架构 A 的含义**：7:30 早计划 / 22:30 复盘 / 周日周报**共用一个 `jobs.json`**。

**据此的约定**：

1. **任务只调度主 agent**，不直接调度子 agent。任务内容是给主 agent 的一段 prompt（`content.kind: "agent"`），由主 agent 决定要不要 fan-out 给子 agent。
2. **任务之间可以串联**：因为同一份文件、同一条流程线，周报任务可以读到当天复盘的产物（`logs/`、`current_plan.md`）。
3. **不新增 per-子agent 的定时任务机制**。若将来真需要「某个子 agent 独立定时跑」，用「主 agent 的一个任务 + prompt 里指明」表达即可。

> 这条**不改** `agent-scheduling` 的既有契约，只是把架构 A 下的用法写清楚。

---

## D8. 子 agent 的能力边界

- **受主 agent 的工具组开关约束**：主 agent 关掉某个工具组（如 `todos`），子 agent 也拿不到该组工具。
- **不具备再委派能力**：子 agent 的工具白名单默认**不含** `task` / `ask_agent`，这是**结构性**的（与 DeepAgents 一致，`design.md:189`），不依赖提示词自律。
  - 注意：`mode: "fork"` 的子 agent 会 splice `createForkTaskToolMiddleware`（可嵌套）——**本变更不使用 `fork` 模式**，除非有明确理由。
- **上下文隔离**：子 agent 默认只看到交给它的任务描述（`mode: "isolated"`），MUST NOT 看到主 agent 的完整对话历史。

---

## 与既有 capability 的关系

| Capability | 关系 |
|---|---|
| `multi-agent-comms`（未归档，属 `add-custom-agents`） | 本变更**启用**其「同轮委派」，「不启用」其「跨工作区调用 / 同侪互通」。因它是未归档的 ADDED capability，本变更不产出 MODIFIED 条目以避免 delta 冲突 |
| `agent-scheduling`（未归档） | 契约不变；D7 只是写明架构 A 下的用法 |
| `agent-registry`（未归档） | 本变更在 agent 目录下**新增 `team/` 子目录**，属于对既有目录约定的**扩展**；若后续归档时发现需要严格化，再补 MODIFIED |
| `agent-core`（已归档） | 主 agent 的对话循环不变 |

> ⚠️ **流程建议**：`add-custom-agents` 的 tasks 7.1–7.10 与本变更高度重叠。建议**先把 7.1–7.4（同轮委派）在本变更里做掉**，随后重新评估 `add-custom-agents` 是否可以归档（7.5–7.10 若长期不做，应明确标为「不做」而非留着未勾选）。

---

## Risks

- **[团队变更是否换会话]** → ✅ **已判定（D3）**：改 `subagents` 不算图拓扑变化，同一会话可直接续用新团队；唯一真实边界是「pending task 指向被删/改名的子 agent」，由 tasks 5.9 兜底。
- **[只读画布的数据源]** → ✅ **已判定（D6）**：v1 + v2 同源（`filterSubagentMessages: true` + `streamSubgraphs: true` 两个 option），v0 降级兜底。剩余 `[推测]` 只有「`streamSubgraphs` 在 langgraph dev 下对子图 `messages` 事件的实际效果」需一次探针确认（`03-canvas-datasource.md` 附「未确认项」）。
- **[机制选型]** → ✅ **已定案（D3c）**：采用 deepagents 原生 `subagents` + `agent.ts` 工厂函数；原「自研 `task` 工具中间件」方案作废。
- **[子 agent 默认不继承技能]** `[实证-03报告]`：自定义子 agent 默认拿不到主 agent 的技能 → 若要给子 agent 技能，必须在 `SPEC.md` 里显式声明（本变更在 spec 里写成显式字段）。
- **[`@xyflow/react` 的 zustand 4/5 共存问题]** issue #5685 未关闭 → 只读画布若不需撤销，**可以不引 `zundo`**，减少一处风险。
- **[画布在窄屏的可用性]** → 只读画布建议提供「图 / 列表」两种视图切换，列表视图是兜底。
