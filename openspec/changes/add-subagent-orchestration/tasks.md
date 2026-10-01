## 0. 前置 spike（**已完成** 2026-10-01 ✅，结论已回填 `design.md` D3/D3b 与 spec）

> 全部用**脚本化模型**（自写 `ScriptedModel` 继承 `BaseChatModel`，按脚本返回带 `tool_calls` 的 `AIMessage`）跑通，**不需要 API key**。
> 脚本：`C:\Users\wt197\.copaw\workspaces\default\spike\probe-*.ts`；报告：`spike/findings/01-delegation.md`、`spike/findings/02-topology.md`。

- [x] 0.1 建一张含 2 个子 agent 的图，跑一轮委派，断言「子结果回流主 agent」→ ✅ 通过（`01-delegation.md` §2.2）
- [x] 0.2 改团队并重建图，在**同一 thread** 上继续一轮，断言不报错、状态不错乱 → ✅ 通过（扩员 / 缩员 / 来回切均 OK，`02-topology.md` §2.2–2.4）
- [x] 0.3 判定「改 subagents 是否构成拓扑变化」→ ✅ **假设 A 成立**（`02-topology.md` §0/§4/§8）：不算拓扑变化，同 thread 可直接用新团队，**新子 agent 即时生效**。假设 B 的事实前提（`resolveSubagentNamespaces` 在 deepagents）被证伪
- [x] 0.4 断言子 agent 只看到任务描述、看不到主 agent 完整历史 → ✅ 通过（isolated 收到 `[自己的 systemPrompt, description]`，description 逐字相同，`§1.1`）
- [x] 0.5 断言并行委派：同一消息多个 `task` tool call 并行执行、全部结束后一起回流 → ✅ 通过（真并发：两次 400ms 任务总耗时 485ms、区间重叠 403ms，`§2.1–2.2`）
- [x] 0.6 断言单个子 agent 失败不拖垮整轮 → ❌ **不成立**：一个子 agent 抛错 = 整轮 `invoke` REJECTED，主 agent 连第二次调用都没有，兄弟子任务的已成功结果一并丢弃（`§3.1–3.3`）。**已改写入 spec**（新增「执行失败的隔离与呈现」，并要求由我们在模型层做软失败包装）
- [x] 0.7 附带实证（均已有证据，直接生了新 Requirement）：① 主 agent **自己的普通工具**抛错同样掀翻整轮（`§3.6`）；② `general-purpose` 子 agent 默认存在且找不到关闭入口（`§意外发现 1`）；③ `mode:"handoff"` 是被静默接受的幽灵值（`§1.4`）；④ `isolated` 只隔离对话、**不隔离工作区**（`§1.3`）；⑤ 回流给主 agent 的**只有最后一条 AI 文本**（`§2.2`）；⑥ 回流顺序 = 请求顺序、非完成顺序（`§2.3`）；⑦ 显式 `systemPrompt` 会**完全替换**内置提示词（`§意外发现 4`）
- [x] 0.8 附带实证（拓扑边界）：thread 有 **pending task** 且其引用的子 agent **被删/改名** → 该会话**持续失败、连发新消息都被拦**；把子 agent 加回去立刻恢复，数据未损坏（`02-topology.md` CASE B/C）

## 1. 团队的声明与装载

- [ ] 1.1 定义 `team/<名>/SPEC.md` 的解析（frontmatter 字段 + 正文），并用测试断言合法声明被装载、正文成为系统提示词（对齐 `subagent-team`：合法声明被装载）
- [ ] 1.2 实现字段校验：缺 `description`、`name` 与目录名不一致、YAML 非法 → 均被拒绝且原因可读，用测试逐个覆盖（对齐 `subagent-team`：缺少 description 的声明被拒绝 / name 与目录名不一致 / frontmatter 语法非法）
- [ ] 1.3 实现「非法声明不拖垮整体加载」：构造一个残缺子 agent，断言其余子 agent 仍被装载（对齐 `subagent-team`：frontmatter 语法非法）
- [ ] 1.4 实现子 agent 标识校验（拒绝分隔符、`..`、空白），用测试覆盖每种非法输入（对齐 `subagent-team`：拒绝非法子 agent 标识）
- [ ] 1.5 实现「无 `team/` 或无合法声明」的降级：断言主 agent 正常工作且无子 agent（对齐 `subagent-team`：未声明任何子 agent）
- [ ] 1.6 把装载结果接进 `createDeepAgent({ subagents })`，用真实会话断言主 agent 能按 `description` 选对子 agent
- [ ] 1.7 实现子 agent 的工具白名单解析，并用测试断言「主 agent 关掉某工具组后子 agent 也拿不到」（对齐 `subagent-team`：工具组开关对子 agent 生效）
- [ ] 1.8 实现子 agent 默认不继承技能，用测试断言未声明 `skills` 时技能集为空（对齐 `subagent-team`：子 agent 默认不继承技能）
- [ ] 1.9 断言结构性防递归：子 agent 的工具集合不含 `task` 与跨 agent 调用工具（对齐 `subagent-team`：子 agent 不继承委派工具 / 递归不可被提示词绕过）
- [ ] 1.10 断言子 agent 的文件操作落在本轮工作区并受路径约束（对齐 `subagent-team`：子 agent 的文件操作落在当前工作区）

## 2. 团队管理界面（L2 角色层）

> 依据：`spike/findings/04-team-page.md` §3（落地清单）/ §3.5（i18n）/ §3.6（`data-*`）/ §5（测试）。
> **已拍板（用户决定，实现者不得另选）**：① 入口是 `/agents/[id]` 下的**子路由** `/agents/[id]/team`（照抄 `/agents/[id]/memory`，**不做 tab**）；② 字段与正文**一次 `PUT` 原子写**（不做"正文单独保存"）；③ **不做 Markdown 编辑器**，正文用既有 `<Textarea>`；④ 新建子 agent 用**内联表单**（非 Dialog）；⑤ 模型控件**复用 `agents/[id]/page.tsx:216-262` 的 Select JSX + `modelSelectValue/modelPayload`（`utils/agentConfig.ts:131,147`），不复用 `ModelPicker` 组件本身**（它是工作区绑定的、会改写 `config.json`，`ModelPicker.tsx:85-110,118-131`）。`[实证-04]`

**后端（`apps/server`）**

- [ ] 2.1 （改）`apps/server/src/agents/root.ts`：在 `:39` 附近追加 `AGENT_TEAM_DIR = "team"`、`AGENT_TEAM_SPEC_FILE = "SPEC.md"` 与 `teamDirPath(agentId, root?)`，风格对齐既有 `AGENT_SKILLS_DIR`（`root.ts:27-41`）`[实证-04 §3.1B]`
- [ ] 2.2 （改）`apps/server/src/agents/errors.ts`：`AgentErrorCode`（`:7-13`）扩 4 个码 —— `SUBAGENT_INVALID_ID`(400) / `SUBAGENT_ALREADY_EXISTS`(409) / `SUBAGENT_NOT_FOUND`(404) / `SUBAGENT_INVALID_SPEC`(400, `field`)；`AgentError` 类与 `http.ts:146-178` 的 `onError` **不用改**（已泛化处理 `AgentError`）`[实证-04 §1.5,§3.1C]`
- [ ] 2.3 （新）`apps/server/src/agents/team.ts`（~250–350 行，组织方式照 `registry.ts`）：导出类型 `SubAgentIssue / SubAgentMember / TeamView / ToolCatalogGroup`；纯函数 `isValidSubAgentId / parseSubAgentSpec / buildSpecSkeleton / renderSubAgentSpec`；IO `listTeam / readSubAgent / updateSubAgent / createSubAgent`。关键实现点（每条对应一个 spec scenario）`[实证-04 §3.1A]`：
  - frontmatter 复用 `src/wiki/frontmatter.ts` 的 `parseFrontmatter` / `upsertFrontmatter`（`frontmatter.ts:45,109`），**不新写 YAML 解析** `[实证-04 §2#23]`
  - `team/` 不存在 → 返回 `{exists:false, members:[]}`，**不抛 404**（对齐 `subagent-team`：未声明任何子 agent）
  - 单个 `SPEC.md` 解析失败 → 该项 `valid:false` + `issues`，**其余照常装载**（对齐 `subagent-team`：frontmatter 语法非法）
  - `description` 缺失/空、`name` ≠ 目录名、目录名非法 → 均 `valid:false` 并给出可读 issue（对齐 `subagent-team`：缺少 description / name 与目录名不一致 / 拒绝非法子 agent 标识）
  - 写盘**先合并再整体校验，校验不过一个字节都不写**（对齐 `subagent-team`：保存非法内容被拒绝；范式见 `registry.ts:279-338`）
  - 原子写：`fs.writeFile(tmp) → fs.rename`（`json-file.ts` 的 `writeJsonAtomic` 只服务 JSON）`[推测-04 §3.4 决策5]`
  - `toolCatalog` 由 `config.ts:19-31` 的 `TOOL_GROUPS` + 主 agent 的 `config.tools` **现算**，不前端硬编码（`enabled` 只有后端知道；对齐 `subagent-team`：工具组开关对子 agent 生效）`[推测-04 §3.2①]`
- [ ] 2.4 （改）`apps/server/src/http.ts`：`:14-21` 文件头契约注释补 3 行；新增 3 条路由（插在 `:317` memory 路由之前）`[实证-04 §1.5,§3.2]`：
  - `GET /agents/:id/team` → `{agentId, dir, teamDir, exists, toolCatalog, members}`（成员含 `name/dir/specPath/valid/issues/description/tools/model/skills/mode/systemPrompt`）`[实证-04 §3.2①]`
  - `PUT /agents/:id/team/:name` → **一次 PUT 原子写**：请求 `{description?, tools?, model?, skills?, mode?, systemPrompt?}`，**字段缺席=不改、显式 `null`=删除该键（回到"继承"）**；合并 = `当前 frontmatter ⊕ patch` → 整体校验 → 通过才写；返回 `{name, member}`。错误码用 2.2 的 4 个 `SUBAGENT_*` `[实证-04 §3.2②]`
  - `POST /agents/:id/team` → 请求 `{name, description（必填）, systemPrompt?}`；建目录 + 写 `SPEC.md` 骨架；骨架**不写** `tools/model/skills`（保持"未声明=继承"）；返回 `{name}`（对齐 `POST /agents` 的返回形状）`[实证-04 §3.2③]`

**前端（`apps/web`）**

- [ ] 2.5 （新）`apps/web/src/lib/teamApi.ts`（~180 行）：照抄 `lib/agentsApi.ts`（类型 + `normalize*` 容错函数 + 端点函数），底座用 `lib/workspaceApi.ts:158` 的 `request<T>()` + `WorkspaceApiError`；导出 `getTeam / updateSubAgent / createSubAgent` `[实证-04 §2#1,#2]`
- [ ] 2.6 （改）`apps/web/src/app/hooks/useAgents.ts`：追加 `useTeam(agentId, revision=0)`，SWR key `["/agents/${id}/team", revision]`，options 照抄 `useAgentMemoryTree`（`:94-102`）`[实证-04 §3.3]`
- [ ] 2.7 （新）`apps/web/src/app/agents/[id]/team/page.tsx`（~180 行）：**子路由**页面，骨架照抄 `agents/[id]/memory/page.tsx:17-60`（返回链接 + 标题 + 刷新 + 错误/空态）；**不改 `_shell/navRegistry.ts`**（`/agents` 已是导航项，子路由靠最长前缀匹配命中，`navConfig.ts:189-201`）`[实证-04 §1.1]`
- [ ] 2.8 （新）`apps/web/src/app/components/team/TeamMemberCard.tsx`（~200 行）：单个成员卡片 = 名称 / 目录名 / `valid` 徽标 / `issues` 列表 / `description` Textarea / **正文 `<Textarea>`** / tools 多选 / model Select / 保存按钮 / 折叠区（skills、mode，只读展示）。**不做 Markdown 编辑器** `[实证-04 §0#3,§4]`
- [ ] 2.9 （新）`apps/web/src/app/components/team/ToolWhitelistPicker.tsx`（~80 行）：「继承 / 自定义」二选一 + 分组 checkbox 网格，DOM 结构照抄 `agents/[id]/page.tsx:281-303`；`enabled:false` 的工具组必须可视标注；选"继承"时 `PUT` 传 `tools: null`（**不是空数组** —— 空数组 = 显式"一个工具都不给"）`[实证-04 §4.1]`
- [ ] 2.10 （新）`apps/web/src/app/components/team/SubAgentCreateForm.tsx`（~90 行）：**内联表单**（非 Dialog），字段 = 目录名 + 路由描述；目录名校验复用 `utils/agentConfig.ts:21-33` 的 `validateAgentId`、错误文案映射照抄 `agents/page.tsx:56-68` 的 `idErrorText` `[实证-04 §3.4 决策4,§2#9,#10]`
- [ ] 2.11 模型控件：**照抄 `agents/[id]/page.tsx:216-262` 的整段 `<Select>` + 哨兵常量 `INHERIT_MODEL = "__inherit__"`（`:55`）+ `useModelsOverview()`（`useModels.ts:14`）+ `groupModelsByProvider()`（`ModelPicker.tsx:58`）+ `modelSelectValue/modelPayload`（`agentConfig.ts:131,147`）**。语义差异：这里留空 = `PUT` 传 `model: null` = **删除 frontmatter 的 `model` 键**（≠ `agents/[id]/page.tsx:118` 那个"跟随全局默认"的 `null`）`[实证-04 §4.2]`
- [ ] 2.12 （新）`apps/web/src/app/utils/teamConfig.ts`（~120 行，纯函数）：`subAgentIdErrorText / memberDraftFrom / memberPayload / toolSelectionFrom / inheritToolsMode / parseModelValue / sortMembers` `[实证-04 §3.3]`
- [ ] 2.13 （改）`apps/web/src/app/agents/[id]/page.tsx`：① 标题行（`:154-166`）在 `data-agent-memory-link` 旁加 `data-agent-team-link` → `/agents/[id]/team`；② 补一句「团队变更何时生效」的说明（见任务 5.5、6.5）`[实证-04 §3.3]`
- [ ] 2.14 （改）`apps/web/src/i18n/zh.ts`：新增一级分组 `team:{…}`，位置在 `agents`（`:384-459`）之后、`binding`（`:461`）之前；所有值**不得含英文字母**（否则 `zh.test.ts:64-115` 的全仓扫描会挂；占位符 `{name}/{error}` 除外）`[实证-04 §3.5]`
- [ ] 2.15 补 `data-*` 断言钩子（供 browser-use / 测试定位）：`data-team-page / data-agent-id / data-team-root / data-team-refresh / data-team-error / data-team-empty / data-team-list / data-team-member={name} / data-team-member-valid / data-team-issues / data-team-member-description / data-team-member-model / data-team-member-tools / data-team-field-dirty / data-team-save / data-team-save-error / data-team-create / data-team-name-input / data-team-name-error / data-team-description-input / data-team-create-submit`。**`data-team-save-error` 必须把后端返回的 `message` 渲染出来**（任务 2.18 的验收点）`[实证-04 §3.6]`

**测试（`[实证-04 §5]`）**

- [ ] 2.16 （新）`apps/web/src/app/utils/teamConfig.test.ts`（纯函数，`bun test`）：`tools:null` → 继承模式 / `tools:[]` → 自定义且全不勾（**最易写错的一条**）/ `model:null` → 继承哨兵；`memberPayload` 的 `null` 与数组语义；`subAgentIdErrorText` 四类错误映射；`sortMembers` 按 name 稳定排序；非法与合法成员混排时列表仍完整（不丢项）`[实证-04 §5.1]`
- [ ] 2.17 （新）`apps/web/src/app/components/team/TeamMemberCard.test.tsx`（`renderToStaticMarkup` 字符串断言）：`valid:false` 的成员渲染出 `data-team-issues` 与 issues 文本；合法成员**不**渲染告警；折叠态不渲染进阶字段；工具组被主 agent 关闭时出现禁用提示 `[实证-04 §5.1]`
- [ ] 2.18 （新）`apps/server/tests/team.test.ts`（骨架照抄 `tests/agents.test.ts:36-80` 的 mkdtemp + `AGENTS_ROOT` + `app.request`）：解析层（合法 / 缺 description / name 不一致 / YAML 非法不拖垮整体 / 无 `team/` 返回 200 空态 / 目录名非法 / `tools` 缺省=null vs 显式 `[]`）；`GET`（形状、`toolCatalog.enabled` 跟随主 agent、agent 不存在 404）；`PUT`（落盘断言、**清空 description → 400 `SUBAGENT_INVALID_SPEC` 且文件字节完全不变**、`tools:null` 删键、未知工具名 400）；`POST`（建目录 + 骨架、重名 409、非法名 400、description 空 400 且**不留半个骨架**）`[实证-04 §5.2]`
- [ ] 2.19 用 browser-use 打开 `/agents/<id>/team`，按 2.15 的 `data-*` 复核：全部合法成员名 + 路由描述可见；构造一个坏 `SPEC.md` → 出现 `data-team-member-valid="false"` 与原因；新建后新成员出现在列表；`/agents/<id>` 上入口链接存在（对齐 `subagent-team`：列出团队成员 / 新建子 agent 可被委派）`[实证-04 §5.3]`

## 3. 拓扑数据的采集与持久化

> 依据：`spike/findings/03-canvas-datasource.md` §4（落库方案）。
> **已定案**：新增 `delegations` 表（父 thread + turn + `tool_call_id` 唯一 + status 四态 + `namespace` + `subagent_thread_id`）；`CONVERSATION_SCHEMA_V2` + `PRAGMA user_version = 2` **幂等升级**（DDL 全 `IF NOT EXISTS`，老库重开自动补表、**数据零迁移**）；服务端用 `createMiddleware({ wrapToolCall })` 拦 `task` 落库。

- [ ] 3.1 （改）`apps/server/src/conversation/schema.ts`：`CONVERSATION_SCHEMA_VERSION = 2`；新增 `CONVERSATION_SCHEMA_V2` 常量与表/索引名常量；`applyConversationSchema()` 改为 `exec(V1); exec(V2); PRAGMA user_version = 2`（现函数已是「无条件 exec + 无条件设版本」，`schema.ts:150-155`，故老库重开即被 V2 补表）；`EXPECTED_TABLES / EXPECTED_COLUMNS / EXPECTED_INDEXES` 加入新表/列/索引 `[实证-03 §4.3]`
  - `delegations` 列：`id PK / thread_id FK→threads ON DELETE CASCADE / turn_id FK→turns ON DELETE CASCADE（可 NULL）/ tool_call_id / subagent_type / description / status（pending|running|complete|error 四态）/ subagent_thread_id FK→threads ON DELETE SET NULL / namespace / result / error_text / depth / parent_tool_call_id / started_at / ended_at / created_at / updated_at / meta_json`
  - 唯一索引 `idx_delegations_thread_toolcall(thread_id, tool_call_id)`；索引 `idx_delegations_turn(turn_id)`、`idx_delegations_subthread(subagent_thread_id)`
  - **不改既有三表任何列**（避免破坏 D4 的逐字对齐与既有断言）`[实证-03 §4.2]`
- [ ] 3.2 ⚠️ **必改，否则改完必红**：（改）`apps/server/scripts/test-conversation.ts` —— `:104` 的 `assert.equal(EXPECTED_TABLES.length, 3, "三层结构：threads / turns / messages")` **改成 4**；`:119-120` 的 `PRAGMA user_version === CONVERSATION_SCHEMA_VERSION` 会自动跟到 2；`:106-116` 的 columns/indexes 遍历断言会自动覆盖新表（把新常量加进去即可）`[实证-03 §4.4]`
- [ ] 3.3 （改）`apps/server/src/conversation/store.ts`：新增 `recordDelegation / updateDelegationStatus / listDelegations / listDelegationsByTurn`，内部复用 `openConversationDb` + `withTransaction` + 模块内 `nowIso/uid/param`（`store.ts:96-120`），保持「第一参数是工作区绝对路径」的既有约定；**`deleteAllConversations`（`store.ts:~950-962`）必须补一行 `DELETE FROM delegations` 并放在 `DELETE FROM threads` 之前**；`deleteThread` 无需改（FK 已级联；`detach` 分支只置 NULL `parent_thread_id`，`subagent_thread_id` 用 `SET NULL` 同样安全）`[实证-03 §4.3]`
- [ ] 3.4 （新）`apps/server/src/delegation-logger.ts` + （改）`apps/server/src/agent.ts`（在 `:91` 的 `middleware: [...]` 注册）：用 `createMiddleware({ wrapToolCall })` 拦 `task` 调用 —— 进入时 `recordDelegation(status="running")`（取 `toolCall.id` / `args.subagent_type` / `args.description` / `configurable.workspace`），返回后 `updateDelegationStatus(… "complete"|"error", result)`。`createMiddleware` + `wrapToolCall` 已确认存在于 `langchain@1.5.14`（`dist/agents/middleware.js:11,63`），项目已用同款写法（`src/models/middleware.ts` 的 `wrapModelCall`，`agent.ts:22,91`）`[实证-03 §4.3(4)B]`
  - 子 agent 的**内部消息不落 `messages` 表**（体积大，且 checkpoint 已是权威内容源）；`delegations.namespace` 存下 `checkpoint_ns`，画布点节点时按需 `getHistory` 拉取 `[实证-03 §4.3(4)]`
  - 权威关系：`delegations` 是**快照/索引**，checkpoint 是**内容源**，两者以 `(thread_id, tool_call_id)` 对齐；快照缺失（老轮次）时画布退回 v1/v2 实时重建 `[实证-03 §4.3(5)]`
- [ ] 3.5 （新）迁移测试（新 `apps/server/scripts/test-migration.ts`，纳入 `test:conversation`；**用 `node --test` 跑，不能用 bun** —— `db.ts` 顶部已写明 `node:sqlite` 相关测试必须 `node --test`）：建 v1 库（`exec(V1)` + `user_version=1`）插 1 thread / 1 turn / 1 message → 调 `applyConversationSchema()` → 断言 `user_version===2`、`delegations` 存在、**原三表行数与内容不变**（数据保全）、再次调用仍幂等（无异常、无重复）`[实证-03 §4.4]`
- [ ] 3.6 行为断言：同 `(thread_id, tool_call_id)` 第二次 `recordDelegation` → 唯一约束冲突（或设计成 upsert，**二选一并在断言里钉死**）；`listDelegationsByTurn` 返回顺序稳定（建议 `ORDER BY created_at, tool_call_id`）；`deleteThread(main, {childAction:"cascade"})` 后 `delegations` 无残留、`{childAction:"detach"}` 后行仍在但 `subagent_thread_id` 为 NULL；`deleteAllConversations` 后四张表全空、库文件仍在 `[实证-03 §4.4]`
- [ ] 3.7 画布端到端探针（放 web 或 spike 脚本，**不进 CI**）：跑一次含 `task` 的 run → `client.threads.getHistory(threadId, { checkpoint: { checkpoint_ns: "tools:<uuid>" } })` 返回非空 messages（复刻 `02-topology-run.log` S7 探针）`[实证-03 §4.4]`
- [ ] 3.8 定义拓扑记录结构（节点：主/子、名字、状态；边：`tool_call_id`、起止节点），并用测试断言序列化稳定（对齐 `orchestration-canvas`：运行拓扑的呈现）
- [ ] 3.9 断言并行委派在记录里保留为同层多节点、不被合并（对齐 `orchestration-canvas`：并行委派并排呈现）
- [ ] 3.10 断言同一子 agent 一轮内多次委派被保留为多次（对齐 `orchestration-canvas`：同一子 agent 被委派多次）
- [ ] 3.11 断言无委派的一轮只记录主 agent 单节点（对齐 `orchestration-canvas`：没有委派时只显示主 agent）
- [ ] 3.12 实现「拓扑记录缺失」的显式表达，并用测试断言不会用当前团队推测出图（对齐 `orchestration-canvas`：拓扑记录缺失时不臆造）

## 4. 只读观测画布

> 依据：`spike/findings/03-canvas-datasource.md` §3（数据源判定与改动表）。
> **已定案**：**v1 + v2 同源** —— `useStream` 的 `subagents` 既做实时发现（v1）又做历史重开自动重建（v2），**只差两个 option**：`filterSubagentMessages: true`（**必加**；不设则 `orchestrator.js:538` 的守卫直接 `return null`，**永远不会构建 subagents 映射**）与 `streamSubgraphs: true`（拿运行中子 agent 内部消息；不设则运行中节点内的会话为空）。**v0（从消息流里的 `task` tool call 派生）降级为兜底**，仅在 SDK 无该节点时使用。`[实证-03 §2v1,§3]`
> SDK 已内置、**不要自己反推**的字段：`SubagentStatus = pending|running|complete|error`（正好是画布要的四态）、`id`（= `tool_call_id`，边的锚点）、`namespace[]`、`result`、`parentId`（嵌套委派）、`depth`、`startedAt/completedAt`；历史重建由 `react/stream.lgp.js:242-248` 的 `reconstructSubagents` + `fetchSubagentHistory` 自动完成 `[实证-03 §2v1,§2v2]`

**数据源接线（文件级）**

- [ ] 4.1 （改，**本画布唯一必改的接线路**）`apps/web/src/app/hooks/useChat.ts:59-70`：`useStream({...})` 增加 `filterSubagentMessages: true`（必加）与 `streamSubgraphs: true`（如要限制历史回填量再加 `historyLimit`）。依据 `react/stream.lgp.js:242-256`、`ui/types.d.ts:904,935-937` `[实证-03 §3 改动表]`
- [ ] 4.2 （改）`apps/web/src/app/providers/ChatProvider.tsx`：把 `stream.subagents / stream.activeSubagents / getSubagent(id) / getSubagentsByMessage(msg)` 透出（现在只透 messages 等；`ChatInterface.tsx:107-113,162` 用的就是 provider 值）`[实证-03 §3 改动表]`
- [ ] 4.3 （改）`apps/web/src/app/components/ChatMessage.tsx:58-79`：`toSubAgents` 改为**优先取 `getSubagentsByMessage(message)`**（拿到真实 status/namespace/内部消息），`task` tool call 仅在 **SDK 无该节点时降级**（保留现逻辑兜底）`[实证-03 §3 改动表]`
- [ ] 4.4 （新）画布组件：节点 = `SubagentStream`；边 = `toolCall.id`（主→子）与 `parentId`（子→孙）；点节点 → 用 `namespace` 调 `client.threads.getHistory(threadId, { checkpoint: { checkpoint_ns: ns.join("|") } })` 取内部消息（`api/threads.mjs:118` 的 POST 支持带 ns；**GET 永远强制 `""`**）；点边 → 用 `toolCall.id` 去该轮 messages 里定位那条 AI tool call。**`namespace` 必须来自 SDK 的 `SubagentStream.namespace`，不能自己拼 `tools:<tool_call_id>`**（`tools:<uuid>` 的 uuid ≠ tool_call_id）`[实证-03 §3,§2v2]`
- [ ] 4.5 v0 降级兜底：当 SDK 无该子 agent 节点（无 `threadId` / 老轮次 / `subagents` 为空）时，退回 `ChatMessage.tsx:58-79` 的 `task` tool call 派生（只能显示 `description` + 最终 output 摘要，**拿不到子会话内容**）`[实证-03 §2v0]`
- [ ] 4.6 （改）`apps/web/package.json`：引入 `@xyflow/react` 12.x + `@dagrejs/dagre` 3.x（均 MIT）；只读画布**不引 `zundo`**

**画布功能与断言**

- [ ] 4.7 把 §3 的拓扑记录渲染成节点与边，用 browser-use 断言「1 主 + 3 子 + 3 边」（对齐 `orchestration-canvas`：一轮内发生多次委派）
- [ ] 4.8 实现节点状态呈现（进行中 / 成功 / 失败，即 SDK 的四态），并用真实会话制造一次失败，断言无需展开即可看出（对齐 `orchestration-canvas`：状态随时间变化 / 部分失败可见）
- [ ] 4.9 实现主 agent 节点自身的进行中状态（对齐 `orchestration-canvas`：主 agent 自身的状态）
- [ ] 4.10 实现点节点展开子会话、点边定位 tool call，用 browser-use 断言两类跳转（对齐 `orchestration-canvas`：从节点展开子会话 / 从边定位工具调用）
- [ ] 4.11 断言子会话以独立单元呈现、不与主对话混排（对齐 `orchestration-canvas`：子会话不混入主对话）
- [ ] 4.12 断言只读性：界面上不存在新建/删除节点与连线的入口，拖动不产生任何持久化副作用（对齐 `orchestration-canvas`：没有编辑入口 / 拖拽不产生副作用 / 修改团队必须走团队管理界面）
- [ ] 4.13 实现空态与降级：无团队、无委派两种情况给出可读说明（对齐 `orchestration-canvas`：无团队配置时的空态）
- [ ] 4.14 实现「图 / 列表」视图切换作为窄屏兜底
- [ ] 4.15 断言历史复现：重开会话、刷新页面后画布仍还原当时拓扑（对齐 `orchestration-canvas`：重新打开历史会话 / 刷新页面后仍然可见）
- [ ] 4.16 断言「团队后来变了」时画布呈现的是**当时**的结构（对齐 `orchestration-canvas`：团队后来发生了变化）

## 5. 团队变更生效与失败兜底（**由 P0 spike 的实证新拆出来的一节**）

- [ ] 5.1 把 `agent.ts` 的图出口从**对象**改为**工厂函数**，使团队配置变更后重建图即可生效、**不用重启服务**；起真实 `langgraphjs dev` 端到端验证：改 `SPEC.md` → 同一 thread 发第二条消息 → 断言用上新团队。目标是把 `design.md` D3 落地要求 1 从 `[实证-源码]` 升级为 `[实证]`（对齐 `subagent-team`：团队变更需重建图才生效）
- [ ] 5.2 实现子 agent **模型层软失败包装**：把子 agent 模型的异常转成一条可见结果，使主 agent 仍能继续本轮。用脚本化模型断言「子 agent 抛错时 `invoke` 仍 RESOLVED，且主 agent 被第二次调用」（对齐 `subagent-team`：子 agent 执行异常不终止整轮）——**底层默认行为不提供这一能力，必须自己实现**
- [ ] 5.3 定义并实现失败标记约定，断言主 agent 能区分「子任务完成」与「子任务失败」；同时保留失败的归属（哪个子 agent、哪次委派）与可读原因（对齐 `subagent-team`：失败以可见结果回到主 agent / 失败可被追踪）
- [ ] 5.4 断言任意工具错误的中止语义被明确：构造主 agent 自己普通工具抛错的场景，断言本轮以**可读错误**结束而非不可解释的中断（对齐 `subagent-team`：任意工具错误的中止语义被明确）
- [ ] 5.5 处置内置 `general-purpose` 子 agent：团队成员列表把它显式标注为「运行时内置成员」并说明能力范围；主 agent 系统提示词里明确它与专用子 agent 的边界；断言用户定义同名子 agent 被拒绝（对齐 `subagent-team`：内置通用子 agent 的处置）
- [ ] 5.6 校验 `mode` 只接受 `isolated` / `fork`，断言 `handoff` 与其它非法值均被**我们**拒绝（对齐 `subagent-team`：mode 只接受 isolated 与 fork）
- [ ] 5.7 补齐主 agent 与各子 agent 系统提示词的**自包含性**（显式 `systemPrompt` 会完全替换运行时内置提示词，内置约束不再存在），逐条对照其职责与边界（对齐 `subagent-team`：系统提示词的自包含性）
- [ ] 5.8 委派给不存在的子 agent：断言给出可读错误并列出当前允许的成员，且不会被静默转给内置通用子 agent（对齐 `subagent-team`：委派给不存在的子 agent）
- [ ] 5.9 删除/改名子 agent 的风险提示 + 卡住会话的兜底：断言「停在未完成委派上」的会话会被明确提示出路，且不会被静默卡死（对齐 `subagent-team`：未完成的委派指向已被删除或改名的子 agent / 删除或改名前的风险提示）
- [ ] 5.10 断言子 agent 系统提示词/`description` 都要求「把结论写进最终回复」，并用测试固化「只回流最后一条 AI 文本、无文本时回落到 `Task completed`」的行为（对齐 `subagent-team`：只回流最终文本）

## 6. 收尾

- [ ] 6.1 端到端跑通：新建一个子 agent → 在对话里观察它被委派 → 画布上看到它 → 点开看子会话
- [ ] 6.2 `bunx tsc --noEmit`（server 与 web 双端干净）、`bun --cwd apps/server test`、`bun --cwd apps/web test` 全绿
- [ ] 6.3 用 `BU_CDP_URL=http://127.0.0.1:9222 browser-use` 在真实页面上复核团队成员列表、画布、状态、跳转
- [ ] 6.4 更新 `openspec/changes/add-custom-agents/tasks.md`：把 7.1–7.4 标注为由本变更承接；7.5–7.10（跨工作区调用 / 同侪互通）明确标为「本产品不启用」
- [ ] 6.5 在 `/agents/[id]` 配置页补一条说明：团队变更在什么时候生效（对齐 `subagent-team`：团队变更的生效边界）
