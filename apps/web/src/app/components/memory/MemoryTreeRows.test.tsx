/**
 * 任务 11.18 的组件级验证：**两级导航的二级（树行）确实能列出分层记忆与 wiki 目录**，
 * 并且 `wiki/raw/**` 带只读标记。
 *
 * 为什么在组件级补这一层：后端 `GET /agents/{id}/memory/tree` 由另一个 agent 实现，
 * 本次验证时它还是 404；于是用「真实契约形状的 payload」直接喂给树行组件，
 * 断言扁平清单能变成可点击的节点（含 MEMORY.md / memory/ / digest/），
 * 以及 raw/ 的只读标记渲染出来了（不依赖网络）。
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MemoryKindBadge,
  MemoryTreeRows,
  ReadOnlyMark,
} from "@/app/components/memory/MemoryTreeRows";
import {
  buildMemoryNodes,
  isWikiRawRel,
  normalizeMemoryEntries,
  withCoreMemoryNode,
} from "@/app/utils/memoryTree";
import zh from "@/i18n/zh";

/** 契约形状的分层记忆清单（design D12 的全部层）。 */
const AGENT_TREE_PAYLOAD = {
  entries: [
    { rel: "MEMORY.md", type: "file", size: 42 },
    { rel: "memory", type: "dir" },
    { rel: "memory/2026-10-01.md", type: "file" },
    { rel: "memory/2026-10-01", type: "dir" },
    { rel: "memory/2026-10-01/topic.md", type: "file" },
    { rel: "digest", type: "dir" },
    { rel: "digest/2026-10-01.md", type: "file" },
    { rel: "memory/imports/_scope.json", type: "file" },
  ],
};

const noop = () => {};

describe("记忆树行（11.18）", () => {
  test("扁平清单渲染出核心 / 按日 / 主题 / 消化 / 导入节点", () => {
    const nodes = withCoreMemoryNode(
      buildMemoryNodes(normalizeMemoryEntries(AGENT_TREE_PAYLOAD))
    );
    const html = renderToStaticMarkup(
      React.createElement(MemoryTreeRows, {
        nodes,
        selectedRel: null,
        onSelectFile: noop,
        renderTrailing: (node: { rel: string }) =>
          React.createElement(MemoryKindBadge, { rel: node.rel }),
      })
    );

    for (const rel of [
      "/MEMORY.md",
      "/memory/2026-10-01.md",
      "/memory/2026-10-01/topic.md",
      "/digest/2026-10-01.md",
      "/memory/imports/_scope.json",
    ]) {
      expect(html).toContain(`data-memory-tree-item="${rel}"`);
    }
    // 目录节点（可展开）
    expect(html).toContain('data-memory-tree-dir="/memory"');
    expect(html).toContain('data-memory-tree-dir="/digest"');
    expect(html).toContain('data-memory-tree-dir="/memory/2026-10-01"');

    // 中文徽标来自 i18n
    for (const label of [
      zh.memory.coreBadge,
      zh.memory.dailyBadge,
      zh.memory.topicBadge,
      zh.memory.digestBadge,
      zh.memory.importsBadge,
    ]) {
      expect(html).toContain(label);
    }
  });

  test("选中的文件行带 selected 标记", () => {
    const nodes = buildMemoryNodes(
      normalizeMemoryEntries([{ rel: "memory/2026-10-01.md", type: "file" }])
    );
    const html = renderToStaticMarkup(
      React.createElement(MemoryTreeRows, {
        nodes,
        selectedRel: "/memory/2026-10-01.md",
        onSelectFile: noop,
      })
    );
    expect(html).toContain('data-memory-tree-selected="true"');
  });

  test("wiki 的 raw/ 行带只读标记（其余目录不带）", () => {
    const nodes = buildMemoryNodes(
      normalizeMemoryEntries([
        { rel: "wiki/raw/a.txt", type: "file" },
        { rel: "wiki/summaries/a.md", type: "file" },
      ])
    );
    const html = renderToStaticMarkup(
      React.createElement(MemoryTreeRows, {
        nodes,
        selectedRel: null,
        onSelectFile: noop,
        renderTrailing: (node: { rel: string }) =>
          isWikiRawRel(node.rel)
            ? React.createElement(ReadOnlyMark, { label: zh.memory.rawBadge })
            : null,
      })
    );
    expect(html).toContain(`data-memory-readonly="${zh.memory.rawBadge}"`);
    expect(html).toContain("raw/a.txt");
    // summaries 下的页面没有只读标记
    const summaries = html.slice(html.indexOf("data-memory-tree-item=\"/wiki/summaries/a.md\""));
    expect(summaries).not.toContain("data-memory-readonly");
  });

  test("空清单渲染成空字符串（页面据此给空状态）", () => {
    const html = renderToStaticMarkup(
      React.createElement(MemoryTreeRows, {
        nodes: [],
        selectedRel: null,
        onSelectFile: noop,
      })
    );
    expect(html).toBe("");
  });
});