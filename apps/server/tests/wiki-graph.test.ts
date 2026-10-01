/**
 * 知识图谱测试（tasks 12.1–12.8，对齐 specs/project-wiki 的图谱各条）。
 *
 * 重点覆盖三条最容易做错的规则：
 * - 只解析正文、不解析 frontmatter
 * - 去重时声明式关系优先、其次带页码优先
 * - 全量重建不留半张图，且可重复执行
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  buildGraph,
  declaredRelations,
  expandByGraph,
  extractCitationEdges,
  extractLinkEdges,
  loadGraph,
  mergeEdges,
  parseRelationItem,
  rebuildGraph,
  resolveTarget,
  typeAncestors,
  type GraphEdge,
} from "../src/wiki/graph.js";
import { parseFrontmatter } from "../src/wiki/frontmatter.js";
import { ensureWikiSkeleton } from "../src/wiki/skeleton.js";
import { defaultWikiSchema, parseWikiSchema } from "../src/wiki/schema.js";

let root = "";
let counter = 0;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oa-graph-"));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function freshDir(name: string): Promise<string> {
  counter += 1;
  const dir = path.join(root, `${name}-${counter}`);
  await fs.mkdir(path.join(dir, "sources"), { recursive: true });
  return dir;
}

async function writePage(dir: string, rel: string, content: string): Promise<void> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

/** 用于 resolveTarget 的最小 resolver（照 buildGraph 的三层键） */
function resolverFor(ids: string[]) {
  const byPath = new Map<string, string>();
  const byBase = new Map<string, string>();
  const byWikiPath = new Map<string, string>();
  for (const id of ids) {
    if (!byPath.has(id)) byPath.set(id, id);
    const base = path.posix.basename(id).replace(/\.[^.]+$/, "");
    if (!byBase.has(base)) byBase.set(base, id);
    if (id.startsWith("wiki/")) {
      const inner = id.slice("wiki/".length);
      if (!byWikiPath.has(inner)) byWikiPath.set(inner, id);
    }
  }
  return { byPath, byBase, byWikiPath };
}

describe("12.1 引用抽取：只解析正文", () => {
  test("脚注引用 → cites（保留页码）", () => {
    const body = "正文。\n\n[^1]: attention.md, p.3\n";
    const cites = extractCitationEdges(body);
    expect(cites).toEqual([{ target: "attention.md", page: 3 }]);
  });

  test("中文逗号页码也能识别", () => {
    expect(extractCitationEdges("[^1]: a.md，p.12\n")[0]!.page).toBe(12);
  });

  test("无页码时为 null", () => {
    expect(extractCitationEdges("[^1]: a.md\n")[0]!.page).toBeNull();
  });

  test("markdown 内链 → links_to；跳过外部协议", () => {
    const links = extractLinkEdges("[甲](甲.md) [乙](wiki/summaries/乙.md) [外](https://x.com/a.md)");
    expect(links).toEqual(["甲.md", "wiki/summaries/乙.md"]);
  });

  test("frontmatter 里的路径不被当成引用", () => {
    const md = `---\ntype: summary\ntitle: T\nsource: sources/a.md\nrelations:\n  - {target: b.md, type: 对比}\n---\n\n正文没有引用。\n`;
    const fm = parseFrontmatter(md);
    // body 不含 frontmatter ⇒ 正文抽取结果为空
    expect(extractCitationEdges(fm.body)).toEqual([]);
    expect(extractLinkEdges(fm.body)).toEqual([]);
    // 但声明式关系要从 frontmatter 走另一条通道
    expect(declaredRelations(fm)).toEqual([{ target: "b.md", type: "对比" }]);
  });
});

describe("12.2 目标三层解析", () => {
  const r = resolverFor(["sources/attention.md", "wiki/summaries/注意力.md"]);

  test("完整相对路径", () => {
    expect(resolveTarget("sources/attention.md", r)).toBe("sources/attention.md");
  });
  test("文件名（去扩展名）", () => {
    expect(resolveTarget("attention", r)).toBe("sources/attention.md");
    expect(resolveTarget("attention.md", r)).toBe("sources/attention.md");
  });
  test("wiki 内路径", () => {
    expect(resolveTarget("summaries/注意力.md", r)).toBe("wiki/summaries/注意力.md");
  });
  test("各种书写归一：./ 前缀、反斜杠、#锚点、<> 包裹", () => {
    expect(resolveTarget("./sources/attention.md", r)).toBe("sources/attention.md");
    expect(resolveTarget("sources\\attention.md", r)).toBe("sources/attention.md");
    expect(resolveTarget("sources/attention.md#定义", r)).toBe("sources/attention.md");
    expect(resolveTarget("<sources/attention.md>", r)).toBe("sources/attention.md");
  });
});

describe("12.3 解析失败与自引用被忽略", () => {
  test("找不到目标 → null（调用方忽略该条）", () => {
    expect(resolveTarget("不存在的文件.md", resolverFor(["sources/a.md"]))).toBeNull();
  });

  test("空串 / 只有锚点 → null", () => {
    expect(resolveTarget("", resolverFor(["sources/a.md"]))).toBeNull();
    expect(resolveTarget("#section", resolverFor(["sources/a.md"]))).toBeNull();
  });

  test("图中的自引用与悬空目标不产生边", async () => {
    const dir = await freshDir("selfref");
    await ensureWikiSkeleton(dir);
    await writePage(dir, "wiki/summaries/甲.md", `---\ntype: summary\ntitle: 甲\n---\n\n[^1]: 甲.md\n\n[自己](wiki/summaries/甲.md)\n[不存在](不存在.md)\n`);
    const g = await buildGraph(dir);
    expect(g.edges.filter((e) => e.sourceId === "wiki/summaries/甲.md")).toEqual([]);
  });

  test("指向源文件的内链不产生 links_to", async () => {
    const dir = await freshDir("link-to-source");
    await ensureWikiSkeleton(dir);
    await fs.writeFile(path.join(dir, "sources", "a.md"), "# A\n", "utf8");
    await writePage(dir, "wiki/summaries/甲.md", `---\ntype: summary\ntitle: 甲\n---\n\n[去看源](sources/a.md)\n`);
    const g = await buildGraph(dir);
    expect(g.edges.some((e) => e.type === "links_to")).toBe(false);
  });
});

describe("12.4 声明式关系 → 带 relation 的边", () => {
  test("parseRelationItem 拆出 target/type", () => {
    expect(parseRelationItem("{target: a.md, type: 对比}")).toEqual({ target: "a.md", type: "对比" });
    expect(parseRelationItem("{ target: b.md , type: 支持 }")).toEqual({ target: "b.md", type: "支持" });
    expect(parseRelationItem("{target: c.md}")).toEqual({ target: "c.md", type: "" });
    expect(parseRelationItem("{type: 无目标}")).toBeNull();
  });

  test("声明在图上与普通引用可区分（relation 非空）", async () => {
    const dir = await freshDir("declared");
    await ensureWikiSkeleton(dir);
    await writePage(
      dir,
      "wiki/entities/concept/甲.md",
      `---\ntype: concept\ntitle: 甲\nrelations:\n  - {target: 乙.md, type: 对比}\n---\n\n正文。\n`,
    );
    await writePage(dir, "wiki/entities/concept/乙.md", `---\ntype: concept\ntitle: 乙\n---\n\n正文。\n`);
    const g = await buildGraph(dir);
    const declared = g.edges.find((e) => e.sourceId.endsWith("甲.md") && e.targetId.endsWith("乙.md"));
    expect(declared?.type).toBe("links_to");
    expect(declared?.relation).toBe("对比");
  });
});

describe("12.5 去重合并：声明式优先，其次带页码", () => {
  const base = (over: Partial<GraphEdge>): GraphEdge => ({
    sourceId: "wiki/a.md",
    targetId: "sources/b.md",
    type: "cites",
    page: null,
    relation: "",
    ...over,
  });

  test("relation 非空覆盖空", () => {
    const merged = mergeEdges([base({}), base({ relation: "对比" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.relation).toBe("对比");
  });

  test("同 relation 时带页码优先", () => {
    const merged = mergeEdges([base({}), base({ page: 7 })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.page).toBe(7);
  });

  test("不同类型不算重复", () => {
    const merged = mergeEdges([base({ type: "cites" }), base({ type: "links_to" })]);
    expect(merged).toHaveLength(2);
  });

  test("端到端：同一对节点同时有推断与声明时只留声明那条", async () => {
    const dir = await freshDir("merge-e2e");
    await ensureWikiSkeleton(dir);
    await writePage(dir, "wiki/entities/concept/甲.md", `---\ntype: concept\ntitle: 甲\n---\n\n[乙](wiki/entities/concept/乙.md)\n`);
    await writePage(
      dir,
      "wiki/entities/concept/乙.md",
      `---\ntype: concept\ntitle: 乙\nrelations:\n  - {target: 甲.md, type: 引用}\n---\n\n正文。\n`,
    );
    // 甲 → 乙 只有推断边；乙 → 甲 只有声明边，两者不冲突
    const g = await buildGraph(dir);
    const aToB = g.edges.find((e) => e.sourceId.endsWith("甲.md"));
    expect(aToB?.relation).toBe("");
    // 再加一条同向声明，应当覆盖掉推断的那条
    await writePage(
      dir,
      "wiki/entities/concept/甲.md",
      `---\ntype: concept\ntitle: 甲\nrelations:\n  - {target: 乙.md, type: 对比}\n---\n\n[乙](wiki/entities/concept/乙.md)\n`,
    );
    const g2 = await buildGraph(dir);
    const edges = g2.edges.filter((e) => e.sourceId.endsWith("甲.md") && e.targetId.endsWith("乙.md"));
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("对比");
  });
});

describe("12.6 全量重建：原子且可重复", () => {
  test("重建两次结果一致，且落盘到 wiki/graph.json", async () => {
    const dir = await freshDir("rebuild");
    await ensureWikiSkeleton(dir);
    await fs.writeFile(path.join(dir, "sources", "a.md"), "# A\n\n内容。\n", "utf8");
    await writePage(dir, "wiki/summaries/甲.md", `---\ntype: summary\ntitle: 甲\nsource: sources/a.md\n---\n\n[^1]: sources/a.md, p.2\n`);

    const first = await rebuildGraph(dir);
    expect(first.nodes).toBeGreaterThan(0);
    expect(first.citations).toBe(1);
    const raw1 = await fs.readFile(path.join(dir, "wiki", "graph.json"), "utf8");

    const second = await rebuildGraph(dir);
    const raw2 = await fs.readFile(path.join(dir, "wiki", "graph.json"), "utf8");
    // builtAt 会不同，比结构
    const g1 = JSON.parse(raw1) as { nodes: unknown[]; edges: unknown[] };
    const g2 = JSON.parse(raw2) as { nodes: unknown[]; edges: unknown[] };
    expect(g2.nodes).toEqual(g1.nodes);
    expect(g2.edges).toEqual(g1.edges);
    expect(second.edges).toBe(first.edges);

    // 不留临时文件（重建过程是「先算完整张图再 rename」）
    const leftovers = (await fs.readdir(path.join(dir, "wiki"))).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("loadGraph 在图不存在时按需重建一次", async () => {
    const dir = await freshDir("load-missing");
    await ensureWikiSkeleton(dir);
    await writePage(dir, "wiki/summaries/甲.md", `---\ntype: summary\ntitle: 甲\n---\n\n正文。\n`);
    const g = await loadGraph(dir);
    expect(g.nodes.some((n) => n.id.endsWith("甲.md"))).toBe(true);
  });
});

describe("12.7 节点与类型继承", () => {
  test("类型继承链来自 SCHEMA 的 parent", () => {
    const schema = parseWikiSchema(`---\nentity_types:\n  publication: {label: 出版物, folder: wiki/entities/publication/}\n  paper: {label: 论文, folder: wiki/entities/paper/, parent: publication}\n---\n`);
    expect(typeAncestors(schema, "paper")).toEqual(["paper", "publication"]);
    expect(typeAncestors(schema, "publication")).toEqual(["publication"]);
    expect(typeAncestors(schema, "source")).toEqual(["source"]);
    expect(typeAncestors(schema, null)).toEqual([]);
  });

  test("默认 SCHEMA 里未知类型只返回自身（不成环）", () => {
    expect(typeAncestors(defaultWikiSchema(), "不存在")).toEqual(["不存在"]);
  });

  test("端到端：节点带 typeAncestors 与 props", async () => {
    const dir = await freshDir("node-props");
    await ensureWikiSkeleton(dir);
    await fs.writeFile(path.join(dir, "sources", "a.md"), "# A\n", "utf8");
    await writePage(dir, "wiki/entities/concept/甲.md", `---\ntype: concept\ntitle: 甲概念\nsource: sources/a.md\n---\n\n正文。\n`);
    const g = await buildGraph(dir);
    const node = g.nodes.find((n) => n.id.endsWith("甲.md"));
    expect(node?.type).toBe("concept");
    expect(node?.title).toBe("甲概念");
    expect(node?.typeAncestors).toEqual(["concept"]);
    expect((node?.props as { sources: string[] }).sources).toEqual(["sources/a.md"]);
    expect(g.nodes.find((n) => n.id === "sources/a.md")?.type).toBe("source");
  });
});

describe("12.8 图查询与孤立节点 / 图谱参与检索", () => {
  test("无入边的页面仍作为节点出现（孤儿页可被发现）", async () => {
    const dir = await freshDir("orphan");
    await ensureWikiSkeleton(dir);
    await writePage(dir, "wiki/summaries/孤立.md", `---\ntype: summary\ntitle: 孤立\n---\n\n没人引用我。\n`);
    const g = await buildGraph(dir);
    const id = "wiki/summaries/孤立.md";
    expect(g.nodes.some((n) => n.id === id)).toBe(true);
    expect(g.edges.some((e) => e.targetId === id)).toBe(false);
  });

  test("expandByGraph 沿边扩展候选并排除种子自身", async () => {
    const graph = {
      builtAt: "",
      nodes: [],
      edges: [
        { sourceId: "A", targetId: "B", type: "cites" as const, page: null, relation: "" },
        { sourceId: "A", targetId: "C", type: "cites" as const, page: null, relation: "" },
        { sourceId: "B", targetId: "C", type: "links_to" as const, page: null, relation: "" },
      ],
    };
    // 只看 A 时：出边到 B、C，各命中 1 次（B→C 那条不涉及种子，不该被走到）
    const onlyA = expandByGraph(graph, ["A"]);
    expect(onlyA.sort()).toEqual(["B", "C"]);
    expect(onlyA).not.toContain("A");
    // 种子取 A、B 时：C 同时来自 A→C 与 B→C ⇒ 命中 2 次，排第一
    const both = expandByGraph(graph, ["A", "B"]);
    expect(both[0]).toBe("C");
    expect(both).not.toContain("A");
    // 只看出边
    expect(expandByGraph(graph, ["A"], "out").sort()).toEqual(["B", "C"]);
    // 只看入边：B、C 都有入边
    expect(expandByGraph(graph, ["C"], "in").sort()).toEqual(["A", "B"]);
  });
});