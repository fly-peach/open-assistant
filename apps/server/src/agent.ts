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
 * - 子 agent 团队（`<agent>/team/<名>/SPEC.md`）在建图期装载成 deepagents 的 `subagents`
 *
 * ## 为什么出口是**工厂函数**（不是直接的 graph 对象）
 *
 * deepagents 的 `subagents` 是**建图期静态数组**（`spike/findings/01-delegation.md` §1.4），
 * 而团队声明是运行期文件：`langgraph.json` 若导出对象，模块加载时求值一次，
 * 之后改 SPEC.md 永远不生效。`@langchain/langgraph-api` 对「导出是函数」的图会在
 * **每次 run 用当次 config 调用一次**（`dist/graph/load.mjs` 的 function 分支），
 * 于是「按工作区 → 绑定 agent → 读 team/」就有地方落脚了。
 * 「改配置不改图拓扑」已在 `spike/findings/02-topology.md` 实证：重建图不影响进行中的会话。
 */
import { createMiddleware, ToolMessage } from "langchain";
import { RobustChatOpenAI } from "./model.js";
import { createDeepAgent, FilesystemBackend, type SubAgent } from "deepagents";

import { normalizeWorkspacePath, readWorkspacePathFromConfig } from "./workspace.js";
import {
  agentBindingMiddleware,
  requireWorkspacePath,
  resolveBoundAgent,
  workspaceMiddleware,
} from "./workspace-middleware.js";
import { modelMiddleware } from "./models/middleware.js";
import { buildChatModel, capabilityFor, resolveEffectiveModel } from "./models/resolve.js";
import { providerApiKey, readModelsFile } from "./models/store.js";
import {
  loadTeam,
  resolveSubAgentToolNames,
  type SubAgentMember,
  type SubAgentModelRef,
} from "./agents/team.js";
import type { AgentRuntime } from "./agents/registry.js";
import { personaTools } from "./persona-tools.js";
import { todoTools } from "./todo-tools.js";
import { memoryTools } from "./memory-tools.js";
import { skillTools } from "./skill-tools.js";
import { agentCommsTools } from "./agent-comms-tools.js";

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

## 分配任务给子 agent

- 我需要多步探索、大范围检索、或一件可以整块交出去的活时，用 task 工具把它派给子 agent。
  可选成员与各自的能力范围由 task 工具自己的描述给出（就在工具定义里，不在上面这段提示词里）。
- 子 agent 是**独立上下文**：它看不到我们这段对话，只能看到我在 task 里写的任务描述。
  所以派活时要把背景、目标、约束、期望产出一次说清楚；它跑完只回一段总结。
- 子 agent 与我在**同一个工作区**里干活，可以读写同样的文件（可用的工具由它的 SPEC.md 决定）。
- 需要我自己持续掌握上下文的活不要外派；对外部结果的准确性负责的是我，不是子 agent。

## 对话风格

- 直接、简洁，不铺垫、不复述用户的问题。
- 不确定的事情说不确定，不要编造文件内容或待办状态。
- 默认用中文回复；用户使用其他语言时跟随用户。`;

// —— 子 agent 团队（声明式；解析 / 校验在 src/agents/team.ts）——

/** 有实例的应用级工具。文件类工具（ls / read_file / …）由 deepagents 文件中间件提供，没有实例可传 */
const APP_TOOLS = [...todoTools, ...personaTools, ...memoryTools, ...skillTools, ...agentCommsTools];

/**
 * 子 agent 的工具白名单中间件。
 *
 * SPEC.md 的 `tools` 是**白名单**：没列进去的工具不给调用。
 * 主 agent 那层 gate（`workspace-middleware.ts` 的 `wrapToolCall`）对子 agent **不生效** ——
 * deepagents 给「非 fork 子 agent」只挂它自己的默认中间件栈，app 的 middleware 不会传下去
 * （`spike/findings/02-topology.md`）。所以这里显式补一层，
 * 否则「SPEC.md 里只写了 read_file，它却照样能 write_file」和
 * 「主 agent 关掉了 files 组，子 agent 仍能读写文件」都会成立。
 */
function toolWhitelistMiddleware(subAgentName: string, allowed: readonly string[]) {
  const verdict = new Set(allowed);
  return createMiddleware({
    name: "SubAgentToolWhitelist",
    wrapToolCall: async (request, handler) => {
      const toolName = request.toolCall.name;
      if (verdict.has(toolName)) return handler(request);
      return new ToolMessage({
        content:
          `ERROR [SUBAGENT_TOOL_NOT_ALLOWED] 子 agent「${subAgentName}」的工具白名单里没有 ${toolName}，` +
          `不能调用它。可用工具：${allowed.length > 0 ? allowed.join("、") : "（无）"}。`,
        tool_call_id: request.toolCall.id ?? "",
        name: toolName,
      });
    },
  });
}

/** 主 agent 当次 run 在用的模型（子 agent 缺省沿用它）；解析不出来 → null（退回建图期占位模型） */
async function resolveRunModel(workspace: string): Promise<RobustChatOpenAI | null> {
  try {
    const resolved = await resolveEffectiveModel(workspace);
    if (!resolved?.apiKey || !resolved.baseUrl) return null;
    return buildChatModel(resolved);
  } catch {
    return null;
  }
}

/**
 * SPEC.md 里显式指定的模型。解析不出来就**回落到主 agent 的模型**并留一行日志
 * —— 子 agent 因为「供应商被删了」整个不可用，不如退化成「用主模型」可用。
 */
async function resolveDeclaredModel(
  declared: SubAgentModelRef,
  fallback: RobustChatOpenAI | null,
): Promise<RobustChatOpenAI | null> {
  try {
    const file = await readModelsFile();
    const provider =
      declared.providerId !== undefined
        ? file.providers.find((p) => p.id === declared.providerId)
        : file.providers.find((p) => p.id === file.defaultProviderId);
    if (!provider || !provider.enabled) return fallback;
    const apiKey = providerApiKey(provider);
    if (!apiKey) return fallback;
    return buildChatModel({
      providerId: provider.id,
      providerName: provider.name,
      modelId: declared.id,
      baseUrl: provider.baseUrl,
      apiKey,
      vision: capabilityFor(file, provider.id, declared.id).vision,
      origin: "agent",
    });
  } catch (err) {
    console.warn(`[agent] 子 agent 指定模型 ${declared.id} 解析失败，回落主模型：`, err);
    return fallback;
  }
}

/** 把一份合法声明转成 deepagents 的 `SubAgent` 描述符 */
async function toSubAgentSpec(
  member: SubAgentMember,
  runtime: AgentRuntime,
  workspace: string,
  parentModel: RobustChatOpenAI | null,
): Promise<SubAgent> {
  const allowed = resolveSubAgentToolNames(member.tools, runtime.config);
  const model = member.model ? await resolveDeclaredModel(member.model, parentModel) : parentModel;
  if (member.mode !== "isolated") {
    console.warn(
      `[agent] 子 agent「${member.name}」声明 mode=${member.mode}，本版本统一按 isolated 建图：` +
        "fork 会把父对话一起带过去（token 成本）且上游标 experimental，`handoff` 底层会静默放行（我们已在解析层拒绝）。",
    );
  }
  return {
    name: member.name,
    description: member.description,
    // 正文**完全替换** deepagents 的内置提示词（内置约束一个字都不剩），
    // 所以 SPEC.md 正文必须是自足的完整提示词，不能写成「补充说明」。
    systemPrompt: member.systemPrompt,
    // 本变更只用 isolated：fork 会把父对话一起带过去（token 成本）且官方标 experimental
    // （`spike/findings/01-delegation.md` §1.4 / design D3b）。
    mode: "isolated",
    tools: APP_TOOLS.filter((tool) => allowed.includes(tool.name)),
    middleware: [toolWhitelistMiddleware(member.name, allowed)],
    ...(model ? { model } : {}),
    ...(member.skills && member.skills.length > 0 ? { skills: member.skills } : {}),
  };
}

/**
 * 按当次 run 的 config 装载团队。
 *
 * 任何一步失败都**不拖垮主 agent**：退化成「没有团队」照常工作
 * （对齐 spec「没有 team/ 目录 … SHALL 正常工作」「单个声明非法不得拖垮整个团队加载」）。
 */
async function loadSubAgents(config: unknown): Promise<SubAgent[]> {
  const raw = readWorkspacePathFromConfig(config);
  if (!raw) return [];
  try {
    const workspace = normalizeWorkspacePath(raw);
    const runtime = await resolveBoundAgent(workspace);
    if (!runtime) return [];
    const team = await loadTeam(runtime.id);
    if (team.issues.length > 0) {
      console.warn(
        `[agent] agent「${runtime.id}」有 ${team.issues.length} 条非法子 agent 声明，已跳过：` +
          team.issues.map((i) => `${i.name}(${i.code})`).join("、"),
      );
    }
    if (team.members.length === 0) return [];
    const parentModel = await resolveRunModel(workspace);
    const specs: SubAgent[] = [];
    for (const member of team.members) {
      try {
        specs.push(await toSubAgentSpec(member, runtime, workspace, parentModel));
      } catch (err) {
        console.warn(`[agent] 子 agent「${member.name}」装载失败，已跳过：`, err);
      }
    }
    return specs;
  } catch (err) {
    console.warn("[agent] 子 agent 团队装载失败，按「没有团队」继续：", err);
    return [];
  }
}

/**
 * 图出口：**工厂函数**（每次 run 用当次 config 求值一次，见文件头注释）。
 * 对象导出会让团队声明只在进程启动时读一次 —— 那是本变更要修的核心问题。
 */
export const agent = async (config?: unknown) => {
  const subagents = await loadSubAgents(config);
  return createDeepAgent({
    model,
    systemPrompt: SYSTEM_PROMPT,
    tools: APP_TOOLS,
    backend: () => {
      // beforeAgent 已完成存在性 / 可读写校验；这里只需词法归一化即可作为 backend 根
      const dir = normalizeWorkspacePath(requireWorkspacePath());
      return new FilesystemBackend({ rootDir: dir, virtualMode: true });
    },
    middleware: [agentBindingMiddleware, workspaceMiddleware, modelMiddleware],
    subagents,
  });
};