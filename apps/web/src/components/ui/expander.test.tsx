/**
 * Expander（可折叠区块）：默认折叠 / defaultOpen / 标题与操作区渲染。
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Expander } from "@/components/ui/expander";

function render(props: Parameters<typeof Expander>[0]): string {
  return renderToStaticMarkup(React.createElement(Expander, props));
}

describe("Expander", () => {
  test("默认折叠：不渲染内容，aria-expanded=false", () => {
    const html = render({ title: "标题", children: React.createElement("p", null, "内容") });
    expect(html).toContain("标题");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-expander-content');
    expect(html).not.toContain("内容");
  });

  test("defaultOpen：渲染内容，aria-expanded=true，并显示副标题", () => {
    const html = render({
      title: "标题",
      subtitle: "副标题",
      defaultOpen: true,
      children: React.createElement("p", null, "内容"),
    });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-expander-content');
    expect(html).toContain("内容");
    expect(html).toContain("副标题");
  });

  test("actions 渲染在标题按钮之外（不会误触展开）", () => {
    const html = render({
      title: "标题",
      actions: React.createElement("button", { "data-action": "save" }, "保存"),
      children: null,
    });
    expect(html).toContain('data-action="save"');
    // 操作按钮不是 expander 的 toggle
    expect(html).not.toContain('data-action="save" data-expander-toggle');
  });
});