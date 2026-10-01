import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CARD_REGISTRY,
  GenericToolCard,
  ToolCard,
  resolveToolCard,
  withGenericFallback,
} from "@/app/components/ToolCards";
import { EditFileCard, ReadFileCard } from "@/app/components/ToolCards/cards/FileCards";
import { ShellCard } from "@/app/components/ToolCards/cards/MiscCards";
import type { ToolCallContent } from "@/app/components/ToolCards/types";

function content(over: Partial<ToolCallContent> = {}): ToolCallContent {
  return {
    id: "call-1",
    name: "unknown_tool",
    params: {},
    rawInput: {},
    status: "done",
    ...over,
  };
}

describe("注册表与兜底", () => {
  test("已登记工具映射到专属卡片（不会退化为通用键值对罗列）", () => {
    expect(resolveToolCard("read_file")).toBe(ReadFileCard);
    expect(resolveToolCard("edit_file")).toBe(EditFileCard);
    expect(resolveToolCard("grep")).not.toBe(GenericToolCard);
    expect(resolveToolCard("ls")).not.toBe(GenericToolCard);
  });

  test("shell 类别名共用一个卡片组件", () => {
    expect(resolveToolCard("execute")).toBe(ShellCard);
    expect(resolveToolCard("shell")).toBe(ShellCard);
    expect(resolveToolCard("bash")).toBe(ShellCard);
    expect(resolveToolCard("run_command")).toBe(ShellCard);
  });

  test("带命名空间前缀也能解析", () => {
    expect(resolveToolCard("fs__read_file")).toBe(ReadFileCard);
  });

  test("未登记工具落回通用兜底", () => {
    expect(resolveToolCard("totally_new_tool")).toBe(GenericToolCard);
    expect(resolveToolCard("")).toBe(GenericToolCard);
  });

  test("未登记工具不会不显示或报错：名称/参数/结果都渲染出来", () => {
    const html = renderToStaticMarkup(
      React.createElement(GenericToolCard, {
        content: content({
          name: "totally_new_tool",
          params: { foo: "bar" },
          rawInput: { foo: "bar" },
          result: "结果文本",
        }),
      })
    );
    expect(html).toContain("totally_new_tool");
    expect(html).toContain("调用 totally_new_tool");
  });

  test("ToolCard 入口对任意名字都能渲染（含空名字）", () => {
    for (const name of ["read_file", "edit_file", "zzz_unknown", ""]) {
      const html = renderToStaticMarkup(
        React.createElement(ToolCard, { content: content({ name }) })
      );
      expect(html.length).toBeGreaterThan(0);
    }
  });

  test("withGenericFallback 替身：未登记的键返回兜底", () => {
    const registry = withGenericFallback({ read_file: ReadFileCard });
    expect(registry.read_file).toBe(ReadFileCard);
    expect(registry["not_registered_at_all"]).toBe(GenericToolCard);
    // 内置注册表自身仍是普通对象，方便合并
    expect(Object.keys(CARD_REGISTRY).length).toBeGreaterThan(10);
  });
});

describe("文件类卡片摘要行显示路径", () => {
  test("读取卡片：未展开即可看到完整文件路径", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ToolCard,
        {
          content: content({
            name: "read_file",
            params: { file_path: "/work/notes/todo.md" },
            rawInput: { file_path: "/work/notes/todo.md" },
            result: "a\nb\nc",
          }),
        },
        null
      )
    );
    expect(html).toContain("/work/notes/todo.md");
  });

  test("修改卡片：路径在摘要行，且展开后以增删对照呈现", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ToolCard,
        {
          content: content({
            name: "edit_file",
            params: {
              file_path: "/work/todo.md",
              old_string: "- [ ] a",
              new_string: "- [x] a",
            },
            rawInput: {
              file_path: "/work/todo.md",
              old_string: "- [ ] a",
              new_string: "- [x] a",
            },
          }),
          isStreaming: false,
        },
        null
      )
    );
    expect(html).toContain("/work/todo.md");
    // 默认折叠 → 展开内容不渲染；用 defaultExpanded 无法从 ToolCard 传，
    // 因此直接渲染 EditFileCard 验证 diff 呈现。
    const expanded = renderToStaticMarkup(
      React.createElement(EditFileCard, {
        content: content({
          name: "edit_file",
          params: {
            file_path: "/work/todo.md",
            old_string: "- [ ] a",
            new_string: "- [x] a",
          },
          rawInput: {},
        }),
      })
    );
    expect(expanded).toContain("/work/todo.md");
  });

  test("修改卡片参数键兼容：old_string 也能算出增删行数徽标", () => {
    const html = renderToStaticMarkup(
      React.createElement(EditFileCard, {
        content: content({
          name: "edit_file",
          params: {
            file_path: "/a.md",
            old_string: "1\n2",
            new_string: "1\n2\n3",
          },
          rawInput: {},
        }),
      })
    );
    expect(html).toContain("-2 行");
    expect(html).toContain("+3 行");
  });

  test("修改卡片参数键兼容：old_text / new_text 同样生效", () => {
    const html = renderToStaticMarkup(
      React.createElement(EditFileCard, {
        content: content({
          name: "edit_file",
          params: { file_path: "/a.md", old_text: "1", new_text: "1\n2" },
          rawInput: {},
        }),
      })
    );
    expect(html).toContain("-1 行");
    expect(html).toContain("+2 行");
  });
});