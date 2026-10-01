/**
 * 知识图谱（tasks 12.1–12.8，对齐 specs/project-wiki 的图谱各条）。
 *
 * 忠实搬运自 `E:/llm-wiki/api/services/{references,graph}.py`：那套设计已被验证过，
 * 这里只做「SQLite 表 → 工作区内的 `wiki/graph.json`」的落地改写。
 *
 * ## 边的两类来源
 * 1. **正文推断**：脚注引用 `[^1]: 某文件.md`（带页码 `, p.3` / `，p.3`）→ `cites`；
 *    markdown 内链 `[文字](某页.md)` → `links_to`。
 * 2. **元数据声明**：页面 frontmatter 里的
 *    `relations: [{target: 某页.md, type: 对比}]` → 带 `relation` 的 `links_to`。
 *
 * ## 三条容易做错的规则（全部有测试）
 * - **只解析正文，不解析 frontmatter** —— 否则元数据里的路径会被当成引用。
 * - **去重时声明式优先**：键 `(source, target, type)`，保留规则为
 *   `relation` 非空 > 空，其次带页码 > 无页码。即「页面上写明的语义关系」覆盖
 *   「从正文猜出来的引用」。
 * - **全量重建是原子的**：先算完整张图再一次性写文件，失败不留半张图。
 */
import path from "node:path";
import fs from "node:fs/promises";

import { parseFrontmatter, type Frontmatter } from "./frontmatter.js";
import { listSourceFiles, listWikiPages, type WikiPageInfo } from "./pages.js";
import { WIKI_DIR, normalizeRel, wikiGraphPath } from "./paths.js";
import { loadWikiSchema, type WikiSchema } from "./schema.js";

/** 边类型。`cites` 指向源文件，`links_to` 指向另一个页面。 */
export type GraphEdgeType = "cites" | "links_to";

export interface GraphEdge {
  /** 源节点 id（工作区相对路径，如 `wiki/summaries/x.md`） */
  sourceId: string;
  /** 目标节点 id（页面相对路径，或源文件相对路径） */
  targetId: string;
  type: GraphEdgeType;
  /** 引用带页码时保留，供溯源 */
  page: number | null;
  /** 元数据声明的语义关系；正文推断的边为空串 */
  relation: string;
}

export interface GraphNode {
  id: string;
  /** 页面类型；源文件为 `"source"` */
  type: string;
  title: string;
  path: string;
  /** 类型继承链（自身 → … → 顶层），来自 SCHEMA 的 `parent` */
  typeAncestors: string[];
  props: Record<string, unknown>;
}

export interface KnowledgeGraph {
  builtAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** 每份源文件与每个页面都进节点表，用于三层解析 */
interface Resolver {
  /** 完整相对路径 → id */
  byPath: Map<string, string>;
  /** 文件名（去扩展名）→ id（同名时保留第一个，避免猜测） */
  byBase: Map<string, string>;
  /** wiki 内路径（如 `summaries/x.md`）→ id */
  byWikiPath: Map<string, string>;
}

function pushUnique(map: Map<string, string>, key: string, id: string): void {
  if (!key || map.has(key)) return;
  map.set(key, id);
}

function buildResolver(pageIds: string[], sourceIds: string[]): Resolver {
  const byPath = new Map<string, string>();
  const byBase = new Map<string, string>();
  const byWikiPath = new Map<string, string>();
  for (const id of [...pageIds, ...sourceIds]) {
    pushUnique(byPath, id, id);
    const base = path.posix.basename(id).replace(/\.[^.]+$/, "");
    pushUnique(byBase, base, id);
    if (id.startsWith(`${WIKI_DIR}/`)) pushUnique(byWikiPath, id.slice(WIKI_DIR.length + 1), id);
  }
  return { byPath, byBase, byWikiPath };
}

/**
 * 三层解析：完整相对路径 → 文件名（去扩展名）→ wiki 内路径。
 * 三种写法不同但指向同一文件的引用都要能命中；都命中不了返回 null（调用方忽略该条）。
 */
export function resolveTarget(raw: string, resolver: Resolver): string | null {
  const cleaned = raw
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/^\.\//, "")
    .replace(/\\/g, "/")
    .split("#")[0]!
    .trim();
  if (!cleaned) return null;

  const rel = normalizeRel(cleaned);
  const direct = resolver.byPath.get(rel);
  if (direct) return direct;
  const wikiRel = rel.startsWith(`${WIKI_DIR}/`) ? rel : `${WIKI_DIR}/${rel}`;
  const viaWiki = resolver.byWikiPath.get(rel) ?? resolver.byPath.get(wikiRel);
  if (viaWiki) return viaWiki;
  const base = path.posix.basename(rel).replace(/\.[^.]+$/, "");
  return resolver.byBase.get(base) ?? null;
}

/** 从正文抽 `cites`：脚注引用 + 同段落里出现的页码 */
export function extractCitationEdges(body: string): { target: string; page: number | null }[] {
  const out: { target: string; page: number | null }[] = [];
  // 脚注定义：`[^1]: attention.md`，可跟页码 `, p.3` / `，p. 3`
  // 目标截到空白或逗号为止（否则 `attention.md,` 会把逗号吃进路径，带页码时整条匹配不上）
  const footnote = /^\[\^[^\]]+\]:\s*([^\s,，]+)([^\n]*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = footnote.exec(body)) !== null) {
    const target = m[1]!;
    const rest = m[2] ?? "";
    const pm = /[,，]\s*p[. ]?\s*(\d+)/i.exec(rest);
    out.push({ target, page: pm ? Number(pm[1]) : null });
  }
  return out;
}

/** 从正文抽 `links_to`：markdown 内链 */
export function extractLinkEdges(body: string): string[] {
  const out: string[] = [];
  const link = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = link.exec(body)) !== null) {
    const target = m[2]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // 跳过 http: / mailto: 等
    out.push(target);
  }
  return out;
}

/**
 * 解析 `relations` 项：frontmatter 的列表项被解析成原始字符串
 * （`"{target: 编码器.md, type: 对比}"`），这里再拆成对象。
 * 只做够用的解析：值里若含逗号会截断 —— 对文件名与关系名足够。
 */
export function parseRelationItem(raw: string): { target: string; type: string } | null {
  const inner = raw.trim().replace(/^\{/, "").replace(/\}$/, "");
  const fields: Record<string, string> = {};
  for (const part of inner.split(",")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) fields[key] = value;
  }
  const target = fields["target"];
  if (!target) return null;
  return { target, type: fields["type"] ?? "" };
}

/** 取页面 frontmatter 里声明的关系列表 */
export function declaredRelations(fm: Frontmatter): { target: string; type: string }[] {
  const raw = fm.data["relations"];
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out: { target: string; type: string }[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const parsed = parseRelationItem(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function edgeRank(e: GraphEdge): [number, number] {
  return [e.relation ? 1 : 0, e.page !== null ? 1 : 0];
}

/** 同 `(source, target, type)` 去重：`relation` 非空优先，其次带页码优先 */
export function mergeEdges(edges: GraphEdge[]): GraphEdge[] {
  const best = new Map<string, GraphEdge>();
  for (const e of edges) {
    const key = `${e.sourceId}\u0000${e.targetId}\u0000${e.type}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, e);
      continue;
    }
    const [r1, p1] = edgeRank(e);
    const [r2, p2] = edgeRank(prev);
    if (r1 > r2 || (r1 === r2 && p1 > p2)) best.set(key, e);
  }
  return [...best.values()];
}

/** 类型继承链：自身 → … → 顶层（来自 SCHEMA 的 `parent`） */
export function typeAncestors(schema: WikiSchema, type: string | null): string[] {
  if (!type || type === "source") return type ? [type] : [];
  const chain: string[] = [];
  let current: string | undefined = type;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = schema.entityTypes[current]?.parent;
  }
  return chain;
}

/** 标题：frontmatter.title → 正文首个标题 → 文件名 */
export function pageTitle(page: WikiPageInfo): string {
  const t = page.frontmatter.data["title"];
  const fromFm = typeof t === "string" ? t.trim() : "";
  if (fromFm) return fromFm;
  const h = /^#{1,6}\s+(.+)$/m.exec(page.frontmatter.body);
  if (h) return h[1]!.trim();
  return path.posix.basename(page.path).replace(/\.[^.]+$/, "");
}

/** 构建整张图（纯计算，不落盘） */
export async function buildGraph(workspaceDir: string): Promise<KnowledgeGraph> {
  const root = path.resolve(workspaceDir);
  const [pages, sources, schema] = await Promise.all([
    listWikiPages(root),
    listSourceFiles(root),
    loadWikiSchema(root),
  ]);

  const pageIds = pages.map((p) => p.path);
  const resolver = buildResolver(pageIds, sources);

  const nodes: GraphNode[] = [];
  for (const page of pages) {
    nodes.push({
      id: page.path,
      type: page.type ?? "unknown",
      title: pageTitle(page),
      path: page.path,
      typeAncestors: typeAncestors(schema, page.type),
      props: { sources: page.sources, sourceHashes: page.sourceHashes },
    });
  }
  for (const src of sources) {
    nodes.push({
      id: src,
      type: "source",
      title: path.posix.basename(src).replace(/\.[^.]+$/, ""),
      path: src,
      typeAncestors: ["source"],
      props: {},
    });
  }

  const edges: GraphEdge[] = [];
  for (const page of pages) {
    // ① 正文 → cites / links_to（**只用 body，不用 frontmatter**）
    for (const cite of extractCitationEdges(page.frontmatter.body)) {
      const targetId = resolveTarget(cite.target, resolver);
      if (!targetId || targetId === page.path) continue;
      edges.push({
        sourceId: page.path,
        targetId,
        type: "cites",
        page: cite.page,
        relation: "",
      });
    }
    for (const link of extractLinkEdges(page.frontmatter.body)) {
      const targetId = resolveTarget(link, resolver);
      if (!targetId || targetId === page.path) continue;
      // 指向源文件的链接不产生 links_to（与 llm-wiki 的历史语义一致）
      if (!targetId.startsWith(`${WIKI_DIR}/`)) continue;
      edges.push({ sourceId: page.path, targetId, type: "links_to", page: null, relation: "" });
    }
    // ② frontmatter 声明 → 带 relation 的 links_to
    for (const rel of declaredRelations(page.frontmatter)) {
      const targetId = resolveTarget(rel.target, resolver);
      if (!targetId || targetId === page.path) continue;
      edges.push({
        sourceId: page.path,
        targetId,
        type: "links_to",
        page: null,
        relation: rel.type,
      });
    }
  }

  return {
    builtAt: new Date().toISOString(),
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: mergeEdges(edges).sort(
      (a, b) => a.sourceId.localeCompare(b.sourceId) || a.targetId.localeCompare(b.targetId),
    ),
  };
}

/**
 * 全量重建并原子落盘到 `wiki/graph.json`。
 * 先算完整张图再一次性写文件（临时文件 + rename）—— 失败不会留下半张图。
 */
export async function rebuildGraph(
  workspaceDir: string,
): Promise<{ nodes: number; edges: number; citations: number; links: number; path: string }> {
  const root = path.resolve(workspaceDir);
  const graph = await buildGraph(root);
  const target = wikiGraphPath(root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(graph, null, 2), "utf8");
  await fs.rename(tmp, target);

  const citations = graph.edges.filter((e) => e.type === "cites").length;
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    citations,
    links: graph.edges.length - citations,
    path: target,
  };
}

/** 读图谱；文件不存在时按需重建一次（首次访问不需要用户先手动重建） */
export async function loadGraph(
  workspaceDir: string,
  options: { rebuildIfMissing?: boolean } = {},
): Promise<KnowledgeGraph> {
  const root = path.resolve(workspaceDir);
  try {
    const raw = await fs.readFile(wikiGraphPath(root), "utf8");
    const parsed = JSON.parse(raw) as KnowledgeGraph;
    if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) return parsed;
  } catch {
    /* 不存在或坏了 → 下面按需重建 */
  }
  if (options.rebuildIfMissing === false) {
    return { builtAt: "", nodes: [], edges: [] };
  }
  await rebuildGraph(root);
  const raw = await fs.readFile(wikiGraphPath(root), "utf8");
  return JSON.parse(raw) as KnowledgeGraph;
}

/**
 * 沿边把直接相关的节点纳入候选（图谱参与检索，task 12.9 的第一步）。
 * 返回除种子自身外的邻居 id 列表，按「命中次数」排序。
 */
export function expandByGraph(
  graph: KnowledgeGraph,
  seedIds: string[],
  direction: "out" | "in" | "both" = "both",
): string[] {
  const seeds = new Set(seedIds);
  const score = new Map<string, number>();
  for (const e of graph.edges) {
    const hitSource = seeds.has(e.sourceId);
    const hitTarget = seeds.has(e.targetId);
    const push = (id: string) => {
      if (seeds.has(id)) return;
      score.set(id, (score.get(id) ?? 0) + 1);
    };
    if (direction !== "in" && hitSource) push(e.targetId);
    if (direction !== "out" && hitTarget) push(e.sourceId);
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}