/**
 * wiki 页面枚举与「已收录」判定（tasks 11.13 / 11.14）。
 *
 * 已收录判定以页面元数据 `source:` 为准（对齐 llm-wiki `compile_brief.py`
 * 的 `_extract_fm_sources`：只认 frontmatter 区，不靠文件名猜测）。
 * 额外记录 `source_hash:`，使原始资料**改名但内容不变**时仍判定为已收录。
 */
import path from "node:path";
import fs from "node:fs/promises";

import {
  extractSourceHashes,
  extractSources,
  extractTitle,
  extractType,
  parseFrontmatter,
  type Frontmatter,
} from "./frontmatter.js";
import { INDEX_FILE, LOG_FILE, SCHEMA_FILE, WIKI_DIR, normalizeRel } from "./paths.js";

export interface WikiPageInfo {
  /** 工作区相对 POSIX 路径，如 `wiki/summaries/foo.md` */
  path: string;
  title: string;
  type: string | null;
  sources: string[];
  sourceHashes: string[];
  content: string;
  frontmatter: Frontmatter;
}

async function walk(
  dir: string,
  prefix: string,
  out: string[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(full, rel, out);
    } else if (entry.name.endsWith(".md")) {
      if (prefix === WIKI_DIR && (entry.name === SCHEMA_FILE || entry.name === INDEX_FILE || entry.name === LOG_FILE)) {
        continue;
      }
      out.push(rel);
    }
  }
}

/** 列举全部 wiki 内容页（不含 SCHEMA / index / log / raw） */
export async function listWikiPagePaths(workspaceDir: string): Promise<string[]> {
  const out: string[] = [];
  await walk(path.join(path.resolve(workspaceDir), WIKI_DIR), WIKI_DIR, out);
  return out.sort();
}

/**
 * 列举**源层**文件（工作区相对路径）。
 *
 * 源层 = 工作区里用户自己的文件（design D12：不另设 raw/ 目录）。排除：
 * - `.open-assistant/`（应用数据：会话库 / 定时任务 / 引导标记）
 * - `wiki/`（编译产物本身，不是源）
 * - `todos.json`（我们管理的文件，不是用户内容）
 * - 任何以 `.` 开头的条目（含 `.git` 之类）
 */
export async function listSourceFiles(workspaceDir: string): Promise<string[]> {
  const root = path.resolve(workspaceDir);
  const out: string[] = [];
  const SKIP_DIRS = new Set([".open-assistant", WIKI_DIR]);
  const SKIP_FILES = new Set(["todos.json"]);
  async function recur(dir: string, prefix: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await recur(path.join(dir, entry.name), rel);
      } else {
        if (SKIP_FILES.has(entry.name)) continue;
        out.push(rel);
      }
    }
  }
  await recur(root, "");
  return out.sort();
}

export async function readWikiPage(workspaceDir: string, pageRel: string): Promise<WikiPageInfo | null> {
  const rel = normalizeRel(pageRel);
  const full = path.join(path.resolve(workspaceDir), rel);
  let content: string;
  try {
    content = await fs.readFile(full, "utf8");
  } catch {
    return null;
  }
  const frontmatter = parseFrontmatter(content);
  return {
    path: rel,
    title: extractTitle(content) ?? path.basename(rel, ".md"),
    type: extractType(content),
    sources: extractSources(content),
    sourceHashes: extractSourceHashes(content),
    content,
    frontmatter,
  };
}

export async function listWikiPages(workspaceDir: string): Promise<WikiPageInfo[]> {
  const paths = await listWikiPagePaths(workspaceDir);
  const pages: WikiPageInfo[] = [];
  for (const rel of paths) {
    const page = await readWikiPage(workspaceDir, rel);
    if (page) pages.push(page);
  }
  return pages;
}

export interface IngestedLookup {
  /** wiki 相对路径（原始资料） */
  source: string;
  /** 原始资料内容的 sha256（可选） */
  hash?: string;
}

export interface IngestedMatch {
  found: boolean;
  /** 命中「已收录」的 wiki 页路径 */
  pages: string[];
  /** 命中依据 */
  by: "source" | "source_hash" | null;
}

const normalizeSourceRef = (value: string): string => normalizeRel(value).replace(/^\/+/, "");

/**
 * 判定一份原始资料是否已收录（以页面元数据为准）。
 * - `source:` 命中且 `source_hash:` 一致 → 已收录；
 * - `source:` 命中但内容变了（哈希不一致）→ **未收录**（新版本要重新收录）；
 * - 路径不命中但内容哈希命中（原始资料被改名）→ 已收录。
 */
export async function findIngestedSource(
  workspaceDir: string,
  lookup: IngestedLookup,
): Promise<IngestedMatch> {
  const source = normalizeSourceRef(lookup.source);
  const hash = lookup.hash ?? "";
  const pages = await listWikiPages(workspaceDir);
  const bySource = pages.filter((p) => p.sources.some((s) => normalizeSourceRef(s) === source));
  if (bySource.length > 0) {
    if (hash.length === 0) return { found: true, pages: bySource.map((p) => p.path), by: "source" };
    const exact = bySource.filter((p) => p.sourceHashes.includes(hash));
    if (exact.length > 0) return { found: true, pages: exact.map((p) => p.path), by: "source" };
    // 页面没记录哈希（手工创建 / 旧页面）→ 保守地当作已收录，不重复
    const noHash = bySource.filter((p) => p.sourceHashes.length === 0);
    if (noHash.length > 0) return { found: true, pages: noHash.map((p) => p.path), by: "source" };
    return { found: false, pages: [], by: null };
  }
  if (hash.length > 0) {
    const byHash = pages.filter((p) => p.sourceHashes.includes(hash));
    if (byHash.length > 0) return { found: true, pages: byHash.map((p) => p.path), by: "source_hash" };
  }
  return { found: false, pages: [], by: null };
}

/** 收集所有已收录的 source 值（调试 / 任务包用） */
export async function collectIngestedSources(workspaceDir: string): Promise<string[]> {
  const pages = await listWikiPages(workspaceDir);
  const set = new Set<string>();
  for (const page of pages) for (const source of page.sources) set.add(normalizeSourceRef(source));
  return [...set].sort();
}

export { normalizeSourceRef };