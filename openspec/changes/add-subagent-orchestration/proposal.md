## Why

`add-custom-agents` 已经把「agent 定义 / 工作区绑定 / 会话存储」定下来，并在 `multi-agent-comms` 里定义了三个方向的多 agent 交互；但其中**真正要用的是哪一个**、子 agent 的**团队怎么定义**、用户**怎么看懂一轮里发生了什么**，三件事都还没有答案。

具体缺口：

1. **子 agent 没有声明方式**。deepagents 的 `SubAgentMiddlewareOptions.subagents` 是**建图期静态数组**，现在只能写死在 `src/agent.ts` 里。要按「总控 / 待办排程 / 编程学习 / 健身训练 / 饮食营养 / 复盘分析」组织团队，必须有一个**声明式**的来源。
2. **三个通信方向里只需要一个**。产品形态确定为一个「个人学习与生活助手」：**一个主 agent + N 个子 agent，跑在同一个生活工作区里**。主 agent 用 deepagents 原生的 `subagents` / `task` 委派即可完成任务；`multi-agent-comms` 里的**跨工作区调用（`ask_agent`）与同侪互通（`ask_peer`）本变更不启用**（保留定义、保持默认关），因为它们解决的是「多个独立 agent 各带一份记忆与工作区」的问题，而本产品的数据（待办 / 日志 / 计划）本就应当共享在同一工作区。
3. **用户看不见编排**。委派发生时，用户只能读交错的原始事件流，看不出「谁把什么派给了谁、现在进行到哪、哪个失败了」。

因此需要一个变更：把子 agent 团队变成**可声明、可管理**的，并把一轮内的编排过程变成**可看的只读画布**。

## What Changes

- 新增**声明式团队定义**：每个 agent 目录下可有一个 `team/` 目录，每个子 agent 一个子目录，用 `SPEC.md`（YAML frontmatter + 正文）声明名称、路由描述、工具白名单、模型、模式与技能
- 新增**团队装载器**：把 `SPEC.md` 解析成 deepagents 的 `SubAgent` 描述符，注入主 agent 的建图过程；非法声明被标注而非拖垮整体加载
- 新增**团队管理界面（L2 角色层）**：列出 / 编辑每个子 agent 的**路由描述、工具白名单、模型**——这是可视化编排里唯一真正需要编辑的东西
- 新增**只读观测画布**：把一轮内的主 agent 与子 agent 渲染成节点与边，节点带执行状态，可展开对应子会话，**不提供任何编辑入口**
- 新增**拓扑数据的采集与持久化**：把本轮委派快照落进会话存储，用于拓扑冻结、跨会话列表与审计（刷新页面与重开历史会话的还原由 SDK `subagents` 同源重建承担，见 design D6）
- 明确**团队变更的生效边界**（**已定案**）：改团队**不属于图拓扑变化**，同一会话可直接续用新团队、新子 agent 即时生效；唯一需要兜底的是「上一轮残留 pending task 且其引用的子 agent 被删 / 改名」
- 明确**子 agent 的能力边界**：受主 agent 的工具组开关约束；子 agent 自身不具备再委派能力（结构性防递归，不依赖提示词自律）

**非目标（本变更明确不做）**：

- **不做编辑型画布**（拖拽产出可执行体）。画布只读。
- **不启用跨工作区调用（`ask_agent`）与同侪互通（`ask_peer`）**。二者的 capability 定义保留在 `multi-agent-comms`，配置项保持存在且默认关闭。
- 不做流程编排画布（L3 日程编排），留待后续变更。
- 不改 `jobs.json` 的「按工作区存放」契约（见 design 的架构 A 说明）。

## Capabilities

### New Capabilities

- `subagent-team`: 子 agent 团队的声明式定义与装载——`team/` 目录约定、`SPEC.md` 字段、装载与非法声明的处置、团队变更的生效边界，以及子 agent 的能力边界与委派语义
- `orchestration-canvas`: 只读观测画布——运行期拓扑的采集、节点与边的语义、执行状态呈现、与子会话的互跳、历史复现，以及只读性的硬约束

### Modified Capabilities

（无。）

`multi-agent-comms` 与 `agent-scheduling` 目前仍是 **`add-custom-agents` 中未归档的 ADDED Requirements**（`openspec/specs/` 下尚不存在这两个 capability）。为避免两个未归档变更同时改写同一 capability 造成 delta 冲突，本变更**不产出生效于它们的 MODIFIED 条目**，只在 design 里写明关系与不启用的理由（见 design「与既有 capability 的关系」）。

## Impact

- **后端**：
  - 新增 `team/` 扫描与 `SPEC.md` 解析模块（`apps/server/src/agents/team.ts` 一类）
  - `src/agent.ts` 的 `createDeepAgent` 由「写死 / 空 subagents」改为「从团队声明装载 `subagents`」；同时把图出口由**对象**改为**工厂函数**，使改团队配置免重启即时生效（依据：`spike/findings/02-topology.md` §7）
  - 新增拓扑采集：从运行事件中提取「主 → 子」的边与节点状态，并落进会话存储
- **前端**：
  - 新增 `/agents/[id]/team`（或子分栏）团队管理页
  - 新增编排画布组件（只读），挂载在对话页或独立入口
  - **新增依赖**：`@xyflow/react`、`@dagrejs/dagre`，以及 `zustand` + `zundo`（若画布需要本地状态与撤销；只读画布可能不需要 `zundo`）
- **数据**：会话存储新增拓扑记录（每条 thread 一份「本轮委派快照」，建议落在 `delegations` 表），用于拓扑冻结与跨会话审计；不新增独立数据库
- **依赖**：`@xyflow/react` 12.x（MIT）、`@dagrejs/dagre` 3.x（MIT）。**`elkjs` 为 EPL-2.0/GPL，本变更不引入**
- **破坏性变更**：无。团队未声明时主 agent 行为与今天一致（无子 agent）
- **风险**：
  1. 团队配置变化是否构成「图拓扑变化」→ **已定案**：改 `subagents` **不属于图拓扑变化**，重建图后同一会话可直接续用新团队、新子 agent 即时生效（实证出处：`spike/findings/02-topology.md`）；唯一真实边界是「上一轮残留 pending task 且其引用的子 agent 被删 / 改名」会卡住会话，由本变更兜底
  2. 画布数据源 → **已定案（design D6）**：以 `useStream` 的 `subagents` 为**唯一主数据源**（实时发现与历史重开同源，靠 `filterSubagentMessages: true` 激活），`task` tool call 派生仅作**降级兜底**（实证出处：`spike/findings/03-canvas-datasource.md`）
