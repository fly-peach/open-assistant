/**
 * 回归测试：provider 省略首个 delta 的 `role` 时，不得产出 `ChatMessageChunk`。
 *
 * 见 `src/model.ts` 的注释 —— 这是一个曾让整轮 run 硬失败的上游 bug：
 * 缺 role 的 delta 会被 `@langchain/openai` 转成 `ChatMessageChunk`（type "generic"），
 * 聚合后不满足 `AIMessage | Command`，LangChain 的 `AgentNode` 直接抛
 * `Invalid response from "wrapModelCall" ... expected AIMessage or Command, got object`。
 */
import { describe, expect, test } from "bun:test";
import { ChatOpenAICompletions } from "@langchain/openai";
import { AIMessage, ChatMessageChunk, HumanMessageChunk } from "@langchain/core/messages";

import { RobustChatOpenAI } from "../src/model.js";

/** 把 protected 的转换器暴露出来，便于直接断言 */
class Exposed extends RobustChatOpenAI {
  convert(delta: Record<string, unknown>, defaultRole?: unknown) {
    return (
      this as unknown as {
        _convertCompletionsDeltaToBaseMessageChunk: (
          d: Record<string, unknown>,
          r: unknown,
          role?: unknown,
        ) => unknown;
      }
    )._convertCompletionsDeltaToBaseMessageChunk(
      delta,
      { id: "cmpl-test", choices: [{ index: 0 }], usage: {} },
      defaultRole,
    );
  }
}

/** 未修复的上游行为，用来证明这个 bug 真实存在（避免测试变成空转） */
class ExposedUpstream extends ChatOpenAICompletions {
  convert(delta: Record<string, unknown>, defaultRole?: unknown) {
    return (
      this as unknown as {
        _convertCompletionsDeltaToBaseMessageChunk: (
          d: Record<string, unknown>,
          r: unknown,
          role?: unknown,
        ) => unknown;
      }
    )._convertCompletionsDeltaToBaseMessageChunk(
      delta,
      { id: "cmpl-test", choices: [{ index: 0 }], usage: {} },
      defaultRole,
    );
  }
}

const MODEL = new Exposed({ apiKey: "test", model: "test-model" });
const UPSTREAM = new ExposedUpstream({ apiKey: "test", model: "test-model" });

describe("模型层适配：缺失 role 的 delta", () => {
  test("上游确实会产出 ChatMessageChunk（证明这个坑是真的）", () => {
    const upstream = UPSTREAM.convert({ content: "ok" });
    expect(upstream).toBeInstanceOf(ChatMessageChunk);
    expect(AIMessage.isInstance(upstream)).toBe(false);
  });

  test("修复后同一个 delta 产出 AIMessageChunk", () => {
    const fixed = MODEL.convert({ content: "ok" });
    expect(AIMessage.isInstance(fixed)).toBe(true);
  });

  test("delta 自带 role 时保持原语义（不把 user 改成 assistant）", () => {
    expect(MODEL.convert({ content: "hi", role: "user" })).toBeInstanceOf(HumanMessageChunk);
    expect(AIMessage.isInstance(MODEL.convert({ content: "hi", role: "assistant" }))).toBe(true);
  });

  test("defaultRole 存在时沿用它，不被硬改成 assistant", () => {
    expect(MODEL.convert({ content: "hi" }, "user")).toBeInstanceOf(HumanMessageChunk);
  });

  test("reasoning_content 等附加字段不被破坏", () => {
    const chunk = MODEL.convert({ content: "", reasoning_content: "想一下" }) as {
      additional_kwargs?: Record<string, unknown>;
    };
    expect(chunk.additional_kwargs?.["reasoning_content"]).toBe("想一下");
  });
});