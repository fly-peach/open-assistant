/**
 * 把 LangChain 消息序列切成「最后一轮」，并翻译成会话库的消息记录（纯函数，不碰 SQLite）。
 *
 * 单独成文件是为了能在 bun 下直接单测（`recording.ts` 会 `import store.js` → `node:sqlite`）。
 *
 * 「一轮」的边界：**最后一条用户消息**起到序列结尾。`afterAgent` 在一轮里可能触发多次
 * （每个 model→tools 循环结束都可能触发一次），每次都取「当前快照的最后一轮」，
 * 交给 `upsertRecordedTurn` 整体替换，最终以最后一次为准。
 *
 * `turnId` 取首条用户消息的 `id`（前端发消息时生成的 uuid，跨重放稳定）；
 * 没有 id 时退化为 `turn-<下标>`。
 */
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

import type { NewMessageInput } from "./types.js";

export interface TurnSlice {
  userContent: string;
  turnId: string;
  /** 本轮除用户输入外的消息（用户输入由 `userContent` 承载，写入时单独落一条 human） */
  messages: NewMessageInput[];
}

/** 取消息的纯文本（兼容 string 内容与 content blocks 数组） */
export function messageText(message: BaseMessage): string {
  const content = message.content as unknown;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return content === null || content === undefined ? "" : String(content);
}

/** 一条 LangChain 消息 → 若干条会话库消息（AI 消息可能同时含文本与工具调用） */
export function toNewMessages(message: BaseMessage): NewMessageInput[] {
  if (ToolMessage.isInstance(message)) {
    return [
      {
        role: "tool",
        kind: "tool-result",
        content: messageText(message),
        toolName: message.name ?? null,
        toolCallId: message.tool_call_id ?? null,
      },
    ];
  }
  if (AIMessage.isInstance(message)) {
    const out: NewMessageInput[] = [];
    const reasoning = (message.additional_kwargs as Record<string, unknown> | undefined)?.[
      "reasoning_content"
    ];
    if (typeof reasoning === "string" && reasoning.length > 0) {
      out.push({ role: "ai", kind: "reasoning", content: reasoning });
    }
    const text = messageText(message);
    if (text.length > 0) out.push({ role: "ai", kind: "text", content: text });
    for (const call of message.tool_calls ?? []) {
      out.push({
        role: "ai",
        kind: "tool-call",
        toolName: call.name ?? null,
        toolCallId: call.id ?? null,
        content: JSON.stringify(call.args ?? {}),
      });
    }
    if (out.length === 0) out.push({ role: "ai", kind: "text", content: "" });
    return out;
  }
  if (HumanMessage.isInstance(message)) {
    return [{ role: "human", kind: "text", content: messageText(message) }];
  }
  return []; // 其它角色（system 等）不落库
}

/** 切出「最后一轮」；没有用户消息（如继续 / 重放）时返回 null */
export function sliceLastTurn(messages: BaseMessage[] | undefined): TurnSlice | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (HumanMessage.isInstance(messages[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const human = messages[start]!;
  const userContent = messageText(human);
  const turnId = typeof human.id === "string" && human.id.length > 0 ? human.id : `turn-${start}`;
  const rest = messages.slice(start + 1).flatMap((message) => toNewMessages(message));
  return { userContent, turnId, messages: rest };
}