import type { Message } from "@langchain/langgraph-sdk";
import type { ToolCall } from "@/app/types/types";
import {
  extractReasoningFromMessage,
  extractStringFromMessageContent,
} from "@/app/utils/utils";
import { looksLikeToolError } from "@/app/utils/toolResult";

/** 一个回合里的「过程」条目：一条 AI 消息及其声明的工具调用。 */
export interface TurnStep {
  kind: "assistant";
  message: Message;
  reasoning: string;
  toolCalls: ToolCall[];
}

/** 没有配对工具调用的孤立工具结果（异常兜底，保证不丢信息）。 */
export interface OrphanToolStep {
  kind: "orphan-tool";
  message: Message;
  toolCall: ToolCall;
}

export type ProcessStep = TurnStep | OrphanToolStep;

export interface Turn {
  /** 稳定 key：优先用触发该回合的用户消息 id。 */
  id: string;
  /** 触发该回合的用户消息（可能存在无 user 的尾巴回合）。 */
  user?: Message;
  /** 过程：思考 + 工具调用，可折叠。 */
  process: ProcessStep[];
  /** 结论：面向用户的答复，常驻可见。 */
  conclusion?: Message;
  /** 结论消息自己声明的工具调用（极少见，但仍要能渲染）。 */
  conclusionToolCalls: ToolCall[];
  /** 该回合是否包含失败的工具调用（用于折叠行提示）。 */
  hasFailedTool: boolean;
}

type RawToolCall = {
  id?: string;
  function?: { name?: string; arguments?: unknown };
  name?: string;
  type?: string;
  args?: unknown;
  input?: unknown;
};

/** 从 AI 消息里抽出工具调用（兼容三种后端形态）。 */
export function extractToolCalls(
  message: Message,
  interrupted: boolean
): ToolCall[] {
  const fromMessage: RawToolCall[] = [];
  const additional = message.additional_kwargs?.tool_calls;
  const rawToolCalls = (message as { tool_calls?: RawToolCall[] }).tool_calls;
  if (Array.isArray(additional) && additional.length > 0) {
    fromMessage.push(...(additional as RawToolCall[]));
  } else if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
    fromMessage.push(
      ...rawToolCalls.filter((toolCall) => toolCall.name !== "")
    );
  } else if (Array.isArray(message.content)) {
    fromMessage.push(
      ...(message.content as RawToolCall[]).filter(
        (block) => block.type === "tool_use"
      )
    );
  }

  return fromMessage.map((toolCall, index) => {
    const name =
      toolCall.function?.name || toolCall.name || toolCall.type || "unknown";
    const args =
      toolCall.function?.arguments || toolCall.args || toolCall.input || {};
    return {
      id: toolCall.id || `tool-${index}`,
      name,
      args: (typeof args === "string" ? safeJsonParse(args) : args) as Record<
        string,
        unknown
      >,
      status: interrupted ? "interrupted" : "pending",
    } as ToolCall;
  });
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function hasText(message: Message): boolean {
  return extractStringFromMessageContent(message).trim() !== "";
}

function reasoningOf(message: Message): string {
  return extractReasoningFromMessage(message);
}

/**
 * 把平铺的消息流聚合成「回合」。
 *
 * 为什么在前端做：后端 state 里 `messages` 本来就是平铺的（LangGraph 语义），
 * 一次 assistant 回答会产出多条 AI 消息（think→tool→think→tool→…→answer）。
 * 聚合是纯呈现问题，改后端要动核心图结构（见 design.md Decisions #2）。
 *
 * 关联键：`tool_call.id`。工具结果通过 `tool_call_id` 回填到声明它的那条 AI 消息上。
 */
export function groupMessagesIntoTurns(
  messages: Message[],
  interrupted = false
): Turn[] {
  // 1) 先建立 tool_call_id → 结果 的索引
  const resultsById = new Map<
    string,
    { status: ToolCall["status"]; result: string }
  >();
  for (const message of messages) {
    if (message.type !== "tool") continue;
    const id = message.tool_call_id;
    if (!id) continue;
    const text = extractStringFromMessageContent(message);
    // 后端把工具失败也放在 content 文本里（如 "Error: ..."），
    // 这里只在消息显式标记 status 时才认为失败，避免误判。
    const status: ToolCall["status"] =
      (message as { status?: string }).status === "error"
        ? "error"
        : "completed";
    resultsById.set(id, { status, result: text });
  }

  const consumedResultIds = new Set<string>();
  const turns: Turn[] = [];
  let current: Turn | null = null;

  const pushCurrent = () => {
    if (current) turns.push(current);
    current = null;
  };

  const ensureTurn = (): Turn => {
    if (!current) {
      current = {
        id: `turn-${turns.length}`,
        process: [],
        conclusionToolCalls: [],
        hasFailedTool: false,
      };
    }
    return current;
  };

  for (const message of messages) {
    if (message.type === "human") {
      pushCurrent();
      current = {
        id: message.id ?? `turn-${turns.length}`,
        user: message,
        process: [],
        conclusionToolCalls: [],
        hasFailedTool: false,
      };
      continue;
    }

    if (message.type === "ai") {
      const turn = ensureTurn();
      const toolCalls = extractToolCalls(message, interrupted).map((call) => {
        const found = resultsById.get(call.id);
        if (!found) return call;
        consumedResultIds.add(call.id);
        return { ...call, status: found.status, result: found.result };
      });
      turn.process.push({
        kind: "assistant",
        message,
        reasoning: reasoningOf(message),
        toolCalls,
      });
      continue;
    }

    if (message.type === "tool") {
      const turn = ensureTurn();
      const id = message.tool_call_id;
      if (id && !consumedResultIds.has(id)) {
        // 找不到声明者：作为孤立步骤呈现，绝不丢信息。
        const text = extractStringFromMessageContent(message);
        turn.process.push({
          kind: "orphan-tool",
          message,
          toolCall: {
            id: id || `orphan-${turn.process.length}`,
            name: (message as { name?: string }).name ?? "unknown",
            args: {},
            result: text,
            status: "completed",
          },
        });
        consumedResultIds.add(id);
      }
      continue;
    }

    // 其它类型（system 等）：不影响回合结构。
  }
  pushCurrent();

  // 2) 每个回合挑出「结论」：最后一条有正文、且没有工具调用的 AI 消息；
  //    没有这样的人选时退化为最后一条有正文的 AI 消息。
  for (const turn of turns) {
    const indexes = turn.process
      .map((step, index) => ({ step, index }))
      .filter((entry) => entry.step.kind === "assistant");

    let conclusionIndex = -1;
    for (let i = indexes.length - 1; i >= 0; i -= 1) {
      const step = indexes[i].step as TurnStep;
      if (hasText(step.message)) {
        conclusionIndex = indexes[i].index;
        break;
      }
    }
    const withoutToolCalls = indexes.filter(
      (entry) =>
        (entry.step as TurnStep).toolCalls.length === 0 &&
        hasText((entry.step as TurnStep).message)
    );
    if (withoutToolCalls.length > 0) {
      conclusionIndex = withoutToolCalls[withoutToolCalls.length - 1].index;
    }

    if (conclusionIndex >= 0) {
      const [step] = turn.process.splice(conclusionIndex, 1);
      const assistantStep = step as TurnStep;
      turn.conclusion = assistantStep.message;
      turn.conclusionToolCalls = assistantStep.toolCalls;
    }

    turn.hasFailedTool = turn.process.some(
      (step) =>
        step.kind === "assistant" &&
        step.toolCalls.some(
          (call) =>
            call.status === "error" ||
            call.status === "interrupted" ||
            // 后端把部分失败报成 success，正文才是真相。
            looksLikeToolError(call.result)
        )
    );
  }

  // 3) 丢掉既没有过程也没有结论的空回合（例如只有一条孤立 human 之外的空壳）。
  return turns.filter(
    (turn) => turn.user !== undefined || turn.process.length > 0 || turn.conclusion
  );
}

/** 回合里的步骤总数（用于「已处理 N 个步骤」）。 */
export function countSteps(turn: Turn): number {
  return (
    turn.process.reduce((sum, step) => {
      if (step.kind !== "assistant") return sum + 1;
      return sum + 1 + step.toolCalls.length;
    }, 0) + (turn.conclusionToolCalls.length > 0 ? 1 : 0)
  );
}