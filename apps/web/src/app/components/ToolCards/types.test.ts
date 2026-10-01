import { describe, expect, test } from "bun:test";
import {
  adaptToolCall,
  countLines,
  deriveToolStatus,
  extractResultText,
  getFileLanguage,
  looksLikeToolError,
  normalizeParams,
  oneLine,
  paramString,
  pickParam,
  shortFileName,
  stringifyResult,
} from "@/app/components/ToolCards/types";

describe("参数键归一化（适配层）", () => {
  test("兼容 DeepAgents 的 old_string / new_string", () => {
    const params = normalizeParams({
      file_path: "/todo.md",
      old_string: "- [ ] a",
      new_string: "- [x] a",
      replace_all: false,
    });
    expect(paramString(params, "old_text")).toBe("- [ ] a");
    expect(paramString(params, "new_text")).toBe("- [x] a");
    expect(paramString(params, "file_path")).toBe("/todo.md");
  });

  test("兼容 QwenPaw 的 old_text / new_text", () => {
    const params = normalizeParams({
      path: "/todo.md",
      old_text: "foo",
      new_text: "bar",
    });
    expect(paramString(params, "old_text")).toBe("foo");
    expect(paramString(params, "new_text")).toBe("bar");
    // path 也会被识别为 file_path
    expect(paramString(params, "file_path")).toBe("/todo.md");
  });

  test("原键全部保留，兜底卡片不丢信息", () => {
    const params = normalizeParams({ old_string: "a", 自定义: 1 });
    expect(params.old_string).toBe("a");
    expect(params["自定义"]).toBe(1);
  });

  test("缺失时返回 undefined / 空串，不抛错", () => {
    expect(pickParam({}, "old_text")).toBeUndefined();
    expect(paramString({}, "old_text")).toBe("");
    expect(normalizeParams(null)).toEqual({});
    expect(normalizeParams(undefined)).toEqual({});
  });
});

describe("三态推导", () => {
  test("completed → done", () => {
    expect(deriveToolStatus("completed")).toEqual({ status: "done", interrupted: false });
  });

  test("error → error", () => {
    expect(deriveToolStatus("error")).toEqual({ status: "error", interrupted: false });
  });

  test("interrupted → error + interrupted 标记", () => {
    expect(deriveToolStatus("interrupted")).toEqual({
      status: "error",
      interrupted: true,
    });
  });

  test("执行中 → calling", () => {
    expect(deriveToolStatus("pending", { isStreaming: true })).toEqual({
      status: "calling",
      interrupted: false,
    });
  });

  test("回合已结束仍是 pending → 收尾为中断（否则永远转圈）", () => {
    expect(deriveToolStatus("pending", { turnEnded: true })).toEqual({
      status: "error",
      interrupted: true,
    });
  });

  test("等待人工批准时不算失败", () => {
    expect(
      deriveToolStatus("pending", { turnEnded: true, awaitingApproval: true })
    ).toEqual({ status: "calling", interrupted: false });
  });

  test("后端把失败报成 success、原因写在正文里时，需要被识破", () => {
    expect(
      deriveToolStatus("completed", {
        resultError: looksLikeToolError(
          "Error: Error reading file '/x.md': ENOENT: no such file or directory"
        ),
      })
    ).toEqual({ status: "error", interrupted: false });
  });

  test("adaptToolCall 把结果正文里的失败特征译成 error 态", () => {
    const failed = adaptToolCall({
      id: "c1",
      name: "read_file",
      args: { file_path: "/missing.md" },
      status: "completed",
      result: "Error: Error reading file '/missing.md': ENOENT",
    });
    expect(failed.status).toBe("error");
    expect(failed.interrupted).toBe(false);

    const ok = adaptToolCall({
      id: "c2",
      name: "read_file",
      args: { file_path: "/ok.md" },
      status: "completed",
      result: "# 待办\n\n- [ ] a",
    });
    expect(ok.status).toBe("done");
  });

  test("looksLikeToolError 不误判：检索到含 error 字样的行仍算成功", () => {
    expect(looksLikeToolError("src/a.ts:12: throw new Error('x')")).toBe(false);
    expect(looksLikeToolError("errorRate: 0.1\nretries: 3")).toBe(false);
    expect(looksLikeToolError("Error: boom")).toBe(true);
    expect(looksLikeToolError("Traceback (most recent call last):")).toBe(true);
    expect(looksLikeToolError("[ERROR] disk full")).toBe(true);
    expect(looksLikeToolError("")).toBe(false);
    expect(looksLikeToolError(undefined)).toBe(false);
  });
});

describe("展示工具函数", () => {
  test("结果抽取：从 content block 包装里取纯文本", () => {
    expect(
      extractResultText({ content: [{ type: "text", text: "hello" }] })
    ).toBe("hello");
    expect(extractResultText("plain")).toBe("plain");
    expect(extractResultText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(extractResultText(undefined)).toBe("");
  });

  test("stringifyResult / countLines / oneLine", () => {
    expect(stringifyResult(12)).toBe("12");
    expect(stringifyResult(null)).toBe("");
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("")).toBe(0);
    expect(oneLine("a\n\n b   c", 80)).toBe("a b c");
    expect(oneLine("x".repeat(10), 4)).toBe("xxxx…");
  });

  test("getFileLanguage / shortFileName", () => {
    expect(getFileLanguage("/work/todo.md")).toBe("markdown");
    expect(getFileLanguage("a.tsx")).toBe("typescript");
    expect(getFileLanguage("Dockerfile")).toBe("dockerfile");
    expect(getFileLanguage("noext")).toBe("");
    expect(shortFileName("/a/b/c.txt")).toBe("c.txt");
  });
});