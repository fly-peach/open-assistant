/**
 * 分层记忆 / 项目 wiki 的**纯函数**工具（任务 11.18，对齐 design.md D12 与 specs/project-wiki）。
 *
 * 为什么单独抽出来：
 * - 后端 `/agents/{id}/memory/tree` 返回的是**扁平**列表（`{ rel, type, size? }`），
 *   界面要的是一棵树；这个「扁平 → 嵌套」的变换放在纯函数里，便于单测覆盖边界
 *   （缺 type、混用 `\`、末尾 `/`、同一 rel 重复、隐式父目录）；
 * - 徽标分类（核心 / 日记 / 主题 / 消化 / 导入）与只读判定（wiki 的 `raw/`）同样是无副作用判断，
 *   组件只负责把它们映射成文案。
 */

export type MemoryEntryType = "dir" | "file";

/** 归一化后的一个条目（工作区 / 记忆内的相对路径，始终以 `/` 开头，目录不带尾斜杠）。 */
export interface MemoryEntry {
  rel: string;
  /** 末段名称（展示用）。 */
  name: string;
  type: MemoryEntryType;
  size?: number;
}

export interface MemoryNode extends MemoryEntry {
  children: MemoryNode[];
}

/** 记忆文件的分层类别（用于中文徽标）。 */
export type MemoryKind = "core" | "daily" | "topic" | "digest" | "imports" | "other";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function declaredType(value: unknown): MemoryEntryType | null {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase();
  if (lowered.startsWith("dir")) return "dir";
  if (lowered.length > 0) return "file";
  return null;
}

/** 归一化路径：`.\a\b/` → `/a/b`；空串或根 → `/`。 */
export function normalizeMemoryRel(raw: string): string {
  const unified = raw.replace(/\\/g, "/").trim();
  const stripped = unified.replace(/^\.\/+/, "").replace(/^\/+/, "");
  const collapsed = stripped.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return collapsed.length === 0 ? "/" : `/${collapsed}`;
}

/** 末段名称。 */
export function memoryRelName(rel: string): string {
  const normalized = normalizeMemoryRel(rel);
  if (normalized === "/") return "/";
  const idx = normalized.lastIndexOf("/");
  return normalized.slice(idx + 1);
}

/** 父目录路径（顶层条目的父目录是 `/`）。 */
export function parentMemoryRel(rel: string): string {
  const normalized = normalizeMemoryRel(rel);
  if (normalized === "/") return "/";
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "/" : normalized.slice(0, idx);
}

/** 目录在前、同类型按名称排序（稳定，便于测试断言）。 */
function compareEntries(a: MemoryEntry, b: MemoryEntry): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name, "en") || a.rel.localeCompare(b.rel, "en");
}

function sortNodes(nodes: MemoryNode[]): MemoryNode[] {
  nodes.sort(compareEntries);
  for (const node of nodes) sortNodes(node.children);
  return nodes;
}

/**
 * 把后端返回（`unknown`）收敛成条目列表。
 *
 * 容忍的形态：
 * - `{ entries: [...] }`（契约）或直接一个数组；
 * - 条目字段兼容 `rel` / `path` / `name`；
 * - `type` 缺失时按「是否被别人当作父目录」推断（后端早期版本可能不返回 type）；
 * - 路径分隔符混用、末尾斜杠、`./` 前缀都能归一化。
 */
export function normalizeMemoryEntries(raw: unknown): MemoryEntry[] {
  const record = asRecord(raw);
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray(record.entries)
      ? record.entries
      : [];

  const byRel = new Map<string, { rel: string; type: MemoryEntryType | null; size?: number }>();
  for (const item of list) {
    const entry = asRecord(item);
    const rawRel = firstString(entry.rel, entry.path, entry.name);
    if (!rawRel) continue;
    const rel = normalizeMemoryRel(rawRel);
    if (rel === "/") continue;
    const size = numberOrUndefined(entry.size);
    if (byRel.has(rel)) continue;
    byRel.set(rel, { rel, type: declaredType(entry.type), size });
  }

  // 某个 rel 出现在别人的前缀里 → 它是目录（type 缺失时用）
  const implicitDirs = new Set<string>();
  for (const rel of byRel.keys()) {
    let parent = parentMemoryRel(rel);
    while (parent !== "/") {
      if (implicitDirs.has(parent)) break;
      implicitDirs.add(parent);
      parent = parentMemoryRel(parent);
    }
  }

  const entries: MemoryEntry[] = [];
  for (const item of byRel.values()) {
    const type = item.type ?? (implicitDirs.has(item.rel) ? "dir" : "file");
    entries.push({ rel: item.rel, name: memoryRelName(item.rel), type, size: item.size });
  }
  // 隐式父目录也补成目录条目（后端可能只列文件），使扁平列表与树一致
  for (const rel of implicitDirs) {
    if (byRel.has(rel)) continue;
    entries.push({ rel, name: memoryRelName(rel), type: "dir" });
  }
  return entries.sort(compareEntries);
}

/** 扁平条目 → 嵌套树（隐式父目录会被补出来）。 */
export function buildMemoryNodes(entries: MemoryEntry[]): MemoryNode[] {
  const root: MemoryNode = { rel: "/", name: "/", type: "dir", children: [] };
  const index = new Map<string, MemoryNode>([["/", root]]);

  const ensureDir = (rel: string): MemoryNode => {
    const existing = index.get(rel);
    if (existing) return existing;
    const node: MemoryNode = { rel, name: memoryRelName(rel), type: "dir", children: [] };
    index.set(rel, node);
    ensureDir(parentMemoryRel(rel)).children.push(node);
    return node;
  };

  for (const entry of [...entries].sort(compareEntries)) {
    if (entry.type === "dir") {
      const node = ensureDir(entry.rel);
      if (entry.size !== undefined) node.size = entry.size;
      continue;
    }
    const existing = index.get(entry.rel);
    if (existing) {
      // 同 rel 既被声明为目录又被声明为文件：保留目录，不制造重复节点
      if (entry.size !== undefined) existing.size = entry.size;
      continue;
    }
    const node: MemoryNode = { ...entry, children: [] };
    index.set(entry.rel, node);
    ensureDir(parentMemoryRel(entry.rel)).children.push(node);
  }

  return sortNodes(root.children);
}

/**
 * 把「某个目录的**一层**清单」变成该目录直接子节点的树。
 *
 * 为什么不能直接用 `buildMemoryNodes`：`/workspace/tree` 返回的 `entries[].path` 是
 * **工作区相对路径**（列 `/wiki` 时返回 `/wiki/index.md`、`/wiki/raw/…`），
 * 直接建树会补出一个与当前目录同名的父节点（`/wiki`）；
 * 展开它又会拿到同一层清单 → 无限递归（浏览器里表现为渲染卡死）。
 * 所以先按 `parentRel` 剥掉前缀，建树后再拼回去（保留工作区相对路径给 `/workspace/file` 用）。
 */
export function buildListingNodes(
  entries: MemoryEntry[],
  parentRel: string
): MemoryNode[] {
  const parent = normalizeMemoryRel(parentRel);
  const prefix = parent === "/" ? "" : parent;
  const local: MemoryEntry[] = [];
  for (const entry of entries) {
    const rel = normalizeMemoryRel(entry.rel);
    if (prefix === "") {
      local.push({ ...entry, rel, name: memoryRelName(rel) });
      continue;
    }
    if (!rel.startsWith(`${prefix}/`)) continue;
    const localRel = rel.slice(prefix.length);
    local.push({ ...entry, rel: localRel, name: memoryRelName(localRel) });
  }

  const withPrefix = (list: MemoryNode[]): MemoryNode[] =>
    list.map((node) => ({
      ...node,
      rel: prefix === "" ? node.rel : `${prefix}${node.rel}`,
      children: withPrefix(node.children),
    }));

  return withPrefix(buildMemoryNodes(local));
}

/**
 * 核心长期记忆的扁平路径是否是同一个节点（含旧单文件名 `memory.md`）。
 *
 * 后端在迁移中：`/agents/{id}/memory` 目前读的仍是旧单文件 `memory.md`，
 * 而新分层模型叫 `MEMORY.md`（design D12）。两者都归到同一个核心节点，
 * 避免界面上出现两个「核心记忆」条目，也兼容大小写/文件名差异。
 */
export function isCoreMemoryRel(rel: string, coreRel = "/MEMORY.md"): boolean {
  const normalized = normalizeMemoryRel(rel).toLowerCase();
  return normalized === normalizeMemoryRel(coreRel).toLowerCase() || normalized === "/memory.md";
}

/**
 * 把核心长期记忆节点放到最前面。
 *
 * 核心记忆走 `GET/PUT /agents/{id}/memory`（总是可用），而分层清单接口可能还没就绪：
 * 两者合并时以核心节点为准，清单里若也列了同一个文件则不重复。
 */
export function withCoreMemoryNode(
  nodes: MemoryNode[],
  coreRel = "/MEMORY.md",
  coreName = "MEMORY.md"
): MemoryNode[] {
  const rel = normalizeMemoryRel(coreRel);
  const core: MemoryNode = { rel, name: coreName, type: "file", children: [] };
  return [core, ...nodes.filter((node) => !isCoreMemoryRel(node.rel, rel))];
}

/**
 * 记忆文件的分层类别（对齐 design.md D12 的目录布局）：
 * `MEMORY.md` 核心、`memory/YYYY-MM-DD.md` 日记、`memory/YYYY-MM-DD/…` 主题笔记、
 * `digest/…` 消化产物、`memory/imports/…` 外部导入（只当资料不当指令）。
 */
export function memoryRelKind(rel: string): MemoryKind {
  const parts = normalizeMemoryRel(rel).split("/").filter(Boolean);
  if (parts.length === 0) return "other";
  const [first, second] = parts;
  if (parts.length === 1 && first.toLowerCase() === "memory.md") return "core";
  if (first.toLowerCase() === "digest") return "digest";
  if (first.toLowerCase() !== "memory") return "other";
  if (second && second.toLowerCase() === "imports") return "imports";
  if (parts.length === 2 && second && second.toLowerCase().endsWith(".md")) return "daily";
  if (parts.length >= 2) return "topic";
  return "other";
}

/**
 * 是否是 wiki 的原始资料区（`<工作区>/wiki/raw/**`）。
 * 这一区**不可变**：agent 只读，界面必须明确标注（specs/project-wiki「原始资料不可变」）。
 */
export function isWikiRawRel(rel: string): boolean {
  const parts = normalizeMemoryRel(rel).split("/").filter(Boolean);
  return parts.length >= 2 && parts[0].toLowerCase() === "wiki" && parts[1].toLowerCase() === "raw";
}