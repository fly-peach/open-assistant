import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckCircle2 } from "lucide-react";
import {
  ToolCardShell,
  ToolBadge,
  errorSummary,
} from "@/app/components/ToolCards/ToolCardShell";
import type { ToolCallContent } from "@/app/components/ToolCards/types";

function content(over: Partial<ToolCallContent> = {}): ToolCallContent {
  return {
    id: "call-1",
    name: "read_file",
    params: { file_path: "/todo.md" },
    rawInput: { file_path: "/todo.md" },
    status: "done",
    ...over,
  };
}

const CHILD_MARKER = "CHILD-BODY-MARKER";

function render(props: Partial<React.ComponentProps<typeof ToolCardShell>> = {}) {
  return renderToStaticMarkup(
    React.createElement(ToolCardShell, {
      content: content(),
      icon: React.createElement(CheckCircle2, { size: 13 }),
      title: "读取 /todo.md",
      ...props,
      children: props.children ?? React.createElement("div", null, CHILD_MARKER),
    })
  );
}

describe("ToolCardShell · 三态", () => {
  test("进行中：摘要行出现「执行中…」且带 spinner", () => {
    const html = render({
      content: content({ status: "calling" }),
      isStreaming: true,
    });
    expect(html).toContain("执行中…");
    expect(html).toContain("animate-spin");
    // 进行中不渲染徽标
    expect(html).not.toContain("CHILD-BODY-MARKER");
  });

  test("成功：折叠时不渲染 children（懒挂载），展开才渲染", () => {
    const collapsed = render();
    expect(collapsed).not.toContain(CHILD_MARKER);
    expect(collapsed).not.toContain("animate-spin");

    const expanded = render({ defaultExpanded: true });
    expect(expanded).toContain(CHILD_MARKER);
  });

  test("成功：徽标在未展开时可见", () => {
    const html = render({
      badges: React.createElement(ToolBadge, { tone: "info", children: "3 行" }),
    });
    expect(html).toContain("3 行");
  });

  test("失败：错误态不渲染 children，改为展示输入参数与错误原因", () => {
    const html = render({
      content: content({
        status: "error",
        result: "Error: 找不到 old_string",
      }),
      // 即使显式要求展开，也只看到错误分区
      defaultExpanded: true,
      badges: React.createElement(ToolBadge, null, "不该出现"),
    });
    expect(html).not.toContain(CHILD_MARKER);
    expect(html).toContain("错误");
    expect(html).toContain("找不到 old_string");
    // 失败原因无需展开即可见
    expect(html).toContain("Error: 找不到 old_string");
  });

  test("失败：中断态额外给出中断说明", () => {
    const html = render({
      content: content({ status: "error", interrupted: true, result: "" }),
      defaultExpanded: true,
    });
    expect(html).toContain("已中断");
  });

  test("失败：摘要行 reason 可直接读出（errorSummary）", () => {
    expect(
      errorSummary(content({ status: "error", result: "boom happened" }))
    ).toBe("boom happened");
    expect(errorSummary(content({ status: "done" }))).toBeNull();
    expect(
      errorSummary(content({ status: "error", interrupted: true, result: "" }))
    ).toBe("该调用未返回结果即被中断。");
  });

  test("默认折叠（非展开态不带 open 属性）", () => {
    const html = render();
    expect(html.startsWith("<div")).toBe(true);
    expect(/<details[^>]*\sopen/.test(html)).toBe(false);
    const expanded = render({ defaultExpanded: true });
    expect(/<details[^>]*\sopen/.test(expanded)).toBe(true);
  });
});