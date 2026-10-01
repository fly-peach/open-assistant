# open-assistant

**一个跑在你自己电脑上的个人助手 agent。**
它替你把脑子里的事记下来、把待办盯住、把零散信息整理成文件 —— 而且这些东西都落在**你自己的目录**里，随时能打开看、能 git 管、能带走。

前后端**全部 TypeScript**，包管理统一用 **bun**。

![对话页](docs/images/chat.png)

---

## 它解决什么问题

市面上的「AI 助手」大多有两个问题：**记不住**（对话一压缩就忘）和**够不着**（你的文件、你的待办在别处）。

这个项目的做法是：

- **记忆分层落盘**，不是塞进上下文里赌它别被压缩掉
- **待办是 JSON 文件**，人和 agent 共用同一份事实源
- **工作区是本机的一个目录**（不是服务端虚构的 id），agent 直接在里面读写
- **多智能体各管一个目录**，谁在维护哪个项目一目了然

---

## 界面

### 对话

左侧是会话与智能体，中间是对话，右侧是工作区文件树。宽窄两种形态可切换。

![对话](docs/images/chat.png)

### 智能体选择器

一个工作区由**一位**智能体维护（1:1），每个智能体有自己的工作区目录。
切换智能体 = 切换到它维护的那个目录，所以选项里直接标出目录路径。

![智能体选择器](docs/images/agent-selector.png)

### 智能体配置

人设 / 模型 / 工具白名单 / 审批级别 / **工作区归属** / **消息频道** / 技能 / 长期记忆 —— 一个助手是什么，都在这一页。

![智能体配置](docs/images/agent-config.png)

### 消息频道

把 QQ / 飞书接进来。**表单是按字段定义自动渲染的**（后端给字段类型，前端渲染控件），所以以后加频道不用改页面。
凭据只以掩码回显，单独存放，不写进工作区或智能体目录。

![频道配置](docs/images/channels.png)

### 待办

JSON 单文件事实源，人和 agent 共用；原子写 + 乐观并发（409 而不是静默覆盖）。

![待办](docs/images/todos.png)

### 记忆

分层：`MEMORY.md`（长期核心）/ `memory/YYYY-MM-DD/{topic}.md`（按天按主题）/ `digest/`（摘要）。

![记忆](docs/images/memory.png)

### 模型

供应商与模型清单在这里配；智能体可以各自指定模型，留空则跟随全局默认。

![模型](docs/images/models.png)

### 智能体列表

一个智能体 = 一份职责边界写清楚的**人设**（`AGENTS.md`）+ 自己的配置。
列表里直接展示「它负责什么、不负责什么」，因为多智能体最容易出的问题不是能力不够，而是**边界含糊**。

![智能体列表](docs/images/agents.png)

---

## 快速开始

```bash
bun install

bun run dev:server     # 后端 + 图运行时 → http://localhost:2024
bun run dev:web        # 前端           → http://localhost:3000
```

密钥放在 `apps/server/.env`（已 gitignore），可从 `apps/server/.env.example` 起步。

```bash
bun run smoke                            # 后端冒烟
bun run --cwd apps/server test           # 后端测试
bun run --cwd apps/server typecheck      # 后端类型检查
bun run --cwd apps/server test:conversation   # 会话库测试（必须用 Node 跑，见下）
bun run --cwd apps/web test              # 前端测试
```

**为什么会话库测试要用 Node 跑**：`better-sqlite3` 在 bun 下不可用（[bun#4290](https://github.com/oven-sh/bun/issues/4290)）。
`test:conversation` 会先 `tsc` 编到 `.conversation-test-build/` 再用 `node --test` 执行。

---

## 架构

```
┌─────────────────────────────┐
│  apps/web                   │  Next.js 16 · React 19 · Tailwind 3 · Radix
│  对话 / 待办 / 定时任务      │  ← 搬自 langchain-ai/deep-agents-ui 再改
│  记忆 / 智能体 / 模型 / 设置 │
└────────────┬────────────────┘
             │ HTTP（契约见 apps/web/src/lib/*Api.ts）
┌────────────▼────────────────┐
│  apps/server                │  Hono HTTP + langgraph 图运行时
│  ┌───────────────────────┐  │
│  │ agent.ts              │  │  createDeepAgent（deepagents 包）
│  │  └ workspace-middleware│ │  人设装载 / 记忆注入 / 工具白名单 / 身份校验
│  └───────────────────────┘  │
│  agents/    注册表·配置·记忆·技能·团队
│  binding     工作区 ↔ 智能体（1:1）
│  channels/   QQ · 飞书（出站长连接，不监听端口）
│  conversation/  会话库（sqlite 三层：threads / turns / messages）
│  jobs/      定时任务（cron）
│  wiki/      项目知识图谱 · 索引 · 归档
│  models/    供应商与模型解析
└─────────────────────────────┘
             │
     你的本机目录（工作区）
     ├─ .open-assistant/     会话库 · 待办 · 绑定记录
     ├─ notes/ wiki/         你自己和助手一起攒的东西
     └─ AGENTS.md            这个项目的人设
```

**智能体定义**在 `~/open-assistant-agents/<agent-id>/`（可用 `AGENTS_ROOT` 覆盖），跟着**人**走而不是跟着项目走：

```
<agents 根>/xiaozhu/
├─ AGENTS.md      人设
├─ MEMORY.md      跨工作区的长期记忆
├─ memory/        按天按主题的笔记
├─ digest/        摘要
├─ config.json    模型 / 工具白名单 / 审批级别 / 工作区归属 / 置顶
├─ channels.json  消息频道
└─ skills/        技能
```

---

## 几条关键设计决策

| 决策 | 为什么 |
|---|---|
| **工作区 = 本机的一个绝对路径** | 你的东西就该在你能打开的地方；不引入一层只有服务端认识的 id |
| **智能体 ↔ 工作区 1:1** | 两个助手同时改一份文件是灾难。一个目录只由一位维护，冲突会被拒（409 并指出是谁占着） |
| **频道归属智能体定义** | 「这个助手用什么渠道和我说话」是它身份的一部分，换绑工作区时不用重配 |
| **凭据只存掩码可回显的位置** | 统一放 `~/.open-assistant/channel-secrets.json`，写盘前断言工作区和智能体目录里不含明文 |
| **外部频道只做出站长连接** | 不需要公网入口、不需要开端口。源码里有断言防止后人加入站监听 |
| **待办是 JSON 单文件 + 乐观并发** | 人和 agent 共用一份事实源；409 比静默覆盖好 |
| **状态只讲它真知道的事** | 例如频道只显示「配置状态」而不显示「连接健康」—— 运行时没去连接时，显示连接状态就是撒谎 |
| **字面量只写一遍** | 界面文案集中在 `apps/web/src/i18n/zh.ts`，组件里不散落中文字面量 |

---

## 目录结构

```
apps/
  server/           后端（Hono + langgraph 图）
    src/
      agent.ts            图的入口与装配
      workspace-middleware.ts  人设 / 记忆 / 权限边界
      agents/             智能体注册表与定义
      channels/           消息频道（含 QQ 协议实现）
      conversation/       会话库
      jobs/               定时任务
      models/             模型解析
      wiki/               项目知识库
    tests/              400 个测试
  web/              前端（Next.js）
    src/app/              页面（分段路由）
    src/lib/              后端契约客户端（每个文件对应一组接口）
    src/i18n/zh.ts        全部界面文案
docs/images/        本文档用图
openspec/           规格与变更（见下）
ROADMAP.md          里程碑、已实现、已知遗留
调研报告.md          立项前的调研
```

---

## 文档

这个项目的**规格先行**：行为写在 `openspec/`，代码实现规格，而不是反过来。

- `openspec/specs/` —— 已落地的能力（每个含 Requirement / Scenario）
- `openspec/changes/` —— 进行中的变更；`openspec/changes/archive/` 是已收口的
- `ROADMAP.md` —— 里程碑、当前状态、**已知遗留**（含未解决的技术冲突）

改动行为时建议先看对应 capability 的 spec，别让代码和规格悄悄分叉。

---

## 状态

**已实现**：对话循环与流式 / 工作区与本机目录选择 / 待办 / 会话库 / 长期记忆分层 / 定时任务 / 智能体注册与配置 / 智能体 ↔ 工作区绑定 / 消息频道（QQ、飞书字段）/ 项目知识图谱 / 模型配置 / 全中文界面。

**尚未开始**：子智能体系统、心跳维护、频道的运行时接线（消息进来→灌进会话）、前端数据层迁移、共享类型包。

完整的遗留清单与未解决的技术冲突见 **[ROADMAP.md](ROADMAP.md)**，其中最重要的一条是：会话持久化被 `langgraph dev` 平台接管（`checkpointer` 不可配置），因此会话数据目前不在工作区内 —— 这与 spec 不符，方案待定。

---

## License

见 [LICENSE](LICENSE)。