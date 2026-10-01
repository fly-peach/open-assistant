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
import { requireWorkspacePath, workspaceMiddleware } from "./workspace-middleware.js";
import { personaTools } from "./persona-tools.js";
import { todoTools } from "./todo-tools.js";

const MODEL_ID = process.env.MODEL_ID ?? "deepseek-v4.1-flash";

const MODEL_BASE_URL =
  process.env.MODEL_BASE_URL ??
  "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

const model = new RobustChatOpenAI({
  model: MODEL_ID,
  apiKey: process.env.MODEL_API_KEY,
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

## 对话风格

- 直接、简洁，不铺垫、不复述用户的问题。
- 不确定的事情说不确定，不要编造文件内容或待办状态。
- 默认用中文回复；用户使用其他语言时跟随用户。`;

export const agent = createDeepAgent({
  model,
  systemPrompt: SYSTEM_PROMPT,
  tools: [...todoTools, ...personaTools],
  backend: () => {
    // beforeAgent 已完成存在性 / 可读写校验；这里只需词法归一化即可作为 backend 根
    const dir = normalizeWorkspacePath(requireWorkspacePath());
    return new FilesystemBackend({ rootDir: dir, virtualMode: true });
  },
  middleware: [workspaceMiddleware],
});