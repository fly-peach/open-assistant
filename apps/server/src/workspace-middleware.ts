/**
 * 工作区中间件：把「run 入口校验 / 会话归属 / **agent 身份解析** / 人设与记忆装载 / 首次引导注入 / 人设与工具权限保护」放在一处。
 *
 * 单独成文件是为了让测试可以用一个假模型加载**生产用的同一份中间件**，
 * 直接断言「发给模型的消息」与「工具调用被如何拦截」，而不必构造真实模型。
 *
 * ## 两层中间件：为什么拆成两个
 *
 * - `agentBindingMiddleware`：**严格形态**。工作区没绑定 agent（或绑定的 agent 不存在 / 配置非法）
 *   → 在模型调用前拒绝（对齐 agent-binding「未绑定的工作区不得对话」）。生产图 `agent.ts` 用它。
 * - `workspaceMiddleware`：**兼容形态**。绑定存在时按绑定解析 agent（人设 / 记忆 / 工具白名单）；
 *   没有绑定时退回「工作区 AGENTS.md → 内置默认」的老行为。这样既满足三档人设装载，
 *   又不破坏既有单测（它们故意构造未绑定的临时工作区来测引导与人设保护）。
 *
 * 运行身份的唯一依据是 `<工作区>/.open-assistant/project.json` 里的绑定；
 * 客户端 run 传的 `configurable.agent_id` **一律不采信**（否则可以拿 A 工作区的文件用 B agent 的权限操作）。
 *
 * ## 首次引导的侵入点选择（tasks 9.6）
 *
 * 本项目是 LangGraph + `createDeepAgent`，没有 AgentScope 那种 pre-reasoning hook。
 * 可选的侵入点有三个：
 * 1. `beforeAgent` —— 只能返回 state 更新。改 messages 会把引导**永久写进 checkpoint**，
 *    之后每轮都在上下文里（等于长期生效），还会在界面上冒充用户消息；
 * 2. `wrapModelCall` —— 拿到的是「本次要发给模型的那一份 request」，改写它不回写 state；
 * 3. 包装模型调用（自己包一层 Runnable）—— 等价于 2 但要自己处理 tools 绑定与流式。
 *
 * 选 **2 (`wrapModelCall`)**：它天然满足 spec 的「本轮消息级注入 + 不污染系统提示词」，
 * 而且能顺手在同一处完成人设与记忆装载（同样是「只改本次系统提示词」的语义）。
 * 「只触发一次」由两件事共同保证：
 * - 本轮内：首次交互判定要求「只有一条用户消息、且没有助手回复」，第 2 次模型调用时消息里
 *   已经有 AIMessage，判定自然不再成立；
 * - 工作区内：注入前用 `wx` 占地写 `.open-assistant/.bootstrap_completed`（防重标记）。
 */
import { createMiddleware, ToolMessage } from "langchain";
import { getConfig } from "@langchain/langgraph";

import {
  BOOTSTRAP_FILE,
  PERSONA_FILE,
  WorkspaceError,
  normalizeWorkspacePath,
  readWorkspacePathFromConfig,
  resolveWorkspaceDir,
} from "./workspace.js";
import {
  BOOTSTRAP_GUIDANCE,
  claimBootstrapTrigger,
  isFirstUserInteraction,
  prependGuidance,
  shouldInjectBootstrap,
} from "./bootstrap.js";
import { loadPersona, withAgentMemory, withAgentSkills, withPersona } from "./persona.js";
import { stampThreadOwnership, upsertWorkspaceSessionIndex } from "./sessions.js";
import { AgentError } from "./agents/errors.js";
import { type AgentRuntime, resolveAgentRuntime } from "./agents/registry.js";
import { gateTool } from "./agents/config.js";
import { readBinding, readSessionOwners, stampSessionOwner } from "./binding.js";

/** 解析当前 run 的工作区绝对路径；缺失 → 抛错（拒绝对话） */
export function requireWorkspacePath(config?: unknown): string {
  const p = readWorkspacePathFromConfig(config ?? getConfig());
  if (!p) {
    throw new WorkspaceError(
      "WORKSPACE_MISSING",
      "未指定工作区：请在 run 的 config.configurable.workspace 中提供工作区绝对路径后再对话",
      400,
    );
  }
  return p;
}

/**
 * 按工作区绑定解析运行身份（唯一依据）。
 * - 未绑定 → null（调用方决定是拒绝还是走兼容回退）
 * - 已绑定但 agent 不存在 / 配置非法 → 抛 AgentError
 */
export async function resolveBoundAgent(workspaceDir: string): Promise<AgentRuntime | null> {
  const binding = await readBinding(workspaceDir);
  if (!binding) return null;
  return resolveAgentRuntime(binding.agentId);
}

/**
 * 严格形态：未绑定 / 绑定的 agent 不存在 / 配置非法 → 在模型调用前拒绝。
 * 只加进生产图（agent.ts），与 workspaceMiddleware 的兼容回退分开，便于单测复用后者。
 */
export const agentBindingMiddleware = createMiddleware({
  name: "AgentBindingMiddleware",
  beforeAgent: async () => {
    const config = getConfig() as { configurable?: Record<string, unknown> };
    const dir = await resolveWorkspaceDir(requireWorkspacePath(config));
    const binding = await readBinding(dir);
    if (!binding) {
      throw new AgentError(
        "AGENT_NOT_BOUND",
        "此工作区尚未绑定 agent：请先在「工作区 → 选择 agent」里为它选一个 agent，再开始对话",
        409,
      );
    }
    // 绑定的 agent 必须存在且配置合法，否则一样拒绝（MUST NOT 静默改用别的 agent）
    await resolveAgentRuntime(binding.agentId);
    return undefined;
  },
});

/** 可能覆盖 / 删除已有文件的工具 */
const WRITE_TOOLS = new Set(["write_file", "edit_file", "delete"]);

/** 是否指向人设文件（`/AGENTS.md`、`AGENTS.md`、`./AGENTS.md` 都算） */
export function isPersonaPath(filePath: unknown): boolean {
  if (typeof filePath !== "string") return false;
  return filePath.replace(/\\/g, "/").replace(/^\.?\/*/, "") === PERSONA_FILE;
}

export const workspaceMiddleware = createMiddleware({
  name: "WorkspaceMiddleware",

  /** run 入口：未指定 / 不存在 / 非目录 / 不可读写 / 是根 → 在模型调用前拒绝 */
  beforeAgent: async () => {
    const config = getConfig() as { configurable?: Record<string, unknown> };
    const dir = await resolveWorkspaceDir(requireWorkspacePath(config));
    // 会话索引落在工作区的应用数据子目录（`.open-assistant/sessions.json`），
    // 不散落到工作区根（对齐 session-store / 会话数据落工作区内）。
    const threadId = config.configurable?.["thread_id"];
    if (typeof threadId === "string" && threadId.length > 0) {
      await upsertWorkspaceSessionIndex(dir, { id: threadId });
      // 记录这条会话「创建时属于哪个 agent」（幂等，换绑后仍可追溯）。
      // 身份只认工作区绑定，绝不看客户端传来的 agent_id。
      const binding = await readBinding(dir);
      if (binding) {
        const owner = await stampSessionOwner(dir, threadId, binding.agentId);
        // 把归属**合并**写进平台 thread metadata，供会话列表按工作区过滤
        // （工作区 ↔ agent 1:1，所以按工作区过滤即按 agent 隔离会话）。
        // 失败不影响本轮对话（stampThreadOwnership 是 best-effort）。
        await stampThreadOwnership(threadId, { workspace: dir, agentId: owner });
      }
    }
    return undefined;
  },

  /**
   * 一轮结束 → 把这一轮落进工作区会话库（`<工作区>/.open-assistant/sessions.sqlite`）。
   *
   * 会话库是会话内容的**工作区事实源**（spec `session-store`「写入即时落盘」）。
   * 幂等：同一轮（同一 turnId）重复触发整体替换（afterAgent 一轮内可能触发多次）。
   *
   * best-effort：落库失败不抛（不影响本轮对话）。用动态 import，不碰 SQLite
   * 的调用方（如纯 JSON 单测）不必加载 `node:sqlite`。
   */
  afterAgent: async (state) => {
    try {
      // 会话库用 `node:sqlite`。本项目规矩：碰 SQLite 的测试用 Node 跑
      // （见 db.ts 顶部注释）。bun 下 node:sqlite 的句柄在 Windows 关连接后
      // 仍会锁住工作区文件（测试删临时目录时 EBUSY），故 bun 环境跳过落库，
      // 会话库的落库行为在 Node 侧（test:conversation）覆盖。
      if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return undefined;
      const config = getConfig() as { configurable?: Record<string, unknown> };
      const workspace = readWorkspacePathFromConfig(config);
      const threadId = config.configurable?.["thread_id"];
      if (!workspace || typeof threadId !== "string" || threadId.length === 0) return undefined;
      let dir: string;
      try {
        dir = normalizeWorkspacePath(workspace);
      } catch {
        return undefined;
      }
      const [binding, owners] = await Promise.all([
        readBinding(dir),
        readSessionOwners(dir).catch(() => ({}) as Record<string, string>),
      ]);
      const agentId = owners[threadId] ?? binding?.agentId ?? "unknown";
      const messages =
        (state as { messages?: import("@langchain/core/messages").BaseMessage[] } | undefined)
          ?.messages ?? [];
      const { recordTurnToWorkspace } = await import("./conversation/recording.js");
      recordTurnToWorkspace(dir, { threadId, agentId, messages });
    } catch {
      // best-effort：落库失败不影响本轮对话
    }
    return undefined;
  },

  /**
   * 人设与记忆装载 + 首次引导注入：只改「本次发给模型的消息」。
   * - 人设三档：agent 的 AGENTS.md → 工作区的 AGENTS.md（过渡期） → 内置默认（不注入）
   * - 记忆：绑定的 agent 的跨工作区长期记忆（非空才注入 `<agent_memory>`）
   * - 引导：`BOOTSTRAP.md` 存在 + 未触发过 + 首次用户交互 → 拼到本轮用户消息前
   */
  wrapModelCall: async (request, handler) => {
    const workspace = readWorkspacePathFromConfig({ configurable: request.runtime?.configurable });
    if (!workspace) return handler(request);

    let dir: string;
    try {
      dir = normalizeWorkspacePath(workspace);
    } catch {
      return handler(request);
    }

    const updates: Record<string, unknown> = {};

    // 绑定损坏 / agent 缺失：不静默换人，直接失败（生产路径由 agentBindingMiddleware 提前拦）
    const runtime = await resolveBoundAgent(dir);

    const persona = await loadPersona({
      agentDir: runtime?.dir ?? null,
      workspaceDir: dir,
    });
    if (persona.content) {
      updates["systemMessage"] = withPersona(request.systemMessage, persona.content);
    }
    if (runtime && runtime.memory.trim().length > 0) {
      const base = (updates["systemMessage"] as typeof request.systemMessage | undefined) ?? request.systemMessage;
      updates["systemMessage"] = withAgentMemory(base, runtime.memory);
    }
    // 技能渐进披露：只注入名称 + 用途（正文走 skill_read）
    if (runtime && runtime.skills.some((skill) => !skill.disabled)) {
      const base = (updates["systemMessage"] as typeof request.systemMessage | undefined) ?? request.systemMessage;
      updates["systemMessage"] = withAgentSkills(base, runtime.skills);
    }

    if (isFirstUserInteraction(request.messages) && (await shouldInjectBootstrap(dir))) {
      if (await claimBootstrapTrigger(dir)) {
        updates["messages"] = prependGuidance(request.messages, BOOTSTRAP_GUIDANCE);
      }
    }

    if (Object.keys(updates).length === 0) return handler(request);
    return handler({ ...request, ...updates });
  },

  /**
   * 工具权限 = 绑定 agent 的白名单（tasks 1.12）+ 人设保护（9.8）。
   *
   * 白名单先于人设保护：被 agent 配置关掉的工具组一律拿不到，无论它想碰什么文件。
   *
   * 人设保护：只保护 `AGENTS.md`（9.8）。
   * `BOOTSTRAP.md` 必须可删 —— 否则引导永远结束不了（design.md Decision #9 的权限后果）。
   *
   * 文件类工具（write_file / edit_file / delete）**任何时候**都不得碰 `AGENTS.md`，
   * 包括首次引导期间 —— 否则「agent 不能覆盖人设」这条就只在一半状态下成立。
   * 首次设定身份需要落盘的那一步走专用工具 `persona_write`（见 persona-tools.ts）：
   * 它只在 `BOOTSTRAP.md` 还在时可用，是一条显式、可审计的写人设通道。
   */
  wrapToolCall: async (request, handler) => {
    const toolName = request.toolCall.name;
    const args = (request.toolCall.args ?? {}) as Record<string, unknown>;

    // —— agent 工具白名单（权限边界，以工作区绑定为准）——
    const workspace = readWorkspacePathFromConfig({
      configurable: request.runtime?.configurable,
    });
    if (workspace) {
      let dir: string | null = null;
      try {
        dir = normalizeWorkspacePath(workspace);
      } catch {
        dir = null;
      }
      if (dir) {
        const runtime = await resolveBoundAgent(dir);
        if (runtime) {
          const gate = gateTool(runtime.config, toolName);
          if (!gate.allowed) {
            return new ToolMessage({
              content:
                `ERROR [TOOL_NOT_ALLOWED] agent「${runtime.config.name}」(${runtime.id}) 的工具白名单未开启` +
                `「${gate.group}」这一组，因此不能调用 ${toolName}。${gate.reason ?? ""}`,
              tool_call_id: request.toolCall.id ?? "",
              name: toolName,
            });
          }
        }
      }
    }

    if (!isPersonaPath(args["file_path"]) || !WRITE_TOOLS.has(toolName)) {
      return handler(request);
    }

    return new ToolMessage({
      content:
        `ERROR [PERSONA_PROTECTED] ${PERSONA_FILE} 是人设文件，不得覆盖或删除。` +
        `如果用户确实想改人设，请让他直接编辑该文件；` +
        `首次设定身份时用 persona_write 工具（仅在 ${BOOTSTRAP_FILE} 还在工作区里时可用）。`,
      tool_call_id: request.toolCall.id ?? "",
      name: toolName,
    });
  },
});