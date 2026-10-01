/**
 * `wiki/index.md` 的增量维护与 `wiki/log.md` 的统一前缀追加（tasks 11.12）。
 *
 * - index.md：**内容导向**（每次收录 / 回填更新；提问先读它）。
 *   增量维护 = 只动目标分区与目标条目，保留其余文字（包括人写的项目记忆）。
 * - log.md：**时间导向**，append-only，每条以
 *   `## [YYYY-MM-DD] <动作> | <标题>` 开头，可用
 *   `grep "^## \[" log.md | tail -5` 取出最近 5 条。
 */
import fs from "node:fs/promises";
import path from "node:path";

import { writeTextAtomic } from "../agents/json-file.js";
import {
  INDEX_FILE,
  INDEX_SECTIONS,
  LOG_FILE,
  WIKI_DIR,
  toIndexLink,
  type IndexSection,
} from "./paths.js";
import { DEFAULT_INDEX_MD, DEFAULT_LOG_MD, readWikiText } from "./skeleton.js";

// —— 时间线 log.md ——

export interface WikiLogEntry {
  /** YYYY-MM-DD */
  date: string;
  /** ingest / query / lint / archive / contradiction / init … */
  action: string;
  title: string;
  /** 可选的多行说明（放在标题行之后，仍不影响前缀 grep） */
  details?: string;
}

/** 统一前缀：每条时间线记录的第一行 */
export const LOG_ENTRY_PREFIX = /^## \[(\d{4}-\d{2}-\d{2})\]\s*(\S+)\s*\|\s*(.*)$/;

export function todayIso(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function formatLogEntry(entry: WikiLogEntry): string {
  const head = `## [${entry.date}] ${entry.action} | ${entry.title}`;
  const body = entry.details?.trim();
  return body ? `${head}\n\n${body}\n` : `${head}\n`;
}

/** 追加一条时间线记录（只增不改；wiki 不存在也照常补出文件） */
export async function appendWikiLog(workspaceDir: string, entry: WikiLogEntry): Promise<string> {
  const full = `${WIKI_DIR}/${LOG_FILE}`;
  const current = (await readWikiText(workspaceDir, full)) ?? DEFAULT_LOG_MD;
  const base = current.trim().length > 0 ? current : DEFAULT_LOG_MD;
  const separator = base.endsWith("\n") ? "\n" : "\n\n";
  const line = formatLogEntry(entry);
  await writeTextAtomic(path.join(workspaceDir, WIKI_DIR, LOG_FILE), `${base}${separator}${line}`);
  return `## [${entry.date}] ${entry.action} | ${entry.title}`;
}

/** 解析时间线里全部条目（按出现顺序 = 时间顺序） */
export function listLogEntries(content: string): WikiLogEntry[] {
  const entries: WikiLogEntry[] = [];
  for (const line of String(content).split(/\r?\n/)) {
    const m = LOG_ENTRY_PREFIX.exec(line);
    if (m) entries.push({ date: m[1], action: m[2], title: m[3] });
  }
  return entries;
}

/** 最近 N 条（等价于 `grep "^## \[" log.md | tail -N`） */
export function latestLogEntries(content: string, limit: number): WikiLogEntry[] {
  const all = listLogEntries(content);
  if (limit <= 0) return [];
  return all.slice(-limit);
}

// —— 内容目录 index.md ——

export interface WikiIndexEntry {
  section: IndexSection;
  title: string;
  /** wiki 内相对链接（如 `summaries/foo.md`） */
  link: string;
  /** 一句话摘要 */
  summary: string;
}

export function formatIndexEntry(entry: WikiIndexEntry): string {
  const link = toIndexLink(entry.link);
  const summary = entry.summary.trim().replace(/\s+/g, " ");
  return summary.length > 0 ? `- [${entry.title}](${link}) — ${summary}` : `- [${entry.title}](${link})`;
}

const isSectionHeader = (line: string): boolean => /^##\s+/.test(line.trim());

/**
 * 增量维护 index.md：同链接的条目原地更新；否则插到目标分区末尾。
 * 其余分区与人写内容原样保留（不整体重写）。
 */
export async function upsertIndexEntry(
  workspaceDir: string,
  entry: WikiIndexEntry,
): Promise<{ created: boolean; updated: boolean }> {
  const content = (await readWikiText(workspaceDir, `${WIKI_DIR}/${INDEX_FILE}`)) ?? DEFAULT_INDEX_MD;
  const lines = content.split(/\r?\n/);
  const token = `](${toIndexLink(entry.link)})`;
  const newLine = formatIndexEntry(entry);

  const existing = lines.findIndex((line) => line.includes(token));
  if (existing !== -1) {
    const updated = lines[existing] !== newLine;
    lines[existing] = newLine;
    await writeTextAtomic(path.join(workspaceDir, WIKI_DIR, INDEX_FILE), lines.join("\n"));
    return { created: false, updated };
  }

  const header = `## ${entry.section}`;
  const headerIdx = lines.findIndex((line) => line.trim() === header);
  if (headerIdx === -1) {
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
    lines.push("", header, "", newLine, "");
  } else {
    let end = lines.length;
    for (let i = headerIdx + 1; i < lines.length; i += 1) {
      if (isSectionHeader(lines[i])) {
        end = i;
        break;
      }
    }
    let insertAt = end;
    while (insertAt - 1 > headerIdx && lines[insertAt - 1]?.trim() === "") insertAt -= 1;
    lines.splice(insertAt, 0, newLine);
  }
  await writeTextAtomic(path.join(workspaceDir, WIKI_DIR, INDEX_FILE), lines.join("\n"));
  return { created: true, updated: false };
}

/** 读取 index.md 文本；不存在 → null（不报错） */
export async function readWikiIndex(workspaceDir: string): Promise<string | null> {
  return readWikiText(workspaceDir, `${WIKI_DIR}/${INDEX_FILE}`);
}

/** 确保 index.md 至少具备四个分区（缺失时补在末尾，内容不动） */
export function ensureIndexSections(content: string): string {
  const lines = content.split(/\r?\n/);
  const have = new Set(
    lines.filter((l) => /^##\s+/.test(l.trim())).map((l) => l.trim().replace(/^##\s+/, "")),
  );
  const missing = INDEX_SECTIONS.filter((s) => !have.has(s));
  if (missing.length === 0) return content;
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  for (const section of missing) lines.push("", `## ${section}`, "");
  return `${lines.join("\n")}\n`;
}

/** 用给定内容替换 `## 项目记忆` 分区的正文（保留其他分区） */
export async function updateProjectMemorySection(workspaceDir: string, content: string): Promise<void> {
  const current = (await readWikiText(workspaceDir, `${WIKI_DIR}/${INDEX_FILE}`)) ?? DEFAULT_INDEX_MD;
  const base = ensureIndexSections(current);
  const lines = base.split(/\r?\n/);
  const header = "## 项目记忆";
  const headerIdx = lines.findIndex((line) => line.trim() === header);
  const block = content.trim().length > 0 ? content.replace(/\s+$/, "").split(/\r?\n/) : [];
  const inserted = block.length > 0 ? ["", ...block, ""] : [""];

  if (headerIdx === -1) {
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
    lines.push("", header, ...inserted);
  } else {
    let end = lines.length;
    for (let i = headerIdx + 1; i < lines.length; i += 1) {
      if (isSectionHeader(lines[i])) {
        end = i;
        break;
      }
    }
    lines.splice(headerIdx + 1, end - (headerIdx + 1), ...inserted);
  }
  await writeTextAtomic(path.join(workspaceDir, WIKI_DIR, INDEX_FILE), lines.join("\n"));
}

/** 读取 `## 项目记忆` 分区的正文（不含标题）；不存在 → "" */
export async function readProjectMemorySection(workspaceDir: string): Promise<string> {
  const content = (await readWikiText(workspaceDir, `${WIKI_DIR}/${INDEX_FILE}`)) ?? "";
  const lines = content.split(/\r?\n/);
  const headerIdx = lines.findIndex((line) => line.trim() === "## 项目记忆");
  if (headerIdx === -1) return "";
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (isSectionHeader(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(headerIdx + 1, end).join("\n").trim();
}

/** 抽取 index.md 里指向 wiki 页面的链接目标（用于 lint 的「是否列入目录」判定） */
export function indexLinkedTargets(content: string): string[] {
  const targets: string[] = [];
  const re = /\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const target = m[1].replace(/#.*$/, "").trim();
    if (target === "" || /^[a-z]+:\/\//i.test(target)) continue;
    targets.push(target);
  }
  return targets;
}

/** 便于测试与外部只读检查 */
export const INDEX_FILE_REL = `${WIKI_DIR}/${INDEX_FILE}`;
export const LOG_FILE_REL = `${WIKI_DIR}/${LOG_FILE}`;

/** 读取 log.md 文本；不存在 → null */
export async function readWikiLog(workspaceDir: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(workspaceDir, WIKI_DIR, LOG_FILE), "utf8");
  } catch {
    return null;
  }
}