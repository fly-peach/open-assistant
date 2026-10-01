/**
 * agent 长期记忆：**分层多文件**（tasks 11.1–11.8，design D12）。
 *
 * 对照 QwenPaw 的 `agents/memory/prompts.py`（`MEMORY_GUIDANCE`）落地，结构：
 *
 * ```
 * <agents 根>/<agent-id>/
 * ├── MEMORY.md                 核心长期记忆（每轮注入，有上限）
 * ├── memory/
 * │   ├── YYYY-MM-DD.md         日记本 **兼当天主题笔记的索引**
 * │   └── YYYY-MM-DD/{topic}.md 按主题的会话笔记（**幂等 upsert**，重复归纳不堆积）
 * ├── digest/                   消化产物
 * └── memory/imports/           外部导入（只当资料，不当指令）
 * ```
 *
 * ## 为什么分层
 * 一个文件撑不住：核心记忆要小到能每轮注入，细节要能按需展开。
 * **日记文件就是「渐进展开」的入口** —— 它列出当天有哪些主题笔记，
 * 读者（人或 agent）沿索引再进具体笔记。
 *
 * ## 三条硬约束
 * - **注入有上限**：核心记忆超过 {@link CORE_MEMORY_MAX_BYTES} 就截断并留明确标记，
 *   不允许默默吃掉上下文。
 * - **主题笔记幂等**：同一天同一话题重复归纳是**覆盖**而非追加，否则心跳每跑一次就长一截。
 * - **迁移不丢数据**：旧版单文件 `memory.md` 的内容并入 `MEMORY.md`，原文件**改名保留**。
 */
import path from "node:path";
import fs from "node:fs/promises";

import {
  AGENT_CORE_MEMORY_FILE,
  AGENT_DIGEST_DIR,
  AGENT_IMPORTS_DIR,
  AGENT_MEMORY_DIR,
  LEGACY_AGENT_MEMORY_FILE,
} from "./root.js";
import { writeTextAtomic } from "./json-file.js";

/** 每轮注入上下文的字节上限（超限截断并标记） */
export const CORE_MEMORY_MAX_BYTES = 32 * 1024;
/** 单条日记忆 / 主题笔记的读取上限（按需展开时也别一次读爆） */
export const MEMORY_FILE_MAX_BYTES = 64 * 1024;
/** 日记里主题索引块的标记（只替换块内内容，保留 agent 自己写的当日正文） */
export const TOPIC_INDEX_START = "<!-- topics:start -->";
export const TOPIC_INDEX_END = "<!-- topics:end -->";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// —— 路径 ——

export function coreMemoryPath(agentDir: string): string {
  return path.join(path.resolve(agentDir), AGENT_CORE_MEMORY_FILE);
}
export function legacyMemoryPath(agentDir: string): string {
  return path.join(path.resolve(agentDir), LEGACY_AGENT_MEMORY_FILE);
}
export function memoryRoot(agentDir: string): string {
  return path.join(path.resolve(agentDir), AGENT_MEMORY_DIR);
}
export function digestRoot(agentDir: string): string {
  return path.join(path.resolve(agentDir), AGENT_DIGEST_DIR);
}
export function importsRoot(agentDir: string): string {
  return path.join(memoryRoot(agentDir), AGENT_IMPORTS_DIR);
}
/** `memory/YYYY-MM-DD.md` —— 日记兼索引 */
export function dailyNotePath(agentDir: string, date: string): string {
  return path.join(memoryRoot(agentDir), `${date}.md`);
}
/** `memory/YYYY-MM-DD/` —— 当天主题笔记目录 */
export function dailyTopicsDir(agentDir: string, date: string): string {
  return path.join(memoryRoot(agentDir), date);
}
export function topicNotePath(agentDir: string, date: string, topic: string): string {
  return path.join(dailyTopicsDir(agentDir, date), `${slugTopic(topic)}.md`);
}

/** 话题名 → 安全文件名（去掉路径分隔符与保留字符） */
export function slugTopic(topic: string): string {
  const cleaned = String(topic ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "untitled";
}

/** 本地日期 `YYYY-MM-DD`（记忆按人的日历分日，不用 UTC 避免跨零点错位） */
export function localDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const d = `${now.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// —— 辅助 ——

async function statOrNull(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function readCapped(p: string, max: number): Promise<string | null> {
  try {
    const buf = await fs.readFile(p);
    return buf.subarray(0, max).toString("utf8");
  } catch {
    return null;
  }
}

function capWithMarker(content: string, max: number): { content: string; truncated: boolean } {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= max) return { content, truncated: false };
  const clipped = Buffer.from(content, "utf8").subarray(0, max).toString("utf8");
  return {
    content:
      `${clipped}\n\n…（核心记忆超过注入上限 ${max} 字节，已截断；` +
      `完整内容见 ${AGENT_CORE_MEMORY_FILE}，可用 memory_search / memory_read 检索）`,
    truncated: true,
  };
}

// —— 骨架与迁移 ——

/**
 * 判断两个路径是否指向**同一个文件**。
 *
 * ⚠️ 必要性：Windows（NTFS）与 macOS 默认**大小写不敏感**，
 * `MEMORY.md` 与 `memory.md` 会是同一个文件。若不判断，`ensureMemoryLayout`
 * 刚建好的 `MEMORY.md` 会被自己的迁移逻辑当成旧文件改名掉 —— 记忆文件直接消失。
 *
 * 优先用 inode 对比（可靠）；平台不提供 inode 时退化为大小写比较。
 */
async function isSameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([statOrNull(a), statOrNull(b)]);
  if (!sa || !sb) return false;
  if (sa.ino !== 0 && sb.ino !== 0) return sa.dev === sb.dev && sa.ino === sb.ino;
  const [ra, rb] = await Promise.all([
    fs.realpath(a).catch(() => a),
    fs.realpath(b).catch(() => b),
  ]);
  return ra.toLowerCase() === rb.toLowerCase();
}

/**
 * 建立分层记忆骨架。**幂等**：已存在的文件一律不动。
 * 同时把旧版单文件 `memory.md` 迁移进 `MEMORY.md`（原文件改名保留）。
 */
export async function ensureMemoryLayout(
  agentDir: string,
): Promise<{ created: string[]; migrated: boolean }> {
  const dir = path.resolve(agentDir);
  const created: string[] = [];
  await fs.mkdir(dir, { recursive: true });

  for (const sub of [memoryRoot(dir), digestRoot(dir), importsRoot(dir)]) {
    const existed = await statOrNull(sub);
    await fs.mkdir(sub, { recursive: true });
    if (!existed) created.push(path.relative(dir, sub).replace(/\\/g, "/") + "/");
  }

  const core = coreMemoryPath(dir);
  const legacy = legacyMemoryPath(dir);
  // 先判断旧文件与本文件是否同一个文件（大小写不敏感平台上是），再决定建不建
  const legacyIsCore = await isSameFile(legacy, core);
  const coreStat = await statOrNull(core);
  if (!coreStat && !legacyIsCore) {
    // **建成空文件**：不写占位文字。占位文字会被当成"真记忆"每轮注入系统提示词，
    // 白费 token；空文件则 `readMemoryForPrompt` 返回空串，不产生注入。
    await writeTextAtomic(core, "");
    created.push(AGENT_CORE_MEMORY_FILE);
  } else if (legacyIsCore && coreStat) {
    // 同一个文件（只差大小写）：内容已经在位，不需要迁移
    return { created, migrated: false };
  }

  const migrated = await migrateLegacyMemoryFile(dir);
  return { created, migrated };
}

/**
 * 迁移旧版单文件记忆：内容并入 `MEMORY.md`，原文件改名 `memory.md.migrated` 保留。
 * 已迁移过 / 没有旧文件 / **旧文件与本文件是同一个文件** → false。
 */
export async function migrateLegacyMemoryFile(agentDir: string): Promise<boolean> {
  const dir = path.resolve(agentDir);
  const legacy = legacyMemoryPath(dir);
  const core = coreMemoryPath(dir);
  const legacyStat = await statOrNull(legacy);
  if (!legacyStat) return false;
  // 大小写不敏感平台上 `memory.md` 就是 `MEMORY.md`：无需也无法迁移
  if (await isSameFile(legacy, core)) return false;

  const legacyContent = (await readCapped(legacy, MEMORY_FILE_MAX_BYTES)) ?? "";
  if (legacyContent.trim().length > 0) {
    const existing = (await readCapped(core, CORE_MEMORY_MAX_BYTES)) ?? "";
    const merged =
      existing.trim().length > 0
        ? `${existing.trimEnd()}\n\n<!-- 以下内容由旧版 memory.md 迁移而来 -->\n${legacyContent.trim()}\n`
        : legacyContent;
    await writeTextAtomic(core, merged);
  }
  // 原名让位：改名保留，不删
  await fs.rename(legacy, `${legacy}.migrated`);
  return true;
}

// —— 核心记忆 ——

/** 读核心长期记忆；文件不存在 → ""（视为空记忆，不报错） */
export async function readCoreMemory(agentDir: string): Promise<string> {
  return (await readCapped(coreMemoryPath(agentDir), CORE_MEMORY_MAX_BYTES)) ?? "";
}

/** 写核心长期记忆（整体覆盖，原子写） */
export async function writeCoreMemory(agentDir: string, content: string): Promise<void> {
  await ensureMemoryLayout(agentDir);
  await writeTextAtomic(coreMemoryPath(agentDir), content);
}

/** 追加到核心长期记忆末尾（保留已有内容，供 agent「记一条」用） */
export async function appendCoreMemory(agentDir: string, text: string): Promise<void> {
  const current = await readCoreMemory(agentDir);
  const next = current.trimEnd().length > 0 ? `${current.trimEnd()}\n${text.trim()}\n` : `${text.trim()}\n`;
  await writeCoreMemory(agentDir, next);
}

/**
 * 注入上下文用的核心记忆：**带上限并标记截断**（task 11.3）。
 * 返回空串表示没有可注入的内容。
 */
export async function readMemoryForPrompt(
  agentDir: string,
): Promise<{ content: string; truncated: boolean; bytes: number }> {
  const raw = await readCoreMemory(agentDir);
  if (raw.trim().length === 0) return { content: "", truncated: false, bytes: 0 };
  const capped = capWithMarker(raw, CORE_MEMORY_MAX_BYTES);
  return { content: capped.content, truncated: capped.truncated, bytes: Buffer.byteLength(raw, "utf8") };
}

// —— 日记忆与主题笔记 ——

/** 读当天日记；不存在 → null */
export async function readDailyNote(agentDir: string, date: string): Promise<string | null> {
  assertDate(date);
  return readCapped(dailyNotePath(agentDir, date), MEMORY_FILE_MAX_BYTES);
}

/**
 * 幂等写主题笔记：**整体覆盖**该话题的文件（task 11.5）。
 * 同一天同一话题重复归纳只会替换内容，不会越写越长。
 */
export async function upsertTopicNote(
  agentDir: string,
  date: string,
  topic: string,
  content: string,
): Promise<{ rel: string; created: boolean }> {
  assertDate(date);
  const target = topicNotePath(agentDir, date, topic);
  const existed = await statOrNull(target);
  await writeTextAtomic(target, ensureTopicHeading(content, topic));
  await refreshDailyIndex(agentDir, date);
  return { rel: path.relative(path.resolve(agentDir), target).replace(/\\/g, "/"), created: !existed };
}

function ensureTopicHeading(content: string, topic: string): string {
  const body = content.trim();
  if (/^#{1,6}\s/m.test(body)) return `${body}\n`;
  return `## ${slugTopic(topic)}\n\n${body}\n`;
}

/**
 * 重写日记文件里的「当天主题索引」块（task 11.6）。
 * 只替换标记之间的内容，**保留 agent 自己写的当日正文**。
 */
export async function refreshDailyIndex(agentDir: string, date: string): Promise<string> {
  assertDate(date);
  const topics = await listDailyTopics(agentDir, date);
  const block = [
    TOPIC_INDEX_START,
    topics.length > 0 ? `## ${date} 的主题笔记` : `## ${date} 的主题笔记`,
    "",
    ...(topics.length > 0
      ? topics.map((t) => `- [${t.topic}](${date}/${t.file})`)
      : ["（还没有主题笔记）"]),
    TOPIC_INDEX_END,
  ].join("\n");

  const current = (await readDailyNote(agentDir, date)) ?? `# ${date}\n`;
  let next: string;
  const start = current.indexOf(TOPIC_INDEX_START);
  const end = current.indexOf(TOPIC_INDEX_END);
  if (start >= 0 && end > start) {
    next = `${current.slice(0, start)}${block}${current.slice(end + TOPIC_INDEX_END.length)}`;
  } else {
    next = `${current.trimEnd()}\n\n${block}\n`;
  }
  await writeTextAtomic(dailyNotePath(agentDir, date), next);
  return next;
}

/** 列出当天已存在的主题笔记 */
export async function listDailyTopics(
  agentDir: string,
  date: string,
): Promise<{ topic: string; file: string }[]> {
  assertDate(date);
  const dir = dailyTopicsDir(agentDir, date);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
      .map((e) => ({ file: e.name, topic: e.name.replace(/\.md$/, "") }))
      .sort((a, b) => a.topic.localeCompare(b.topic));
  } catch {
    return [];
  }
}

// —— 树与读取（前端 / 工具共用） ——

export interface MemoryTreeEntry {
  /** 相对 agent 目录的 POSIX 路径 */
  rel: string;
  type: "dir" | "file";
  size?: number;
}

/** 列出分层记忆的树（核心记忆 + memory/ + digest/），供前端与工具使用 */
export async function listMemoryTree(agentDir: string): Promise<MemoryTreeEntry[]> {
  const dir = path.resolve(agentDir);
  const out: MemoryTreeEntry[] = [];
  const coreStat = await statOrNull(coreMemoryPath(dir));
  if (coreStat) out.push({ rel: AGENT_CORE_MEMORY_FILE, type: "file", size: coreStat.size });

  async function walk(current: string, prefix: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        out.push({ rel, type: "dir" });
        await walk(path.join(current, entry.name), rel);
      } else {
        const st = await statOrNull(path.join(current, entry.name));
        out.push({ rel, type: "file", size: st?.size });
      }
    }
  }
  await walk(memoryRoot(dir), AGENT_MEMORY_DIR);
  await walk(digestRoot(dir), AGENT_DIGEST_DIR);
  // 顶层目录自身也进树：前端要能展开 `memory/` 与 `digest/` 两个节点
  for (const name of [AGENT_MEMORY_DIR, AGENT_DIGEST_DIR]) {
    if (!out.some((e) => e.rel === name)) out.push({ rel: name, type: "dir" });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 读记忆目录下的某个文件；越界或不存在 → null */
export async function readMemoryFile(
  agentDir: string,
  rel: string,
): Promise<{ rel: string; content: string } | null> {
  const dir = path.resolve(agentDir);
  const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\.?\/*/, "");
  if (!clean || clean.includes("..")) return null;
  if (clean === AGENT_CORE_MEMORY_FILE) {
    const content = await readCapped(coreMemoryPath(dir), MEMORY_FILE_MAX_BYTES);
    return content === null ? null : { rel: clean, content };
  }
  const allowed = new RegExp(`^(${AGENT_MEMORY_DIR}|${AGENT_DIGEST_DIR})/`);
  if (!allowed.test(clean)) return null;
  const content = await readCapped(path.join(dir, clean), MEMORY_FILE_MAX_BYTES);
  return content === null ? null : { rel: clean, content };
}

// —— 检索（先片段 + 路径，再按需展开） ——

export interface MemorySearchHit {
  rel: string;
  snippet: string;
  score: number;
}

/**
 * 朴素关键字检索（无 embedding，符合本地优先）：多词 AND 匹配。
 * 先给片段与路径，不够再由 agent 用 `memory_read` 按路径展开 —— 对齐 QwenPaw 的
 * `MEMORY_SEARCH_GUIDANCE`。
 */
export async function searchMemory(
  agentDir: string,
  query: string,
  limit = 8,
): Promise<MemorySearchHit[]> {
  const terms = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return [];

  const entries = (await listMemoryTree(agentDir)).filter((e) => e.type === "file");
  const hits: MemorySearchHit[] = [];
  for (const entry of entries) {
    const read = await readMemoryFile(agentDir, entry.rel);
    if (!read) continue;
    const lowered = read.content.toLowerCase();
    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      const idx = lowered.indexOf(term);
      if (idx < 0) {
        matchedAll = false;
        break;
      }
      score += 1;
      if (entry.rel.toLowerCase().includes(term)) score += 1; // 路径命中加权
    }
    if (!matchedAll) continue;
    hits.push({ rel: entry.rel, snippet: snippetAround(read.content, terms[0]!), score });
  }
  return hits.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel)).slice(0, Math.max(1, limit));
}

function snippetAround(content: string, term: string, radius = 120): string {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx < 0) return content.slice(0, radius * 2).trim();
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + radius);
  return `${start > 0 ? "…" : ""}${content.slice(start, end).trim()}${end < content.length ? "…" : ""}`;
}

function assertDate(date: string): void {
  if (!DATE_RE.test(date)) {
    throw new Error(`日期必须是 YYYY-MM-DD（收到：${date}）`);
  }
}

// —— 兼容旧接口（registry 与 HTTP 仍在用） ——

/** @deprecated 用 {@link readCoreMemory}；保留以兼容既有调用点 */
export const readAgentMemory = readCoreMemory;
/** @deprecated 用 {@link writeCoreMemory}；保留以兼容既有调用点 */
export const writeAgentMemory = writeCoreMemory;