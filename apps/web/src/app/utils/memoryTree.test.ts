/**
 * 任务 11.18 的纯函数单测：扁平记忆条目 → 树、分层徽标分类、wiki 原始资料只读判定。
 * 覆盖后端契约的容错点（缺 type / 混用分隔符 / 重复 rel / 隐式父目录）。
 */
import { describe, expect, test } from "bun:test";
import {
  buildListingNodes,
  buildMemoryNodes,
  isCoreMemoryRel,
  isWikiRawRel,
  memoryRelKind,
  normalizeMemoryEntries,
  normalizeMemoryRel,
  parentMemoryRel,
  withCoreMemoryNode,
} from "@/app/utils/memoryTree";

describe("normalizeMemoryRel", () => {
  test("归一化分隔符、前缀与末尾斜杠", () => {
    expect(normalizeMemoryRel("MEMORY.md")).toBe("/MEMORY.md");
    expect(normalizeMemoryRel("./memory/2026-10-01.md")).toBe("/memory/2026-10-01.md");
    expect(normalizeMemoryRel("memory\\2026-10-01\\")).toBe("/memory/2026-10-01");
    expect(normalizeMemoryRel("/memory//imports/x.md")).toBe("/memory/imports/x.md");
    expect(normalizeMemoryRel("")).toBe("/");
    expect(normalizeMemoryRel("/")).toBe("/");
  });

  test("父目录", () => {
    expect(parentMemoryRel("/MEMORY.md")).toBe("/");
    expect(parentMemoryRel("/memory/2026-10-01/a.md")).toBe("/memory/2026-10-01");
  });
});

describe("normalizeMemoryEntries", () => {
  test("接受契约形状 { entries } 并保留 size", () => {
    const entries = normalizeMemoryEntries({
      entries: [
        { rel: "MEMORY.md", type: "file", size: 12 },
        { rel: "memory", type: "dir" },
        { rel: "digest", type: "dir" },
      ],
    });
    expect(entries.map((e) => [e.rel, e.type, e.name])).toEqual([
      ["/digest", "dir", "digest"],
      ["/memory", "dir", "memory"],
      ["/MEMORY.md", "file", "MEMORY.md"],
    ]);
    expect(entries.find((e) => e.rel === "/MEMORY.md")?.size).toBe(12);
  });

  test("也接受裸数组，并忽略无效项 / 根 / 重复 rel", () => {
    const entries = normalizeMemoryEntries([
      { path: "/MEMORY.md", type: "file" },
      { path: "/MEMORY.md", type: "file" },
      { name: "/" },
      { nope: 1 },
      "junk",
    ]);
    expect(entries.map((e) => e.rel)).toEqual(["/MEMORY.md"]);
  });

  test("type 缺失时按父目录推断", () => {
    const entries = normalizeMemoryEntries([
      { rel: "memory/2026-10-01.md" },
      { rel: "memory/2026-10-01/topic.md" },
    ]);
    const byRel = new Map(entries.map((e) => [e.rel, e.type]));
    expect(byRel.get("/memory")).toBe("dir");
    expect(byRel.get("/memory/2026-10-01")).toBe("dir");
    expect(byRel.get("/memory/2026-10-01.md")).toBe("file");
    expect(byRel.get("/memory/2026-10-01/topic.md")).toBe("file");
  });

  test("非对象入参返回空列表（不抛错）", () => {
    expect(normalizeMemoryEntries(null)).toEqual([]);
    expect(normalizeMemoryEntries("x")).toEqual([]);
    expect(normalizeMemoryEntries({})).toEqual([]);
  });
});

describe("buildMemoryNodes", () => {
  test("扁平列表 → 嵌套树，目录在前", () => {
    const nodes = buildMemoryNodes(
      normalizeMemoryEntries({
        entries: [
          { rel: "MEMORY.md", type: "file" },
          { rel: "memory/2026-10-01.md", type: "file" },
          { rel: "memory/2026-10-01/topic.md", type: "file" },
          { rel: "memory/imports/_scope.json", type: "file" },
          { rel: "digest/2026-10-01.md", type: "file" },
        ],
      })
    );

    expect(nodes.map((n) => n.rel)).toEqual(["/digest", "/memory", "/MEMORY.md"]);
    const memory = nodes.find((n) => n.rel === "/memory")!;
    expect(memory.children.map((n) => n.rel)).toEqual([
      "/memory/2026-10-01",
      "/memory/imports",
      "/memory/2026-10-01.md",
    ]);
    const day = memory.children.find((n) => n.rel === "/memory/2026-10-01")!;
    expect(day.type).toBe("dir");
    expect(day.children.map((n) => n.rel)).toEqual(["/memory/2026-10-01/topic.md"]);
  });

  test("隐式父目录被补出来，且不重复", () => {
    const nodes = buildMemoryNodes(
      normalizeMemoryEntries([{ rel: "digest/deep/a.md", type: "file" }])
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].rel).toBe("/digest");
    expect(nodes[0].children[0].rel).toBe("/digest/deep");
    expect(nodes[0].children[0].children[0].rel).toBe("/digest/deep/a.md");
  });

  test("空输入 → 空树（界面据此给空状态）", () => {
    expect(buildMemoryNodes([])).toEqual([]);
  });

  test("核心记忆节点总在最前，且不与清单重复", () => {
    const layered = buildMemoryNodes(
      normalizeMemoryEntries([
        { rel: "MEMORY.md", type: "file" },
        { rel: "digest/2026-10-01.md", type: "file" },
      ])
    );
    const merged = withCoreMemoryNode(layered);
    expect(merged.map((n) => n.rel)).toEqual(["/MEMORY.md", "/digest"]);
    expect(merged.filter((n) => n.rel === "/MEMORY.md")).toHaveLength(1);
  });

  test("旧单文件名 memory.md 也归到同一个核心节点（迁移期不出现两个核心）", () => {
    const layered = buildMemoryNodes(
      normalizeMemoryEntries([{ rel: "memory.md", type: "file" }])
    );
    const merged = withCoreMemoryNode(layered);
    expect(merged.map((n) => n.rel)).toEqual(["/MEMORY.md"]);
    expect(isCoreMemoryRel("/memory.md")).toBe(true);
    expect(isCoreMemoryRel("/memory/2026-10-01.md")).toBe(false);
  });
});

describe("buildListingNodes（目录一层清单 → 直接子节点）", () => {
  test("不会补出与当前目录同名的父节点（否则展开会无限递归）", () => {
    // `/workspace/tree?rel=wiki` 的真实返回形状：path 带 `/wiki` 前缀
    const listing = normalizeMemoryEntries([
      { path: "/wiki/entities", type: "directory" },
      { path: "/wiki/raw", type: "directory" },
      { path: "/wiki/index.md", type: "file" },
      { path: "/wiki/SCHEMA.md", type: "file" },
    ]);
    const nodes = buildListingNodes(listing, "/wiki");
    expect(nodes.map((n) => n.rel)).toEqual([
      "/wiki/entities",
      "/wiki/raw",
      "/wiki/index.md",
      "/wiki/SCHEMA.md",
    ]);
    // 关键：不存在 `/wiki` 这个父节点（它就是被列举的目录本身）
    expect(nodes.some((n) => n.rel === "/wiki")).toBe(false);
  });

  test("子目录的一层清单保持工作区相对路径，便于后续 `/workspace/file` 读取", () => {
    const nodes = buildListingNodes(
      normalizeMemoryEntries([
        { path: "/wiki/entities/tool", type: "directory" },
        { path: "/wiki/entities/tool/demo.md", type: "file" },
        { path: "/other/skip.md", type: "file" },
      ]),
      "/wiki/entities"
    );
    expect(nodes.map((n) => n.rel)).toEqual(["/wiki/entities/tool"]);
    expect(nodes[0].children.map((n) => n.rel)).toEqual([
      "/wiki/entities/tool/demo.md",
    ]);
    expect(nodes[0].name).toBe("tool");
  });

  test("空清单 → 空数组", () => {
    expect(buildListingNodes([], "/wiki")).toEqual([]);
  });
});

describe("memoryRelKind", () => {
  test("核心 / 日记 / 主题 / 消化 / 导入", () => {
    expect(memoryRelKind("MEMORY.md")).toBe("core");
    expect(memoryRelKind("memory")).toBe("other");
    expect(memoryRelKind("memory/2026-10-01.md")).toBe("daily");
    expect(memoryRelKind("memory/2026-10-01/topic.md")).toBe("topic");
    expect(memoryRelKind("digest/2026-10-01.md")).toBe("digest");
    expect(memoryRelKind("memory/imports/_scope.json")).toBe("imports");
    expect(memoryRelKind("/agents/notes.md")).toBe("other");
  });
});

describe("isWikiRawRel", () => {
  test("只有 wiki/raw 之下算原始资料", () => {
    expect(isWikiRawRel("/wiki/raw/a.txt")).toBe(true);
    expect(isWikiRawRel("wiki/raw")).toBe(true);
    expect(isWikiRawRel("/wiki/summaries/a.md")).toBe(false);
    expect(isWikiRawRel("/raw/a.txt")).toBe(false);
    expect(isWikiRawRel("/wiki/rawish/a.txt")).toBe(false);
  });
});