/**
 * 会话落库的**纯函数**部分：把 LangChain 消息序列切成「最后一轮」并翻译成会话库消息。
 *
 * 纯函数，不碰 SQLite，所以可以用 bun 跑（真正落库的 store 行为在 Node 侧
 * `test:conversation` 覆盖）。
 */
import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { messageText, sliceLastTurn, toNewMessages } from "../src/conversation/message-slice.js";

describe("messageText：纯文本提取", () => {
  test("string 内容", () => {
    expect(messageText(new AIMessage("你好"))).toBe("你好");
  });
  test("content blocks 数组取 text 段", () => {
    const message = new AIMessage({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] as never });
    expect(messageText(message)).toBe("ab");
  });
});

describe("toNewMessages：单条消息翻译", () => {
  test("AI 文本 → ai/text", () => {
    expect(toNewMessages(new AIMessage("好的"))).toEqual([{ role: "ai", kind: "text", content: "好的" }]);
  });
  test("AI 工具调用 → ai/tool-call（args 序列化，带 name/id）", () => {
    const message = new AIMessage({
      content: "",
      tool_calls: [{ name: "todo_create", args: { content: "写" }, id: "c1", type: "tool_call" }],
    });
    expect(toNewMessages(message)).toEqual([
      { role: "ai", kind: "tool-call", toolName: "todo_create", toolCallId: "c1", content: JSON.stringify({ content: "写" }) },
    ]);
  });
  test("AI 文本 + 工具调用 → 两条（文本在前）", () => {
    const message = new AIMessage({
      content: "我来创建",
      tool_calls: [{ name: "todo_create", args: {}, id: "c1", type: "tool_call" }],
    });
    const out = toNewMessages(message);
    expect(out.map((m) => m.kind)).toEqual(["text", "tool-call"]);
  });
  test("reasoning_content 单独成 ai/reasoning", () => {
    const message = new AIMessage({ content: "答案", additional_kwargs: { reasoning_content: "想一下" } });
    expect(toNewMessages(message).map((m) => m.kind)).toEqual(["reasoning", "text"]);
  });
  test("ToolMessage → tool/tool-result（带 name/tool_call_id）", () => {
    const message = new ToolMessage({ content: "ok", tool_call_id: "c1", name: "todo_create" });
    expect(toNewMessages(message)).toEqual([
      { role: "tool", kind: "tool-result", content: "ok", toolName: "todo_create", toolCallId: "c1" },
    ]);
  });
  test("空 AI 消息也落一条 text（保持轮次非空）", () => {
    expect(toNewMessages(new AIMessage(""))).toEqual([{ role: "ai", kind: "text", content: "" }]);
  });
});

describe("sliceLastTurn：切出最后一轮", () => {
  test("多轮 → 只取最后一条用户消息起到结尾", () => {
    const messages = [
      new HumanMessage({ id: "h1", content: "第一轮" }),
      new AIMessage("第一答"),
      new HumanMessage({ id: "h2", content: "第二轮" }),
      new AIMessage("第二答"),
    ];
    const slice = sliceLastTurn(messages);
    expect(slice?.userContent).toBe("第二轮");
    expect(slice?.turnId).toBe("h2");
    expect(slice?.messages).toEqual([{ role: "ai", kind: "text", content: "第二答" }]);
  });

  test("带工具的一轮：ai/text + ai/tool-call + tool/tool-result 顺序保留", () => {
    const messages = [
      new HumanMessage({ id: "h1", content: "建个待办" }),
      new AIMessage({ content: "好", tool_calls: [{ name: "todo_create", args: {}, id: "c1", type: "tool_call" }] }),
      new ToolMessage({ content: "done", tool_call_id: "c1", name: "todo_create" }),
      new AIMessage("已创建"),
    ];
    const kinds = sliceLastTurn(messages)?.messages.map((m) => `${m.role}/${m.kind}`);
    expect(kinds).toEqual(["ai/text", "ai/tool-call", "tool/tool-result", "ai/text"]);
  });

  test("用户消息没有 id → 退化为 turn-<下标>", () => {
    const slice = sliceLastTurn([new AIMessage("x"), new HumanMessage("没 id")]);
    expect(slice?.turnId).toBe("turn-1");
  });

  test("没有用户消息（继续 / 重放）→ null", () => {
    expect(sliceLastTurn([new AIMessage("只有回答")])).toBeNull();
    expect(sliceLastTurn([])).toBeNull();
    expect(sliceLastTurn(undefined)).toBeNull();
  });
});