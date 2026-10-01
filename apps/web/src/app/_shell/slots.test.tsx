/**
 * 任务 10.10：插槽无注册时不占位，注册后出现在固定位置。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Slot, slotStore } from "@/app/_shell/slots";

const MARKER = "SLOT-CONTENT-MARKER";

beforeEach(() => {
  slotStore.clear();
});

describe("扩展插槽（10.10）", () => {
  test("无注册时 Slot 渲染为空且 hasContent 为 false", () => {
    expect(renderToStaticMarkup(React.createElement(Slot, { name: "content.statusBar" }))).toBe(
      ""
    );
    expect(renderToStaticMarkup(React.createElement(Slot, { name: "overlay.global" }))).toBe(
      ""
    );
    expect(slotStore.hasContent("content.statusBar")).toBe(false);
    expect(slotStore.hasContent("overlay.global")).toBe(false);
  });

  test("注册后内容出现在对应插槽，两个插槽互不串台", () => {
    slotStore.register("content.statusBar", "demo", MARKER);
    const statusBar = renderToStaticMarkup(
      React.createElement(Slot, { name: "content.statusBar" })
    );
    expect(statusBar).toContain(MARKER);
    expect(statusBar).toContain('data-slot="content.statusBar"');
    expect(
      renderToStaticMarkup(React.createElement(Slot, { name: "overlay.global" }))
    ).toBe("");
  });

  test("同一 id 重复注册覆盖旧内容，注销后回到空", () => {
    slotStore.register("overlay.global", "demo", "FIRST");
    slotStore.register("overlay.global", "demo", "SECOND");
    const html = renderToStaticMarkup(
      React.createElement(Slot, { name: "overlay.global" })
    );
    expect(html).toContain("SECOND");
    expect(html).not.toContain("FIRST");

    slotStore.unregister("overlay.global", "demo");
    expect(slotStore.hasContent("overlay.global")).toBe(false);
  });

  test("多个注册按 order 排序", () => {
    slotStore.register("content.statusBar", "second", "LATER-NODE", 20);
    slotStore.register("content.statusBar", "first", "EARLIER-NODE", 10);
    const html = renderToStaticMarkup(
      React.createElement(Slot, { name: "content.statusBar" })
    );
    expect(html.indexOf("EARLIER-NODE")).toBeLessThan(
      html.indexOf("LATER-NODE")
    );
  });
});