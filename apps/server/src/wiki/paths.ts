/**
 * 项目 wiki 的路径与命名约定（tasks 11.9–11.17）。
 *
 * wiki 放在**工作区根**（与 `todos.json` 同级），因为它是给人看的内容
 * （design D12：人可读的放根目录；`.open-assistant/` 留给机器数据）。
 *
 * 目录结构（对齐 spec project-wiki / 目录骨架）：
 *   <工作区>/wiki/
 *   ├── SCHEMA.md      规范文件（纪律来源）
 *   ├── index.md       内容目录（每次收录更新；提问先读）
 *   ├── log.md         时间线（统一前缀，可 grep）
 *   ├── raw/           原始资料（不可变，agent 只读）
 *   ├── summaries/     摘要页 / 回填的分析页
 *   └── entities/<type>/  实体页（类型由 SCHEMA.md 定义）
 */
import path from "node:path";

export const WIKI_DIR = "wiki";
export const SCHEMA_FILE = "SCHEMA.md";
export const INDEX_FILE = "index.md";
export const LOG_FILE = "log.md";
export const GRAPH_FILE = "graph.json";
export const SUMMARIES_DIR = "summaries";
export const ENTITIES_DIR = "entities";

/** index.md 的固定分区标题（顺序即默认渲染顺序） */
export const INDEX_SECTIONS = ["摘要", "实体", "分析", "项目记忆"] as const;
export type IndexSection = (typeof INDEX_SECTIONS)[number];

/** 项目记忆在 index.md 里的保留分区 */
export const PROJECT_MEMORY_SECTION = "项目记忆";

/** 摘要页的 `type:` 值 */
export const SUMMARY_TYPE = "summary";
/** 回填分析页的 `type:` 值 */
export const ANALYSIS_TYPE = "analysis";

export function wikiDir(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), WIKI_DIR);
}
export function wikiSchemaPath(workspaceDir: string): string {
  return path.join(wikiDir(workspaceDir), SCHEMA_FILE);
}
export function wikiIndexPath(workspaceDir: string): string {
  return path.join(wikiDir(workspaceDir), INDEX_FILE);
}
export function wikiLogPath(workspaceDir: string): string {
  return path.join(wikiDir(workspaceDir), LOG_FILE);
}
export function wikiGraphPath(workspaceDir: string): string {
  return path.join(wikiDir(workspaceDir), GRAPH_FILE);
}
export function wikiSummariesDir(workspaceDir: string): string {
  return path.join(wikiDir(workspaceDir), SUMMARIES_DIR);
}
export function wikiEntitiesDir(workspaceDir: string): string {
  return path.join(wikiDir(workspaceDir), ENTITIES_DIR);
}

/** 是否是文件系统绝对路径（Windows 盘符 / UNC）；`/foo` 一律当成工作区虚拟路径 */
export function looksFilesystemAbsolute(input: string): boolean {
  const s = String(input);
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\") || s.startsWith("//");
}

/** 把任意（绝对 / 虚拟 / 相对）路径归一成工作区内 POSIX 相对路径（不带前导斜杠） */
export function toWorkspaceRel(workspaceDir: string, input: string): string {
  const raw = String(input).replace(/\\/g, "/").trim();
  if (looksFilesystemAbsolute(input)) {
    return path.relative(path.resolve(workspaceDir), path.resolve(input)).replace(/\\/g, "/");
  }
  if (raw.startsWith("/")) {
    // 可能是工作区虚拟路径（`/wiki/...`），也可能是 POSIX 真实绝对路径：优先看真实绝对能否落在工作区内
    const fromAbs = path.relative(path.resolve(workspaceDir), path.resolve(input)).replace(/\\/g, "/");
    if (fromAbs !== "" && !fromAbs.startsWith("..") && !path.isAbsolute(fromAbs)) return fromAbs;
    return raw.replace(/^\.?\/*/, "");
  }
  return raw.replace(/^\.?\/*/, "");
}

/** 去掉前导斜杠与 `./`，统一正斜杠 */
export function normalizeRel(rel: string): string {
  return String(rel).replace(/\\/g, "/").replace(/^\.?\/*/, "");
}

/** 把目录约定归一成 `wiki/xxx/` 形式（带尾斜杠，正斜杠） */
export function normalizeFolder(folder: string): string {
  let f = String(folder).replace(/\\/g, "/").trim().replace(/^\.?\/*/, "");
  if (f === "") f = WIKI_DIR;
  if (!f.startsWith(`${WIKI_DIR}/`) && f !== WIKI_DIR) f = `${WIKI_DIR}/${f}`;
  if (!f.endsWith("/")) f += "/";
  return f;
}

/** 判断 rel 是否在 folder 之内（不含 folder 自身） */
export function isInsideFolder(rel: string, folder: string): boolean {
  const r = normalizeRel(rel);
  const f = normalizeFolder(folder);
  return r.startsWith(f) && r.length > f.length;
}

/** 生成安全文件名（保留中文，去掉路径分隔符与非法字符） */
export function slugify(title: string): string {
  const base = String(title)
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return base.length > 0 ? base.slice(0, 80) : "page";
}

/** 把 wiki 相对路径变成 index.md 里可点的相对链接（index 与页同级，去 `wiki/` 前缀） */
export function toIndexLink(pageRel: string): string {
  const rel = normalizeRel(pageRel);
  return rel.startsWith(`${WIKI_DIR}/`) ? rel.slice(WIKI_DIR.length + 1) : rel;
}