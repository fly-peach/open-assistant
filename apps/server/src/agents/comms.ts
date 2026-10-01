/**
 * 跨工作区 agent 通信（对齐 specs/multi-agent-comms 的「跨工作区调用」，
 * 设计参照 QwenPaw 的 `chat_with_agent`）。
 *
 * ## 机制
 *
 * agent A 想找 agent B：A 的会话里调 `ask_agent(to_agent, text)`；服务端
 * 1. **身份以绑定为准**：caller = A 工作区的绑定 agent（不采信客户端传来的 agent_id）；
 * 2. **权限**：B 必须在 A 配置的 `contactableAgents` 名单里（默认空 = 谁都不能找）；
 * 3. **对端在自己的工作区执行**：在 B 的工作区起/续一条会话，跑一轮（用 B 的人设 / 工具 / 记忆）；
 * 4. **两侧都留痕**：B 侧 `kind='main'` + `meta.initiator*`；A 侧 `kind='agent-call'` + `meta.peer*`；
 * 5. 结果回流给 A 本轮。
 *
 * ## 与 QwenPaw 的差异（有意）
 *
 * - 会话标识用 **uuid**（平台 `GET/PATCH /threads/{id}` 只接受 uuid）；对外仍是「一条对端会话」。
 * - 防递归：调用深度经 `configurable.agent_call_depth` 传递，超过上限直接拒绝（QwenPaw 靠 batch/超时约束）。
 * - 只做**前台**（问一句、等答复）；后台长任务复用现有的定时任务（jobs）体系。
 */
import crypto from "node:crypto";

import { getConfig } from "@langchain/langgraph";

import { readBinding } from "../binding.js";
import { readAgent } from "./registry.js";
import { AgentError } from "./errors.js";
import { createAgentClient } from "../sessions.js";
import {
  createAgentCallThread,
  createCalledThread,
  recordTurn,
  threadExists,
} from "../conversation/index.js";
import type { AgentConfig } from "./config.js";

/** 调用深度上限（默认 2：A→B 可以，B→C 后就不再允许继续往下调） */
export const MAX_AGENT_CALL_DEPTH = 2;

/** 图名（langgraph.json 的 graphs.assistant）；本机 dev 与部署都用它 */
function assistantId(): string {
  return process.env.ASSISTANT_ID ?? "assistant";
}

export interface ContactableAgent {
  id: string;
  name: string;
  description: string;
  /** 对端维护的工作区绝对路径；null = 还没指定（不可调用） */
  workspaceDir: string | null;
  /** 是否现在就可用（有工作区、且该工作区确实绑定它） */
  available: boolean;
}

/** 给对端消息加来源前缀（对齐 QwenPaw 的 `[Agent X requesting]`） */
export function identityPrefix(fromAgentId: string): string {
  return `[来自智能体 ${fromAgentId} 的请求] `;
}

/** 这条调用能不能发：B 必须在 A 的 contactableAgents 名单里（默认空 = 不能） */
export function canContact(caller: AgentConfig | null, toAgentId: string): boolean {
  if (!caller) return false;
  return caller.contactableAgents.includes(toAgentId);
}

/** 解析当前 run 的调用深度（A 直接发起 = 0） */
export function currentCallDepth(config?: unknown): number {
  const resolved = (config ?? getConfig()) as { configurable?: Record<string, unknown> } | undefined;
  const raw = resolved?.configurable?.["agent_call_depth"];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

interface AgentIdentity {
  agentId: string;
  workspaceDir: string;
  config: AgentConfig;
}

/** caller 身份：只认「工作区 → 绑定」，不看客户端传参 */
async function resolveCaller(callerWorkspaceDir: string): Promise<AgentIdentity> {
  const binding = await readBinding(callerWorkspaceDir);
  if (!binding) {
    throw new AgentError(
      "AGENT_NOT_BOUND",
      "当前工作区尚未绑定 agent：跨 agent 调用需要先知道「我是谁」",
      409,
    );
  }
  const def = await readAgent(binding.agentId);
  return { agentId: binding.agentId, workspaceDir: callerWorkspaceDir, config: def.config };
}

/** 目标身份：对端必须存在、有工作区、且该工作区确实绑它 */
async function resolveTarget(toAgentId: string): Promise<AgentIdentity> {
  const def = await readAgent(toAgentId);
  const workspaceDir = def.config.workspaceDir;
  if (!workspaceDir) {
    throw new AgentError(
      "AGENT_NO_WORKSPACE",
      `对端 agent「${toAgentId}」还没有指定工作区，无法调用`,
      409,
      "workspaceDir",
    );
  }
  const binding = await readBinding(workspaceDir).catch(() => null);
  if (!binding || binding.agentId !== toAgentId) {
    throw new AgentError(
      "AGENT_NO_WORKSPACE",
      `对端 agent「${toAgentId}」的工作区（${workspaceDir}）当前没有绑定它，无法调用`,
      409,
      "workspaceDir",
    );
  }
  return { agentId: toAgentId, workspaceDir, config: def.config };
}

/** 列出当前工作区绑定的 agent「可以联系」的对端 */
export async function listContactableAgents(
  callerWorkspaceDir: string,
): Promise<{ callerAgentId: string | null; agents: ContactableAgent[] }> {
  const binding = await readBinding(callerWorkspaceDir).catch(() => null);
  if (!binding) return { callerAgentId: null, agents: [] };
  const caller = await readAgent(binding.agentId).catch(() => null);
  const ids = caller?.config.contactableAgents ?? [];
  const agents: ContactableAgent[] = [];
  for (const id of ids) {
    try {
      const def = await readAgent(id);
      const workspaceDir = def.config.workspaceDir;
      let available = false;
      if (workspaceDir) {
        const target = await readBinding(workspaceDir).catch(() => null);
        available = target?.agentId === id;
      }
      agents.push({
        id,
        name: def.name,
        description: def.description,
        workspaceDir,
        available,
      });
    } catch {
      agents.push({ id, name: id, description: "", workspaceDir: null, available: false });
    }
  }
  return { callerAgentId: binding.agentId, agents };
}

export interface AskAgentInput {
  /** 发起方工作区（身份从它的绑定推导） */
  callerWorkspaceDir: string;
  toAgentId: string;
  text: string;
  /** 续用对端会话；缺省则新建 */
  sessionId?: string | undefined;
  /** 发起方当前会话（用于对端记录「发起方会话标识」） */
  callerThreadId?: string | undefined;
  /** 当前深度（从当前 run 的 configurable 取）；缺省 0 */
  depth?: number | undefined;
}

export interface AskAgentResult {
  reply: string;
  /** 对端会话标识（对端工作区里的 thread id；续聊把它传回来） */
  sessionId: string;
  /** 发起方这一侧记录的会话 id（`kind='agent-call'`） */
  callerThreadId: string;
  fromAgentId: string;
  toAgentId: string;
}

/** 从一轮 run 的最终状态里取最后一条 AI 文本 */
function lastAiText(state: unknown): string {
  const messages = (state as { messages?: unknown[] } | undefined)?.messages;
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { type?: unknown; content?: unknown };
    if (m?.type !== "ai") continue;
    const content = m.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) =>
          part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .join("");
      if (text.trim().length > 0) return text;
    }
  }
  return "";
}

/**
 * 让 agent B 在**它自己的工作区**里跑一轮，返回答复。
 * 两侧都会在工作区会话库里留下可查看的记录。
 */
export async function askAgent(input: AskAgentInput): Promise<AskAgentResult> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text.length === 0) {
    throw new AgentError("AGENT_INVALID_CONFIG", "text 不能为空", 400, "text");
  }
  const depth = input.depth ?? currentCallDepth();
  if (depth >= MAX_AGENT_CALL_DEPTH) {
    throw new AgentError(
      "AGENT_CALL_DEPTH_EXCEEDED",
      `agent 调用层数已达上限（${MAX_AGENT_CALL_DEPTH}），不再继续转派，请直接给用户答复`,
      409,
    );
  }

  const caller = await resolveCaller(input.callerWorkspaceDir);
  const target = await resolveTarget(input.toAgentId);
  if (!canContact(caller.config, target.agentId)) {
    throw new AgentError(
      "AGENT_NOT_CONTACTABLE",
      `不能联系 agent「${target.agentId}」：它不在「${caller.agentId}」的可联系名单里（在 agent 配置里加上后才能调用）`,
      403,
      "toAgentId",
    );
  }

  const sessionId = input.sessionId?.trim() || crypto.randomUUID();

  // B 侧：先把「被调用会话」记录下来（标明发起方），afterAgent 落库时会复用它
  if (!threadExists(target.workspaceDir, sessionId)) {
    createCalledThread(target.workspaceDir, {
      id: sessionId,
      agentId: target.agentId,
      initiatorAgentId: caller.agentId,
      initiatorThreadId: input.callerThreadId ?? sessionId,
      title: `来自「${caller.agentId}」的请求`,
    });
  }

  const client = createAgentClient();
  // 平台侧也要有这条 thread（runs 需要的 thread_id）；已存在则忽略
  await client.threads
    .create({ threadId: sessionId, metadata: { workspace: target.workspaceDir } })
    .catch(() => undefined);

  let reply = "";
  try {
    const result = await client.runs.wait(sessionId, assistantId(), {
      input: {
        messages: [{ type: "human", content: `${identityPrefix(caller.agentId)}${text}` }],
      },
      config: {
        configurable: {
          workspace: target.workspaceDir,
          agent_call_depth: depth + 1,
        },
      },
    });
    reply = lastAiText(result);
  } catch (err) {
    // 对端不可用时不挂起整轮：给出可理解的失败原因（spec「对端不可用时的处理」）
    const message = err instanceof Error ? err.message : String(err);
    throw new AgentError(
      "AGENT_CALL_FAILED",
      `调用 agent「${target.agentId}」失败：${message}`,
      502,
    );
  }

  // A 侧：记一条 agent-call 会话（标明对端 agent 与会话标识），并把这次往来落成一轮
  const callerRecordId = crypto.randomUUID();
  createAgentCallThread(caller.workspaceDir, {
    id: callerRecordId,
    agentId: caller.agentId,
    peerAgentId: target.agentId,
    peerThreadId: sessionId,
    title: `→ ${target.config.name}`,
  });
  recordTurn(caller.workspaceDir, {
    threadId: callerRecordId,
    userContent: text,
    messages: reply.length > 0 ? [{ role: "ai", kind: "text", content: reply }] : [],
    status: "done",
  });

  return {
    reply,
    sessionId,
    callerThreadId: callerRecordId,
    fromAgentId: caller.agentId,
    toAgentId: target.agentId,
  };
}

/** 对端会话是否已存在（前端/工具续聊时判断用） */
export function targetThreadExists(workspaceDir: string, sessionId: string): boolean {
  return threadExists(workspaceDir, sessionId);
}