/**
 * open-assistant · manager deep agent
 *
 * 设计要点：
 * - 用 `createDeepAgent` 拿到一个编译好的 LangGraph graph
 * - 文件操作落到「当前 run 指定工作区」：backend 工厂按
 *   `config.configurable.workspace`（工作区绝对路径）构造
 *   `FilesystemBackend({ virtualMode: true })`
 * - 工作区校验 / 人设装载 / 首次引导 / 人设保护都在 `workspaceMiddleware`
 *   （见 workspace-middleware.ts 顶部注释里的侵入点选择说明）
 * - 自研 TODO 工具直接读写工作区内的 `todos.json`
 */
import { RobustChatOpenAI } from "./model.js";
import { createDeepAgent, FilesystemBackend } from "deepagents";

import { normalizeWorkspacePath } from "./workspace.js";
import {
  agentBindingMiddleware,
  requireWorkspacePath,
  workspaceMiddleware,
} from "./workspace-middleware.js";
import { modelMiddleware } from "./models/middleware.js";
import { personaTools } from "./persona-tools.js";
import { todoTools } from "./todo-tools.js";
import { memoryTools } from "./memory-tools.js";

const MODEL_ID = process.env.MODEL_ID ?? "deepseek-v4.1-flash";

const MODEL_BASE_URL =
  process.env.MODEL_BASE_URL ??
  "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

/**
 * 建图用的占位模型（**不是**运行期真正在用的那个）。
 *
 * 每轮真正用哪个模型，由 `modelMiddleware` 在 `wrapModelCall` 里按
 * 「工作区 → 绑定 agent → config.json 的 model → models.json 的供应商」解析后替换掉
 * （见 `models/middleware.ts`）。这里只是 `createDeepAgent` 建图时必须给一个。
 *
 * 所以 apiKey 缺失时**不让它抛**：旧写法用 `process.env.MODEL_API_KEY`（可能 undefined），
 * `@langchain/openai` 会在构造时就抛，结果是「还没配 key 的新用户连服务都起不来、
 * 连配置页都打不开」——恰好在最需要配置页的时候用不了。改成占位串后服务能起，
 * 真去对话时由 `beforeAgent` 抛 `MODEL_NOT_CONFIGURED` 给出可照做的提示。
 */
const model = new RobustChatOpenAI({
  model: MODEL_ID,
  apiKey: process.env.MODEL_API_KEY ?? "no-api-key-configured",
  temperature: 0,
  configuration: {
    baseURL: MODEL_BASE_URL,
  },
});

const SYSTEM_PROMPT = `你是用户的个人助手，负责帮用户管理待办、整理信息、维护工作区文件。

## 工作方式

- 面对多步任务时，先用待办清单把任务拆开，再逐步执行；每完成一步就更新清单状态。
- 待办事项通过工具管理：todo_list 查看、todo_create 新建、todo_update 更新、todo_delete 删除。
  待办以工作区内的 todos.json 为唯一事实源，人与你看到的都是同一份。
- 需要留存的信息写进工作区文件，不要只停留在对话里 —— 对话会被压缩，文件不会。
- 你的全部文件操作都被限制在当前工作区内；引用文件内容时给出工作区内的具体路径。
- 人设文件 AGENTS.md 每轮都会读进你的系统提示词（如果它存在的话）。
  write_file / edit_file / delete 任何时候都不能改它 —— 它代表用户对你的长期设定。
  只有首次设定身份时用 persona_write 工具写它（工作区里还有 BOOTSTRAP.md 时才可用）。
- 引用待办条目时保持清单中的措辞一致。

## 关于我的身份与记忆

- 我的人设、工具白名单与权限来自**当前工作区绑定的 agent 定义**（agents 根下该 agent 的 AGENTS.md / config.json）。
  人设每轮读入系统提示词的「persona」段落；工具白名单是硬边界，被关掉的工具组我拿不到。
- 我的长期记忆（跨工作区共享）会以「agent_memory」段落出现在系统提示词里；
  只属于当前项目的事实请写进工作区文件，不要当成长期记忆。
- 运行身份以工作区绑定为准：我不会因为请求里带了别的 agent 标识就换用别人的工具或记忆。

## 对话风格

- 直接、简洁，不铺垫、不复述用户的问题。
- 不确定的事情说不确定，不要编造文件内容或待办状态。
- 默认用中文回复；用户使用其他语言时跟随用户。`;

export const agent = createDeepAgent({
  model,
  systemPrompt: SYSTEM_PROMPT,
  tools: [...todoTools, ...personaTools, ...memoryTools],
  backend: () => {
    // beforeAgent 已完成存在性 / 可读写校验；这里只需词法归一化即可作为 backend 根
    const dir = normalizeWorkspacePath(requireWorkspacePath());
    return new FilesystemBackend({ rootDir: dir, virtualMode: true });
  },
  middleware: [agentBindingMiddleware, workspaceMiddleware, modelMiddleware],
});