## Why

当前系统只能有一个写死在代码里的 agent（`src/agent.ts`），工作区只是「agent 干活的一个目录」，会话正体被 `langgraph dev` 锁在 `apps/server/.langgraph_api/` 的**一个共享文件**里（已 18.4 MB）。

实测已经证明三件事，它们共同构成了本次变更的动因：

1. **会话与工作区脱钩**：453 条 thread 全挤在服务端一份文件里，其中 264 条属于一个已被删除的工作区目录（孤儿数据）；工作区内的 `sessions.json` 只登记了 8 条，索引与真实数据从未接上。
2. **平台锁死存储**：给 `createDeepAgent` 传自己的 `SqliteSaver`（指向工作区）被 `langgraph dev` **完全忽略** —— 工作区的 sqlite 0 字节，平台自己的文件照写。
3. **自定义 agent 与存储是两件事**：同一个图靠 `config.run.configurable.agent_id` 已能切出两个完全不同的人设（实测通过），所以自定义 agent 不需要改架构；**但它的会话/记忆无处安放**。

因此需要一次把「Agent 定义 / 工作区 / 会话」三层身份与存储设计定下来，并改为自托管运行时，否则多 agent 阶段还要再改一次数据层。

## What Changes

- **新增 `agents` 根与 Agent 定义**：每个自定义 agent 是一个目录（人设、记忆、技能、模型/工具/审批配置），可被多个工作区复用
- **新增工作区绑定约束**：**一个工作区只能绑定一个 agent**；绑定关系写在 `<工作区>/.open-assistant/project.json`
- **改写会话存储**：不再用 `langgraph dev` 的共享 store；会话按工作区落 `<工作区>/.open-assistant/sessions.sqlite`，**支持按轮次检索、压缩与归档**
- **新增运行时接入层（代理 + 接缝拦截）**：把我们的服务放成前端唯一 API 入口；`runs/stream` 等**原样代理**给平台（SSE 形状一字不改），只拦截会话归属与持久化相关的少数端点。**前端零改动、不自托管、不自定义协议**
- **新增多 agent 交互**：同轮委派、跨工作区调用、同侪互通（含用户要求的「是否可与同级 agent 交互」开关），并定义每种交互的记录方式
- **新增 per-工作区（即 per-agent）的定时任务与待办**：`<工作区>/todos.json` 与 `<工作区>/.open-assistant/jobs.json`
- **新增频道接入与频道页**：首发接通 **QQ 与飞书**（都用出站长连接，本地部署无需公网入口）；频道实例归属工作区；配置落工作区、**凭据不落工作区**；入站消息收敛为所属工作区的一轮对话；自带访问控制与「陌生人挂起待审批」
- **重做记忆体系**：agent 长期记忆改为**分层多文件**（核心记忆 / 日记忆与索引 / 主题笔记 / 消化产物），并由**心跳任务周期维护**；项目记忆改为**工作区内的 wiki 层**（llmwiki 模式），在工作区初始化时建立骨架
- **BREAKING**：`<工作区>/AGENTS.md` 不再是人设来源（人设移到 agents 根）；现有工作区需要重新绑定 agent
- **BREAKING**：服务端 `.langgraph_api/` 不再是会话事实源；现有 453 条 thread 需要一次性导入或明确放弃

## Capabilities

### New Capabilities

- `agent-registry`: Agent 定义的生命周期——agents 根、目录约定、人设/记忆/技能/模型/工具/审批配置、按 agent 构建与缓存运行时实例
- `agent-binding`: 工作区与 agent 的绑定——一个工作区只绑一个 agent、绑定记录、换绑语义、无绑定时的行为
- `runtime-host`: 运行时接入层——前端单一 API 入口、接缝拦截清单、原样代理、冷会话重放
- `multi-agent-comms`: 多 agent 交互——同轮委派、跨工作区调用、同侪互通开关、交互期间的记录与隔离
- `agent-scheduling`: 按工作区的定时任务与心跳——任务字段、触发、投递、与 agent/会话的关系
- `agent-skills`: 技能体系——技能目录约定、渐进披露、加载与权限
- `project-wiki`: 项目记忆以 llmwiki 模式实现——源层 = 工作区内用户自己的文件 / agent 拥有的 wiki / 规范文件，内容目录与时间线，知识图谱，收录、答案回填、体检
- `channels`: 频道接入——实例归属工作区、配置与凭据分离、出站长连接收发、入站收敛为对话、访问控制与陌生人待审批、扫码换取凭据
- `channels-ui`: 频道页——已配置 / 可添加两分区、频道卡片、按字段定义动态生成的配置界面、扫码授权块、待审批与名单入口、状态与失败可见

### Modified Capabilities

- `workspace`: 人设文件不再由此承担（改由 `agent-registry` 提供）；`AGENTS.md` 从工作区的必建骨架中移除，新增 `project.json` 作为绑定与项目级配置
- `session-store`: 由「依赖平台持久化 + 工作区内索引」改为「工作区内 SQLite 为唯一事实源」；**新增** thread/turn/message 三层结构、子会话与对端会话的记录挂载、热/冷会话与冻结、按轮检索与压缩实现、会话列表含冷会话
- `todo-store`: 明确为**工作区（即 agent 实例）范围**；工具与 UI 不变，归属语义写清

## Impact

- **后端**：新增 agent 注册表、绑定、会话库、**代理接入层**；`src/agent.ts` 由「单一写死的 agent」改为「按 `agent_id` 解析并缓存」；不再把 `langgraph dev` 当持久化来源，但**继续用它执行 run**
- **前端**：数据层**不改**（协议兼容）；新增 agents 管理与配置页面、按 agent 展示 thread、绑定/换绑交互、多 agent 交互开关、定时任务页
- **数据**：新增 `<agents 根>/`、`<工作区>/.open-assistant/project.json`、`sessions.sqlite`、`jobs.json`；`apps/server/.langgraph_api/` 退役
- **依赖**：需要 `@langchain/langgraph-checkpoint-sqlite`（已装）与一个 SQLite 驱动；**注意 `better-sqlite3` 在 bun 下不可用**，运行时必须走 Node（见 design）
- **迁移**：现有 453 条 thread 与 8 条索引需要一次性处理（导入到默认工作区的会话库，或明确丢弃并记录）