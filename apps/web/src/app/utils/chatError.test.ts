import { describe, expect, test } from "bun:test";

import { chatErrorText } from "@/app/utils/chatError";
import zh from "@/i18n/zh";

describe("chatErrorText：run 失败的可读文案", () => {
  test("无错误 → null", () => {
    expect(chatErrorText(null)).toBeNull();
    expect(chatErrorText(undefined)).toBeNull();
  });

  test("429 / 限流 → 单独提示（不暴露原始报错）", () => {
    expect(
      chatErrorText(new Error("429 Request rate increased too quickly. Please adjust your client logic"))
    ).toBe(zh.chat.errorRateLimit);
    expect(chatErrorText(new Error("RateLimitCapacityError: MODEL_RATE_LIMIT"))).toBe(
      zh.chat.errorRateLimit
    );
  });

  test("其它错误 → 通用文案带原始信息", () => {
    const text = chatErrorText(new Error("something broke"));
    expect(text).toContain("something broke");
  });

  test("非 Error 值也能处理", () => {
    expect(chatErrorText("plain string error")).toContain("plain string error");
  });
});