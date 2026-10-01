## Context

见 `proposal.md - Why`。三条**已实测**的约束（不是推断）：

| 事实 | 证据 |
|---|---|
| 平台锁死持久化 | 给 `createDeepAgent` 传 `SqliteSaver`（指向工作区）→ 工作区 sqlite **0 字节**，平台自己的 18.4 MB 文件照写 |
| 自定义 agent 与存储解耦 | 同一图 + `configurable.agent_id` → 实测切出两个人设完全不同的 agent（「小助：…」vs「审查官在此…」） |
| 协议形状已知 | 之前的 probe 抓到了真实 SSE 事件：`metadata` / `messages/partial` / `messages/complete` / `messages/metadata` / `updates` / `values` |
| 运行环境 | dev server 的图跑在 **Node 24**（`{isBun:false}`）；`better-sqlite3` 在 **bun 下完全不可用**（bun issue #4290） |
| 前端 SDK 面 | 只需 `assistants.get/search`、`threads.search/updateState`、`useStream(config)` 内部那套；**没有用到平台独有特性** |

## Goals / Non-Goals

**Goals**
- 一次把「Agent 定义 / 工作区 / 会话」三层身份与存储位置定下来，后续不再改数据层
- 前端数据层**零改动**（协议兼容，不自定义协议）
- 一个工作区一个 agent 的强约束下，会话/待办/定时任务天然按 agent 隔离
- 多 agent 交互（委派 / 跨工作区调用 / 同侪互通）有明确的记录与隔离设计
- 会话可搬移（跟着工作区走）、可检索、可压缩、无孤儿

**Non-Goals**
- 不做云端多租户 / 鉴权体系
- 不做跨机器的 agent 分发（异步远端 graph）
- 不实现 LangGraph 平台的全部端点（只做前端实际用到的那部分 + 必要的管理端点）
- 不保留对 `langgraph dev` 的运行时依赖（但保留它作为**可选**的开发调试手段，见 D9）

## Decisions

### D1. 三层身份模型（这是整个设计的根）

```
Agent 定义   <agents 根>/<agent-id>/        人设 / 记忆 / 技能 / 模型·工具·审批配置
     ↓ 被工作区绑定（1 : 1）
工作区       <工作区路径>/                   项目文件 / project.json / 待办 / 会话库 / 定时任务
     ↓ 工作区内产生
会话         <工作区>/.open-assistant/sessions.sqlite
```

**一条规则：`我是谁` 归 Agent 定义；`我在这干了什么` 归工作区。**

**为什么把 Agent 定义从工作区里拿出来**：现在 `AGENTS.md` 在工作区根，导致「人设 = 每个工作区一份」，同一个助手换项目就变成另一个人，记忆也无法跨项目累积。

**替代方案**：QwenPaw 的做法是 `agent 的家 == 工作目录`（`~/.qwenpaw/workspaces/<id>/`）。否决理由：agent 被绑死在那个目录上，无法把同一个助手用在多个项目；而且它没区分「关于人的记忆」与「关于项目的记忆」。

### D2. 一个工作区只绑一个 agent（你给的约束）—— 它简化了很多东西

绑定写在 `<工作区>/.open-assistant/project.json`：

```json
{
  "version": 1,
  "agentId": "xiaozhu",
  "displayName": "我的笔记库",
  "createdAt": "...",
  "lastAgentSwitch": { "from": "reviewer", "at": "...", "reason": "user" }
}
```

**这个约束带来的简化（很重要）**：
- 会话**不需要**按 agent 再分库 → 一个工作区一个 `sessions.sqlite`，范围即 agent
- 「各个 agent 独立的 todo / 定时任务」**自动成立** → 它们本来就是 `per 工作区` 的
- 「按 agent 隔离会话」也不需要额外字段过滤 → 工作区即边界

**代价**：同一个 agent 想用在多个项目 → 建多个工作区，各绑同一个 agent 定义（这是正常的，定义与实例分离）。

**换绑语义**：换绑是显式动作 + 强提示（历史属于前一个 agent）。选择：
- `history: "keep"`（默认）—— 保留历史，但新会话归新 agent；旧会话在列表里标注「由 xxx 创建」
- `history: "archive"` —— 把旧会话整体归档到 `.open-assistant/archive/<old-agent>/`

**无绑定时的行为**：工作区无法对话（因为不知道用谁的人设/记忆/工具）；UI 引导「为此工作区选择 agent」。这延续现有「未指定工作区不得对话」的同一套语义。

### D3. 运行时：**代理 + 接缝拦截**（不自托管，也不自定义协议）

**先纠正两个曾经写错的判断**（都已在本文档修订）：
- 「自定义 agent 需要自托管」→ **错**。middleware 读 `configurable.agent_id` 就够了，平台下就能做（D1 已实测：同一图切出两个人设完全不同的 agent）。
- 「多 agent 通信需要自托管」→ **过重**。轮内委派 / 同侪互通在平台下照做；只有「长时间异步的跨 agent 通信」才需要更多，可推迟。

**做法**：把我们的服务放成前端的**唯一 API 入口**。绝大多数请求**原样代理**给 `langgraph dev`，只拦截我们真正需要控制的少数端点。

```
前端（useStream / client，base URL 指向我们，零改动）
      │
      ▼
我们的服务（Node）
  拦截 ─┬─ POST   /threads/search            → 从工作区库列会话（热＋冷合并）
        ├─ GET    /threads/{id}              → 我们的库
        ├─ DELETE /threads/{id}              → 我们的库删 + 通知平台
        ├─ GET    /threads/{id}/state        → 我们的库（冷会话由库重建）
        └─ /workspace/* /agents/* /jobs/* /memory/*   → 我们自己的业务 API
  代理 ─── 其余全部 → langgraph dev（含 `POST /threads/{id}/runs/stream`，**SSE 形状一字不改**）
```

**为什么这样做**：`runs/stream` 的 SSE 事件形状（`metadata` / `messages/partial` / `messages/complete` / `updates` / `values`）是**转发**的，不是我们实现的 —— 平台继续负责 run 生命周期、取消、重连、中断恢复。我们只在「会话归属与持久化」这几个接缝上介入。这比全量自托管少掉：SSE 协议实现、run 生命周期、并发与取消、中断恢复。

**热/冷会话模型**（顺便解决平台那份 18.4 MB 只增不减的文件）：

| 状态 | 在哪里 | 谁负责 |
|---|---|---|
| **热** | 平台里有一条 live thread | 平台（快、支持中断/时间旅行） |
| **冷** | 只在 `<工作区>/.open-assistant/sessions.sqlite` | 我们（可搜、可搬移、可压缩） |
| **冻结** | 空闲超过阈值 → 删平台 thread，转冷 | 后台任务 |

**压缩 = 控制重放窗口**：冷会话重新打开时，从库里按窗口（最近 N 轮 + 摘要）重放起一条新 thread。窗口之外的内容标记为已归档但仍可检索 —— 这正好实现 spec 里那 5 条压缩要求（当前一条都未实现）。

**替代方案**：① 全量自托管（写 SSE 协议 + run 生命周期）—— 否决：工作量最大，而收益（存储归属）代理方案已经拿到；② 纯双写镜像（平台 thread 一直活着，我们只镜像消息）—— 否决：平台文件仍只增不减，且会话列表来自平台、和我们的库会不一致；③ 自定义协议 + 改前端数据层 —— 用户已明确否决。

**保留 `langgraph dev` 作为可选调试手段**：同一份图既能被我们的服务代理调用，也能用 `langgraph.json` 直接起 dev server 看 Studio。两处共用 `src/agent-*.ts`。

### D4. 会话存储：thread / turn / message 三层

`<工作区>/.open-assistant/sessions.sqlite`：

```sql
-- 一条会话（对应平台概念的 thread）
threads(
  id TEXT PRIMARY KEY,              -- 我们生成的 uuid（对外就是 thread_id）
  agent_id TEXT NOT NULL,           -- 记录创建时的 agent（换绑后仍可追溯）
  kind TEXT NOT NULL,               -- 'main' | 'subagent' | 'agent-call'
  parent_thread_id TEXT,            -- 子 agent / 跨 agent 调用时指向父会话
  parent_tool_call_id TEXT,         -- 挂在哪个 tool call 下
  peer_agent_id TEXT,               -- kind='agent-call' 时的对端 agent
  title TEXT,                       -- 可改；默认由首条用户消息截取
  status TEXT NOT NULL,             -- 'active' | 'archived' | 'error'
  created_at / updated_at TEXT NOT NULL,
  meta_json TEXT                    -- token 用量、模型、标签等
);

-- 一轮 = 一次用户提交 → 一次回答（**压缩的天然单位**）
turns(
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  idx INTEGER NOT NULL,             -- 第几轮
  user_content TEXT NOT NULL,
  started_at / ended_at TEXT,
  status TEXT NOT NULL,             -- 'running' | 'done' | 'cancelled' | 'error'
  usage_json TEXT,
  compacted_by TEXT                 -- 若被压缩，指向压缩产物
);

-- 细粒度消息（用于展示、检索、召回）
messages(
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,               -- human | ai | tool
  kind TEXT,                        -- text | reasoning | tool-call | tool-result
  content TEXT,
  tool_name TEXT,
  tool_call_id TEXT,
  namespace TEXT,                   -- 子图/子 agent 命名空间
  created_at TEXT NOT NULL,
  tokens INTEGER
);
CREATE INDEX ... ON messages(thread_id, seq);
CREATE INDEX ... ON messages(tool_call_id);
```

**三个关键决定**：

1. **为什么三层而不是只存 messages**：`turn` 是压缩的单位（qwenpaw 的 `scroll` 策略也是按轮驱逐）；`thread` 是列表与搬移的单位。只存 messages 会导致「压缩时不知道该丢多少」。
2. **和 LangGraph checkpointer 并存，但我们是权威**：checkpointer 负责「图能恢复执行」（同轮内中断恢复、子图状态）；这张表负责「人能读、能搜、能搬移、能压缩」。两者的关系是：**run 结束后把这一轮的 messages 落进我们的表**。
3. **子 agent 记录不混进主记录**：`kind='subagent'` + `parent_thread_id` + `parent_tool_call_id`。前端展示时挂在对应 tool call 下（与现有「回合聚合」的 UI 天然契合），**不在主 transcript 里混排** —— 这也是 DeepAgents 官方的设计取向。

### D5. thread_id 的对外呈现（你专门问的）

| 场景 | 展示 |
|---|---|
| 会话列表（`/threads/search`） | 标题（默认取首条用户消息前 24 字）+ 短 id（uuid 前 8 位）+ 相对时间；悬停看完整 id |
| 会话页顶部 | 当前 thread 短 id，可点击复制完整 id |
| 子 agent 卡片 | 子会话短 id + 「子会话」标记，展开可看它自己的消息 |
| 跨 agent 调用卡片 | `→ <对端 agent 名>` + 对端短 thread id（点击可跳到那个工作区的该会话） |
| `?threadId=` | 始终是**完整 uuid**（可分享、可刷新） |

**「对应 agent 自己的 thread_id」怎么成立**：thread 行上记着 `agent_id`。因为一个工作区只绑一个 agent，所以**这个工作区里的 thread 天然都属于那个 agent**；换绑后旧 thread 仍保留 `agent_id`，列表里标注「由 xxx 创建」。

### D6. 多 agent 交互：三类，各自的记录与隔离

| 类型 | 触发 | 在哪跑 | 记录方式 | 独立 checkpoint |
|---|---|---|---|---|
| **① 同轮委派** | 主 agent 调 `task` 工具 | **同一工作区**、同一轮内 | 同一 `thread`，子会话 `kind='subagent'`，`parent_tool_call_id` 指回来 | 可选：子会话自己一行 + 自己的 `checkpoint_ns`；默认共享父库 |
| **② 跨工作区调用** | 主 agent 调 `ask_agent` 工具 | **对端 agent 的**工作区 | 对端工作区里新建一条 `thread`（属于对端 agent）；本侧记 `kind='agent-call'` + `peer_agent_id` + `peer_thread_id` | 对端独立（天然，因为在对端库里） |
| **③ 同侪互通** | 子 agent ↔ 子 agent | 同一工作区 | 同 `thread`，两条 `subagent` 会话互记 `peer_thread_id` | 同上 |

**「是否可与同级 agent 交互」开关**：属于 **agent 定义**（`config.json` 的 `allowSiblingInteraction: false` 默认关）。关时：子 agent 的工具白名单里**不含** `ask_peer`；开时包含。这条直接对应你之前的需求 8。

**三条护栏**：
- **不继承调用能力**：子 agent 的工具白名单默认不含 `task` / `ask_agent`（结构性防递归，与 DeepAgents 一致）
- **审批回流根会话**：子 agent / 跨 agent 的审批一律路由回发起方的根会话（qwenpaw 靠 `root_session_id`，我们同样传 `root_thread_id`）
- **并发上限**：同轮子 agent 并发默认 3、批量上限 10（qwenpaw 的经验值）

### D7. 工具设计

**内置工具（按 agent 白名单可开可关）**

| 组 | 工具 | 说明 |
|---|---|---|
| 文件 | `read_file` `write_file` `edit_file` `ls` `glob` `grep` | 已有（deepagents 提供），路径限制在工作区内 |
| 待办 | `todo_list` `todo_create` `todo_update` `todo_delete` | 已有，范围 = 本工作区 |
| 人设 | `persona_write` | 已有，仅在首次引导期间可用 |
| **委派** | `task` | 同轮子 agent（`subagents:` 声明式） |
| **跨 agent** | `ask_agent` | 调另一个 agent 定义（需对端有绑定的工作区） |
| **同侪** | `ask_peer` | 仅当 `allowSiblingInteraction: true` |
| **记忆** | `memory_read` `memory_write` | 读写 `<agent>/memory.md`（跨工作区） |
| **项目记忆** | `project_memory_write` | 写 `<ws>/.open-assistant/project-memory.md` |
| **定时** | `job_list` `job_create` `job_delete` | 操作本工作区的 `jobs.json`（危险操作走审批） |
| **技能** | `skill_list` `skill_read` | 渐进披露（见 D8） |

**为什么把 `ask_agent` 与 `task` 分开**：`task` 是「开一个一次性的、同工作区的执行单元」；`ask_agent` 是「找另一个有自己家、自己历史、自己记忆的常驻 agent」。语义不同、记录位置不同、审批路径不同，合成一个工具会让三件事都变模糊。

### D8. 技能（Skills）设计

沿用 Anthropic Agent Skills 约定（qwenpaw 同样）：

```
<agents 根>/<agent-id>/skills/
└── docx/
    ├── SKILL.md          # frontmatter: name / description / 可选 tools
    ├── scripts/          # 可选
    └── references/       # 可选
```

**渐进披露三层**：
1. system prompt 里**只放** `name` + `description`（每个技能一行，几十 token）
2. agent 判断需要时调 `skill_read(name)` 读 `SKILL.md` 全文
3. `SKILL.md` 里引用的 `references/*` 再按需读

**为什么不一上来把技能全文塞进 prompt**：技能一多就爆上下文；渐进披露是官方推荐且可测（可断言 prompt 里只有描述）。

**技能来源两级**：agent 自己的 `skills/` + 一个共享池（`<agents 根>/_shared/skills/`），同名时 agent 自己的优先。

### D9. 前端路由与后端 API 路由

**前端路由**（在现有 app-shell 的导航表里扩展）

| 路径 | 页面 | 说明 |
|---|---|---|
| `/` | 对话 | 当前工作区 + 当前 agent |
| `/todos` | 待办 | 本工作区的 `todos.json` |
| `/jobs` | 定时任务 | 本工作区的 `jobs.json`（替换现有占位 `/cron`） |
| `/memory` | 记忆 | agent 长期记忆 + 项目记忆两个分栏（替换现有占位 `/memory`） |
| `/agents` | agent 列表 | agents 根下的所有定义 |
| `/agents/[id]` | agent 配置 | 人设 / 模型 / 工具白名单 / 技能 / 审批 / 同侪开关 |
| `/agents/[id]/memory` | agent 记忆编辑 | |
| `/settings` | 全局设置 | 模型 provider、**agents 根路径**、外观、导航配置（已有） |

**后端 API 路由**

分两类：**我们自己的业务 API** + **接缝拦截器**（其余请求原样代理给平台，见 D3）。

| 分组 | 路由 | 责任 |
|---|---|---|
| **业务 API** | `/workspace/*`、`/fs/list` | 已有（tree / file / todos / init / status） |
| | `GET /agents`、`POST /agents`、`GET/PATCH/DELETE /agents/{id}` | Agent 注册表 |
| | `GET/PUT /agents/{id}/memory`、`GET /agents/{id}/skills` | 记忆与技能 |
| | `GET /workspace/binding`、`PUT /workspace/binding` | 绑定与换绑 |
| | `GET/POST /jobs`、`PATCH/DELETE /jobs/{id}`、`POST /jobs/{id}/run` | 定时任务（按工作区） |
| | `GET/PUT /memory/project` | 项目级记忆 |
| | `GET /threads/{id}/subagents`、`GET /threads/{id}/peers` | 供 UI 展示子会话 / 对端会话 |
| **接缝拦截** | `POST /threads/search`、`GET /threads/{id}`、`DELETE /threads/{id}`、`GET /threads/{id}/state`、`POST /threads/{id}/state` | 会话归属与持久化（D3） |
| **原样代理** | `/assistants/*`、`/threads/{id}/runs/*`、`/threads/{id}/history`、其余 | **协议一字不改** |

### D10. 一次对话的完整配置流（前后端怎么对上）

```
前端
  URL:        ?workspace=<绝对路径>&threadId=<uuid>
  发送时:      run 的 config.configurable = { workspace, agent_id, thread_id }

后端（收到 run）
  1. 校验 workspace 存在
  2. 读 <ws>/.open-assistant/project.json → 得到 agent_id   ← **不信任前端传来的 agent_id**（以工作区绑定为准）
  3. 读 <agents 根>/<agent_id>/：AGENTS.md / memory.md / config.json / skills/
  4. 取（或构建并缓存）该 agent 的运行时实例：
       model  ← config.model（或 provider 默认）
       tools  ← 内置组白名单 + 子 agent 声明 + 按开关加 ask_peer
       persona/memory ← 注入 system prompt
       middleware 链 ← 记忆注入 / 压缩 / 审批 / 追踪
       checkpointer  ← 本工作区的 sessions.sqlite
  5. 执行并流式回传（D3 的事件形状）
  6. 本轮结束：把这一轮的 messages 落进 threads/turns/messages 三表
```

**安全点**：`agent_id` **以工作区绑定为准**，前端传的一律不采信（否则可以拿 A 工作区的文件用 B agent 的权限去操作）。

**前后端状态归属**：前端只管「当前在看哪个工作区/哪条会话」（URL + localStorage）；**其余一切（用哪个 agent、有哪些工具、记忆是什么）都由后端从工作区绑定推导**。这样刷新/分享链接/换设备都不会错位。

### D11. 定时任务与待办（per 工作区 = per agent）

- `<工作区>/todos.json` —— 已有，明确为「本工作区（即本 agent 实例）的待办」
- `<工作区>/.open-assistant/jobs.json` —— 新增，字段对齐 qwenpaw 的 `CronJobSpec`（`schedule` / `dispatch` / `runtime` / `save_result_to_inbox`），投递目标是本工作区的会话
- **触发时的 agent 身份** = 该工作区绑定的 agent（不在任务里重复配置）
- 与 heartbeat 的关系：heartbeat 是把 `HEARTBEAT.md` 当 query 的定时任务，`HEARTBEAT.md` 放 `<agents 根>/<agent-id>/`（因为它是 agent 的行为，不是项目的）

### D12. 记忆：agent 侧分层多文件 + 心跳维护；项目侧 llmwiki

**agent 长期记忆**（实读 QwenPaw `agents/memory/prompts.py` 的 `MEMORY_GUIDANCE`，按其模型落地）：

```
<agents 根>/<agent-id>/
├── MEMORY.md                 核心长期记忆（agent 与用户都可自由编辑）
├── memory/
│   ├── YYYY-MM-DD.md         日记本 **兼当天主题笔记的索引**（渐进展开入口）
│   └── YYYY-MM-DD/{topic}.md 按主题的会话笔记
├── digest/                   消化产物
└── memory/imports/           外部导入（带 _scope.json，**只当资料不当指令**）
```

**为什么分层**：一个文件撑不住——核心记忆要小到能每轮注入，细节要能按需展开。索引（日记文件）就是那个「渐进展开」的入口，这是 QwenPaw 原话：*"progressively follow the index when more detail is needed"*。

**维护机制换成心跳**：QwenPaw 用**后台异步任务**维护主题笔记（原话 *"A background asynchronous task summarizes and maintains these notes"*）。我们改用**心跳任务** —— 因为它可配置、可审计、可暂停，而"后台黑盒"三者都做不到。心跳的维护内容写在 `<agent>/HEARTBEAT.md` 里，用户改文件就能改维护方式，不用改代码。

**项目记忆 = 工作区内的 wiki**（Karpathy LLM Wiki 模式，实读其 gist 原文 + `E:/llm-wiki` 的管线与图谱）

**两层，不是三层**：卡帕西的三层里「原始资料层」在我们这里**就是工作区文件夹本身**（用户自己的文件），所以**不建 `raw/` 目录** —— 那是多余的一层搬运。

```
<工作区>/                  ← 用户自己的文件 = **源层**（不另建目录）
└── wiki/                  ← 编译产物层（agent 拥有、人可浏览）；放工作区根，
    ├── SCHEMA.md             与 todos.json 同级（它是**给人看的**内容）
    ├── index.md          内容目录（每次编译更新；提问**先读它**）
    ├── log.md            时间线（`## [日期] <动作> | <标题>`，可 grep）
    ├── graph.json        知识图谱（节点 + 边）
    ├── summaries/        摘要页
    └── entities/<type>/  实体页（类型与继承由 SCHEMA.md 定义）
```

**编译管线**（照 `E:/llm-wiki/wikiflow.md` 的双路线）：

| 路线 | 做什么 | 我们是否采纳 |
|---|---|---|
| **A 切分→向量** | 源文件 → 切分 chunk → embedding → 向量库 | **暂不**（本地优先场景下，小规模靠 index + 图谱已够；将来需要再加，接口留出） |
| **B 编译→图谱** | 源文件 → LLM 编写 wiki 页 → **引用解析 → 引用边 → 图谱** | **采纳**，这是主轴 |

**知识图谱**（照 `E:/llm-wiki/api/services/{references,graph}.py` 忠实搬运）：

- **边的两类来源**：① 正文里的引用 → `cites`（指向源文件，带页码）与 `links_to`（指向其他页面）；② frontmatter 里**显式声明的类型化关系**
- **去重键 `(source, target, type)`，保留更权威的一条**：`relation` 非空 > 空；其次带页码 > 无页码 —— 即**声明式关系覆盖正文推断**
- **目标三层解析**：完整相对路径 / 文件名（去扩展名）/ wiki 内路径；解析失败或自引用 → 忽略该条而**不判整次抽取失败**；指向源的内链不产生 `links_to`
- **全量重建是原子的**：先清本工作区旧边，再事务内批量写入；任何失败**回滚整个重建**并向外报错，不留下清了一半的图
- **节点带 `type_ancestors`**（类型继承链，来自 SCHEMA 的 `parent`）→ 按父类型筛选能命中子类型
- **输出 `{nodes, edges}`** 供可视化；**无入边的节点仍出现**，使孤儿页可被发现

**检索融合**（照其 `hybrid_search` 思路但简化）：关键词命中 + **图谱引用扩展** → RRF 式融合 → 可选精排（不可用时回退原序）。缺少向量能力时退化为两路，不整体失败。

**为什么值得照抄**：卡帕西原文的核心判断是 *"the wiki is a persistent, compounding artifact"*，且 *"good answers can be filed back into the wiki as new pages"* —— 让**探索和收录一样能复利**；`index.md` + `log.md` 是他原话建议。而 `llm-wiki` 的图谱部分证明了一件事：**知识之间的连边本身就是可检索资产**（沿边扩展能捞到关键词命不中的东西）。

**替代方案**：① 继续用单文件 `project-memory.md`（已实现但否决：撑不住增长，且没有导航结构）；② 用向量库做项目记忆（否决：本地优先场景下索引/日志文件在中等规模就够了，卡帕西实测 ~100 源 / 数百页仍可工作，且文件形式可被人直接读和改）；③ 记忆维护用后台异步任务（否决：不可审计、不可暂停）。


### D13. 频道：归属工作区、出站长连接、配置与凭据分离

**参考实现**：QwenPaw 的 `console/src/pages/Control/Channels/`（页面 349 行 + 配置抽屉 2029 行 + 访问控制 431 行 + 待审批 411 行）与 `app/channels/`（18 个内置频道）。我们只取结构，不取它的 channel 抽象层（那层在本项目里还没到需要抽象的规模）。

**归属：频道实例属于 agent 定义**（与 QwenPaw 一致）

一个 agent 的接入方式跟着它自己走：人设、记忆、技能、**频道**都是「这个 agent 是什么」的一部分。

**采用 QwenPaw 的 agent ↔ 工作区 1:1**（这是「和 qwenpaw 一样」的直接结果）

QwenPaw 的 `AgentProfileRef { id, workspace_dir, enabled }` 是**一个 agent 一个工作目录**，而 `ChannelConfig` 挂在 agent 上、**没有任何「目标工作区」字段** —— 因为不需要：agent 只有一个目录，消息落点天然唯一。

我们照此收紧 `agent-binding`：**一个 agent 至多被一个工作区绑定**。于是：
- 频道消息的落点**永远唯一**，不需要 `workspacePath` 这类字段
- 「同一个助手用在三个项目」的代价变成**复制三份 agent 定义**（QwenPaw 也是这么用的）
- 复制定义时 **MUST NOT 带频道配置** —— 否则两个 agent 会去连同一个机器人（凭据本就不在定义目录里，不会被带走）

**这个取舍要认清**：我们原先「一个 agent 定义跨多工作区复用」的便利没有了。换来的是「消息/待办/记忆落到哪里」永远不需要猜。

**存放：配置与凭据分开，且都不在会被随手分享的位置**
```
<agents 根>/<agent-id>/channels.json          非敏感配置（随 agent 走）
~/.open-assistant/channel-secrets.json        凭据（按 (agentId, 频道) 索引）
```
凭据**既不落工作区**（工作区会被整个复制给别人），**也不落 agent 定义目录**（agent 目录同样会被复制分享）。
对外读取一律**掩码**（照 models 层已有的 `maskApiKey` 做法）。这样「分享工作区不泄露凭据」与「凭据不落工作区」两条 spec 同时成立。

**传输：出站长连接，不需要公网入口**（这是本地优先应用的硬要求）
| 频道 | 收 | 发 | 关键细节 |
|---|---|---|---|
| QQ | `{apiBase}/gateway` 取地址后走 WebSocket | HTTP API | 平台会**重放事件** → 必须按事件 id 做**有界去重** |
| 飞书 | `lark-oapi` WebSocket 长连接 | Open API | **指数退避重连** + 「长时间无数据」看门狗（否则消息不进来用户也不知道） |

**入站收敛为对话**：消息 → 该工作区的一轮对话（复用会话库）；会话键 = `channel:账号:对端`，与网页端共用同一份会话存储，所以**频道里说的待办与网页端看到的是同一条**。同会话串行（否则两轮并发写同一份状态）。

**访问控制照搬它的「挂起而非拒绝」**：陌生人 → 记 pending + 回一条带自己 ID 的提示 → 管理员裁决。QwenPaw 的实测结论是这条比静默拒绝好得多：用户至少知道「有人被挡在外面」，而不是以为机器人在装死。

**扫码换凭据**：QQ 与飞书都能扫码授权。授权在**服务端**完成，前端只轮询状态 —— 轮询响应里绝不带凭据明文。

**首发只做两个频道**（QQ / 飞书），但目录与字段定义都是**数据驱动**的（照 QwenPaw 的 `config_fields` 思路：字段带类型，界面自动渲染表单），所以以后加频道不用写页面。

**替代方案**：① 把频道放 agent 定义里（否，见上）；② 用 webhook 收消息（否，本地部署要公网入口）；③ 直接搬 QwenPaw 的 `BaseChannel` 抽象层（否，18 个频道的抽象在我们只做 2 个时是过度设计）。


## Risks / Trade-offs

- **[代理层与拦截清单要跟随 SDK 变化]** → 固定 SDK 版本；拦截清单单独成模块并写契约测试（拿**真实前端**调它跑端到端，而不是只测后端）。SDK 升级时先跑契约测试，确认 `threads/search`、`state` 这些被拦截的端点在客户端侧语义没变。
- **[冷会话重放可能与平台直跑有细微差异]**（如 reasoning 分块边界、tool_call id 变化）→ 重放只影响「历史上下文」，不影响本轮流式；用契约测试断言「重放后 agent 能正确引用前文」。
- **[平台那份 18.4 MB 文件仍需监控]** → 靠「冻结」把冷会话的平台 thread 删掉，把文件增长从「随对话长度」压到「随活跃会话数」；再加一条可观测指标（平台文件大小 + 热会话数）放进设置页。
- **[bun 不能用 better-sqlite3]** → 运行时固定 Node（`langgraph dev` 本来就是 Node）；测试若需碰 SQLite，必须用 Node 跑（不能用 `bun test`）。这是硬约束，要写进 README 并在测试脚本里体现。
- **[换绑 agent 的历史归属会产生困惑]** → 默认 `keep` + 列表标注「由 xxx 创建」，并在换绑时给强提示；提供 `archive` 选项。
- **[子 agent 独立 checkpoint 会增加库的复杂度]** → 默认「同库不同 thread 行」；只有确实需要时才开独立库（同一份 `SqliteSaver` 已经能按 thread_id 隔离）。
- **[D1（子 agent 独立 checkpoint）仍未 spike]** → 本设计**不依赖**它成立：D6 表里「独立 checkpoint」是可选项，默认共享库；`AsyncSubAgent` 那条依赖远端 graph 的路**明确不做**。

## Migration Plan

1. **停用平台持久化**：新运行时上线后，`apps/server/.langgraph_api/` 不再被读
2. **一次性导入**：把平台里 453 条 thread 按 `metadata.workspace` 归入对应工作区的 `sessions.sqlite`；无法归属（104 条）与指向已删目录的（264 条 `init-ui`）→ 导入到一个 `_orphan` 库或直接丢弃，**在日志里逐条记录**（不静默丢）
3. **工作区绑定回填**：为现有工作区写 `project.json`，统一先绑一个默认 agent（`xiaozhu`），并把 `<ws>/AGENTS.md` 的内容**迁移**成该 agent 的 `AGENTS.md`（不删原文件，改名为 `AGENTS.md.migrated`）
4. **回滚**：新运行时按开关可退回 `langgraph dev`（数据仍在平台的 `.langgraph_api/`，未删）

## Open Questions

- **默认 agent 叫什么、初始人设写什么**：影响首次体验，但不影响本设计的结构与任务拆分。
- **`ask_agent` 的对端工作区怎么选**：由 agent 配置里声明「可联系的 agent 白名单」，还是允许 agent 按名字动态找？倾向白名单（安全），但留待实现时定。
- **记忆的写入时机**：靠 agent 主动调 `memory_write`，还是在 run 结束时由 middleware 自动归纳？qwenpaw 是自动 + 手动兼有。留待实现时定。