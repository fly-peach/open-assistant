## Context

见 `proposal.md`。当前可运行状态与约束：

- **基座**：`apps/web` 是从 `langchain-ai/deep-agents-ui` 搬来的 Next.js 16 + React 19 + Tailwind 3 + Radix 前端（35 个源文件 / 2914 行），数据层用 `@langchain/langgraph-sdk/react` 的 `useStream`。**没有 antd，没有 i18n 框架。**
- **后端**：`apps/server` 是 `createDeepAgent` + `langgraph dev`，state 顶层已有 `messages` / `files`（`files` 形如 `{ [path]: { content, mimeType, created_at, modified_at } }`）。
- **已实测的两个关键事实**：① 模型思考在 `additional_kwargs.reasoning_content`（**partial 里是累积值，不是 delta**）；② `todos` **不是默认 state key**，只有 agent 真调 planning 工具后才出现。
- **参考实现**：QwenPaw console 有 `ToolCards/`（26 张专属卡片 + `ToolCardShell` 外壳）与 `features/files-workspace/`（自绘可拖拽抽屉 + 懒加载文件树 + 预览分流），调研见 `.scratch/research/qwenpaw-toolcards.md`、`.scratch/research/qwenpaw-files-workspace.md`。
- **环境**：包管理统一 bun；两个 dev server（3000 前端 / 2024 后端）；浏览器验证可用 `BU_CDP_URL=http://127.0.0.1:9222 browser-use`。

## Goals / Non-Goals

**Goals:**
- 把「平铺事件流」的对话 UI 改造成有层级的「回合 + 步骤」结构
- 工具调用按类型专门呈现，未登记工具有兜底
- 界面全中文
- 右侧可拖拽工作区侧边栏（文件树 + 按类型分流渲染 + TODO 专用视图）
- TODO 以 JSON 为唯一事实源，人和 agent 都能改，并发安全
- 工作区与对话强绑定：未指定工作区不得对话；会话数据落在工作区内

**Non-Goals:**
- 不做 i18n 框架与多语言切换（只做中文，但文案集中存放）
- 不引入 antd / Monaco（QwenPaw 参考实现里的这两块必须换掉）
- 不实现文件树的新建/重命名/删除（QwenPaw 后端也没有这些端点）
- 不做真 diff 算法（见 Decisions 第 5 条）
- 不迁移到 `@langchain/react` v1（本轮继续用现有 `useStream`，见 Open Questions）

## Decisions

### 1. 工具卡片：注册表 + 专属卡片 + 通用兜底（照搬 QwenPaw 架构，换掉 UI 库）

**做法**：`ToolCardShell`（原生 `<details>/<summary>` 承载折叠 + 三态 + 懒挂载）+ `BUILTIN_CARD_REGISTRY`（工具名 → 卡片组件）+ `withGenericFallback` 兜底。

**为什么**：QwenPaw 实测每张卡只需 ~15 行，因为外壳承担了折叠/状态/错误分区；错误态由外壳直接返回、**不渲染 children**，卡片作者不用处理错误。这比「一个通用 ToolCallBox + 大量 if-else」可维护得多。

**替代方案**：① 继续用单一 `ToolCallBox`（现状，已被否决——截图证实可读性差）；② 直接引入 antd 用 QwenPaw 原码（否决：基座是 Tailwind + Radix，引 antd 会造成两套设计系统且包体巨大）。

**迁移红线**：QwenPaw 里只有 `MediaPreview.tsx`（antd Image/Alert + `@agentscope-ai/design`）与 `ToolCallControlPopover.tsx`（antd message）依赖 antd；后者可整块砍掉。

### 2. 回合聚合放在前端，不改后端

**问题**：一次 assistant 回答会产出**多条 AI 消息**（think→tool→think→tool→…→answer），现状渲染成一串互不相干的平级条目。

**做法**：前端把「同一次提交产生的多条 AI 消息」聚合为一个回合容器，按 `tool_call.id` 把子消息挂到根消息下；容器内步骤可折叠，结论常驻可见。

**为什么**：后端 state 里 `messages` 本来就是平铺的（这是 LangGraph 的语义），改变它要动核心图结构、风险高且影响 checkpoint 兼容性。聚合是纯呈现问题。

**替代方案**：在后端把中间步骤折叠成自定义 state key（否决：改动大、破坏与官方 streaming 模式的兼容）。

### 3. 工作区 = 用户本机的一个真实目录（绝对路径），不是服务端自建的 id 目录

**做法**：`config.configurable.workspace` 传的是**用户选中目录的绝对路径**。前端把当前工作区在 URL 查询参数（可分享）+ localStorage（可记忆）；后端在 run 入口与工具层两处校验：缺失 / 不存在 / 不是目录 / 不可读写 / 是文件系统根 → 拒绝。

**为什么**：使用者的真实需求是「让助手指向**我自己的文件夹**」（像编辑器打开一个目录），而不是指向服务端沙箱里一个与外界无关的虚拟目录。id 模型下用户无法把工作区定在自己已有的项目/笔记目录上，也无法在文件管理器里直接看到 agent 写的东西。

**目录浏览**：浏览器无法向服务端传递本机真实路径（File System Access API 只给 handle，不给路径），因此由**后端提供一层目录浏览接口**（无起始路径时列磁盘/根，给定路径时列其子目录，只列目录），前端做成选择器。

**应用数据位置**：会话索引/配置放 `<工作区>/.open-assistant/`（隐藏子目录），**不散落到用户目录根**；人设 `AGENTS.md` 与 `todos.json` 仍在工作区根（人可读可改、能在文件树里看到）。

**不侵入用户目录**：仅当选中目录为空时才生成骨架文件；目录非空则一个文件也不动（人设缺失已有回退默认人设的 spec 兜底）。

**路径校验**：绝对路径；存在或可创建；是目录；可读写；**拒绝文件系统根**（`C:\`、`/`）以免 agent 拿到整盘范围；用 `realpath` 归一化后判重，避免大小写/尾斜杠差异造成同一目录两个身份。

**替代方案**：① 服务端自建 id 目录（已实现后否决 —— 无法指向用户自己的文件夹，违背使用意图）；② 浏览器 `showDirectoryPicker()`（否决 —— 拿不到真实路径，后端无法访问）；③ 允许选文件系统根（否决 —— 范围过大且误操作代价高）。

**迁移**：旧 id 工作区本身就落在磁盘上（如 `apps/server/.workspaces/default`），它**天然就是一个合法的绝对路径**，无需数据迁移；只需在 UI 上不再以 id 展示，而以路径展示。

### 4. TODO 存储：工作区内单文件 + 原子写 + 乐观并发

**做法**：`<workspace>/todos.json`，结构 `{ version, updatedAt, todos: [...] }`。写入用「临时文件 + rename」保证原子性；带 `updatedAt`/`etag` 做乐观并发，冲突返回 409 而非覆盖。

**为什么**：spec 要求「人工编辑被采纳」「不静默清空」「并发不互相覆盖」。单文件 JSON 是人和 agent 的交集最小公倍数（人能直接编辑，agent 能整体读写）；原子替换避免读者看到半截文件。

**替代方案**：① SQLite（否决：人不可直接编辑，违背 spec）；② 每条 TODO 一个文件（否决：列表操作要扫目录，且并发冲突概率更高）。

### 5. 文件改动呈现为「增删对照」而非真 diff

**做法**：修改类工具展示时，把被替换内容标为删除、新内容标为新增，分色呈现。**不做行级 diff 算法。**

**为什么**：QwenPaw 实测就是「全量 `-` old_text在前、全量 `+` new_text 在后」，无库、无行号、无上下文。spec 只要求「删除部分与新增部分可区分」，不要求行级精确 diff。

**补充**：QwenPaw 的参数键是 `old_text` / `new_text`，DeepAgents 的是 `old_string` / `new_string` —— 适配层需兼容两套键名，否则卡片拿不到参数。

### 6. 中文：硬编码 + 文案集中

**做法**：不做 i18n 框架，但所有界面文案集中到 `apps/web/src/i18n/zh.ts` 导出常量。

**为什么**：spec 只要求「默认中文、不中英混杂」，不要求多语言。集中在单文件使将来抽 i18n 成本可控，也便于用 grep 找出漏翻的英文。

**替代方案**：直接引入 next-intl（否决：本轮无多语言需求，徒增复杂度）。

### 7. 文件渲染分流：按扩展名，复用基座已有依赖

**做法**：`getPreviewType(ext)` → `json | markdown | code | image | text | unsupported`。代码高亮复用基座已装的 `react-syntax-highlighter`，Markdown 复用 `react-markdown`，**不引入 Monaco**。

**为什么**：基座已有这两个库且已被 `MarkdownContent` 使用；Monaco 体积大、且 spec 不要求编辑代码。

### 8. 文件树：服务端逐层懒加载

**做法**：后端提供「列举某目录下一层」的接口（目录优先排序、跳过 `.` 开头与 `node_modules`），前端按需请求。

**为什么**：一次拉全量在 `node_modules` 级别目录会卡死（spec 要求「大目录不阻塞」）。

### 9. 初始化 = 显式按钮，只写两件套（`AGENTS.md` + `BOOTSTRAP.md`）

**做法**：选定目录后**不写任何文件**；界面展示「初始化」按钮，用户点了才向工作区写入初始文件。初始化幂等（只补缺失、绝不覆盖）。写入的物料只有两个：`AGENTS.md`（人设）与 `BOOTSTRAP.md`（首次引导）。

**为什么不用 QwenPaw 的三件套**（`PROFILE.md` / `SOUL.md` / `MEMORY.md`）：那套分工服务于「多层身份 + 长期记忆」，而我们当前的人设装配只读 `AGENTS.md`。先用一个文件把人设装完，避免一份身份散落在两个文件里、也让「人设文件保护」的规则只需盯一个目标。将来真需要拆分时，再把 section 拆成独立文件也不迟。

**为什么把初始化做成显式动作**（而不是「目录为空就自动写」）：工作区现在是**用户的真实目录**，可能是他们的笔记/项目目录。往别人的目录里悄悄扔文件是不可接受的；显式按钮让「会写什么」在点击前就说清楚，也天然解决了非空目录的问题（只补缺的，不动已有的）。

**首次引导的落地方式**：抄 QwenPaw 的机制但不抄它的文件体系 ——
- 触发：`BOOTSTRAP.md` 存在 **且** `.bootstrap_completed` 标记不存在 **且** 是首次用户交互
- 动作：把引导指示拼到**本轮用户消息前**（不写进系统提示词，避免永久生效），随后立即写入 `.bootstrap_completed` 防重
- 结束：助手把人设写进 `AGENTS.md` 后删除 `BOOTSTRAP.md`

**权限后果**：助手必须能删除 `BOOTSTRAP.md` —— 这与人设文件保护规则有冲突，需把人设保护收窄为「保护 `AGENTS.md`」，而 `BOOTSTRAP.md` 可删。

**替代方案**：① 自动写骨架（已否决，侵入用户目录）；② 做一个 onboarding 表单让用户填身份（否决，人设应该是对话出来的而不是填表出来的）。

### 10. 壳层：左导航 + 顶栏 + 内容区 + 可停靠面板 + 插槽（参考 QwenPaw）

**问题**：现在的前端是「单页聊天 + 一个右侧工作区栏」。而 roadmap 上还有 cron、heartbeat、wiki、TODO、子 agent 管理、设置——若没有壳层，每加一个功能就要重排一次界面，且对话页会被越塞越满。

**做法**（抽出 QwenPaw console 的壳层，但按我们的栈重写，不引 antd）：
1. **左导航栏**承载多页（对话 / 工作区 / 待办 / 定时 / 记忆 / 设置 …），与业务页面解耦
2. **顶部栏**常驻跨页操作（当前工作区、设置入口），**不随页面重建**
3. **内容区**只换路由页面，外面套 **Suspense + 页面级错误边界**——单页崩了不拖垮外壳
4. **可停靠侧边面板**：侧边内容（工作区文件、会话列表）能贴边也能拖出来悬浮；关键是**一个稳定子树，停靠只改呈现不改归属**（内容不重建、状态不丢）
5. **导航条目可配置**：用户可拖拽排序、隐藏扩展条目；核心条目（对话/设置）固定不可隐藏；可一键重置；配置时提供预览
6. **扩展插槽**：`content.statusBar` / `overlay.global` 式的固定注入点，新功能不必改壳

**为何要可停靠而不是固定右栏**：① 写代码/看文件时用户希望文件面板铺在侧边；② 只想快速瞟一眼时又不愿它占地。QwenPaw 的 `DockableSidebar` 实测就是这么做的：拖出超阈值就悬浮，拖回边侧就吸附，带视口约束、键盘可达与 `prefers-reduced-motion` 尊重。

**替代方案**：① 固定右栏 + 拖宽（已实现，但不够用：无法让位也无法悬浮）；② 弹窗式文件浏览（否决：遮住对话，且不能边聊边看）；③ 直接引 antd Layout/Sider（否决：基座是 Tailwind + Radix，两套设计系统会拉扯）。

**为何现在才加**：工作机制未定前就抽壳层是过度设计。现在功能清单与信息架构已经清楚了，而且下一个要加的就是 cron 与子 agent 管理——都是新页面，正是抽壳层的时机。

## Risks / Trade-offs

- **[已有会话数据没有工作区归属]** → 迁移：启动时把无归属的历史 thread 归入默认工作区并记录迁移日志；无法归属的标记为「历史遗留」不可续聊，但数据不删。
- **[前端回合聚合可能与 SDK 消息顺序不一致]** → 以 `tool_call.id` 为唯一关联键；聚合结果做快照测试覆盖「单轮多工具」「工具报错」「无思考」三类形态。
- **[`reasoning_content` 是累积值，容易被当 delta 拼]** → 已在 `extractReasoningFromMessage` 注释中固定该约束；渲染取整体值。
- **[`todos` 不是默认 state key]** → 本变更后 TODO 由自研工具写 `todos.json` 文件（唯一事实源），**不再依赖 planning 工具的 state**；UI 从文件读，不从 `stream.values.todos` 读。
- **[工作区绑定会打断现有「直接打开就聊」的体验]** → 提供默认工作区并在首次进入时自动选中，使默认路径仍是一步可用；仅在用户显式清空选择时才阻止对话。
- **[QwenPaw 卡片依赖其私有工具名与参数键]** → 适配层统一做键名归一化（`old_text`/`old_string` 等），并对未匹配的工具走通用兜底。
- **[上游 `@langchain/openai` 的 role 缺失 bug 会让整轮 run 硬失败]** 实测：带 `tools` 时 provider 会间歇性省略首个流式 delta 的 `role`，转换器于是产出 `ChatMessageChunk`（`type: "generic"`），而 `AgentNode` 只接受 `AIMessage | Command` → 报 `Invalid response from "wrapModelCall" ... expected AIMessage or Command, got object`（报错里的 middleware 名是**误导性的**，那只是最内层做透传的那一个）。约 25% 概率失败，短回复更易触发。
  → Mitigation：用 `RobustChatOpenAI`（继承 `ChatOpenAICompletions`，**不能**继承根导出的 `ChatOpenAI` —— 它是个门面，内部委托，方法不在它上面）覆写 `_convertCompletionsDeltaToBaseMessageChunk`，在 delta 缺 role 时补 `"assistant"`。回归测试 `tests/model.test.ts` + 探针 `probe:patch`（修复前 25% 失败 → 修复后 30/30）。详情与证据在 `src/model.ts` 注释里。

## Migration Plan

1. 后端新增工作区解析与校验 → 老会话在首次读取时补写 `workspace` 归属（默认工作区）
2. 前端加工作区选择（默认自动选中默认工作区）→ 不打断现有流程
3. TODO：首次运行时若 `todos.json` 不存在则不创建（视为空），首次写入时才落盘
4. 回滚：前端与后端各自独立；回滚前端即回到旧 UI，后端校验可通过配置关闭（默认开启）

## Open Questions

- 是否迁移到 `@langchain/react` v1（`stream.subagents` / scoped selector）：本轮不需要（无子 agent），留到子 agent 阶段。**该问题不影响本变更的 spec 与任务拆分。**
- TODO 是否需要优先级 / 截止日期 / 标签字段：spec 只要求「足够排序筛选追溯来源」的最小集，扩展字段留到验收后。**不影响任务拆分。**
- 工具卡片是否要覆盖全部 DeepAgents 内置工具：按 spec 只要求「常见文件类工具有专属呈现 + 其余有兜底」。**不影响任务拆分。**