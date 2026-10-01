/**
 * 工作区中间件：把「run 入口校验 / 会话归属 / 人设装载 / 首次引导注入 / 人设保护」放在一处。
 *
 * 单独成文件是为了让测试可以用一个假模型加载**生产用的同一份中间件**，
 * 直接断言「发给模型的消息」与「工具调用被如何拦截」，而不必构造真实模型。
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
 * 而且能顺手在同一处完成人设装载（同样是「只改本次系统提示词」的语义）。
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
import { readPersona, withPersona } from "./persona.js";
import { upsertWorkspaceSessionIndex } from "./sessions.js";

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
    }
    return undefined;
  },

  /**
   * 人设装载 + 首次引导注入：只改「本次发给模型的消息」。
   * - 人设：`AGENTS.md` 存在 → 追加 `<persona>` 段落；缺失 → 保持内置默认人设
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

    const persona = await readPersona(dir);
    if (persona) updates["systemMessage"] = withPersona(request.systemMessage, persona);

    if (isFirstUserInteraction(request.messages) && (await shouldInjectBootstrap(dir))) {
      if (await claimBootstrapTrigger(dir)) {
        updates["messages"] = prependGuidance(request.messages, BOOTSTRAP_GUIDANCE);
      }
    }

    if (Object.keys(updates).length === 0) return handler(request);
    return handler({ ...request, ...updates });
  },

  /**
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