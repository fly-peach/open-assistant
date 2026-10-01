/**
 * wiki 页面的前置元数据（frontmatter）读写（tasks 11.10 / 11.14）。
 *
 * 页面格式（spec project-wiki / 页面带结构化元数据）：
 *   ---
 *   type: summary
 *   title: 注意力机制
 *   date: 2026-01-01
 *   source:
 *     - wiki/raw/attention.md
 *   source_hash: <sha256>
 *   ---
 *   正文…
 *
 * 「已收录判定以页面元数据 `source:` 为准」—— 参考 llm-wiki
 * `api/services/compile_brief.py` 的 `_extract_fm_sources`：只认 frontmatter 区，
 * 不靠文件名猜测。额外记录 `source_hash`，使原始资料**改名后内容不变**时仍能被
 * 判定为已收录（内容哈希是元数据，仍不是文件名推断）。
 */

export type FrontmatterValue = string | string[];
export interface Frontmatter {
  data: Record<string, FrontmatterValue>;
  body: string;
  ok: boolean;
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** 取 frontmatter 区的原始文本（不含分隔线）；没有则 null */
export function frontmatterBlock(content: string): string | null {
  if (typeof content !== "string") return null;
  const text = content.replace(/^\uFEFF/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? m[1] : null;
}

/** 解析 frontmatter（标量 / 字符串列表两种形态；容错，不抛错） */
export function parseFrontmatter(content: string): Frontmatter {
  if (typeof content !== "string") return { data: {}, body: "", ok: false };
  const text = content.replace(/^\uFEFF/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text, ok: false };
  const body = text.slice(m[0].length);
  return { data: parseFrontmatterBlock(m[1]), body, ok: true };
}

function parseFrontmatterBlock(block: string): Record<string, FrontmatterValue> {
  const data: Record<string, FrontmatterValue> = {};
  let currentKey: string | null = null;
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const item = /^-\s+(.*)$/.exec(trimmed);
    if (item && currentKey) {
      const value = stripQuotes(item[1]);
      const existing = data[currentKey];
      if (Array.isArray(existing)) existing.push(value);
      else if (typeof existing === "string" && existing.length > 0) data[currentKey] = [existing, value];
      else data[currentKey] = [value];
      continue;
    }

    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!kv) continue;
    currentKey = kv[1];
    const rawValue = kv[2].trim();
    if (rawValue === "") {
      data[currentKey] = "";
    } else if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1).trim();
      data[currentKey] = inner === "" ? [] : inner.split(",").map((v) => stripQuotes(v)).filter((v) => v.length > 0);
    } else {
      data[currentKey] = stripQuotes(rawValue);
    }
  }
  return data;
}

/** 把字段渲染成 frontmatter + 换行（调用方负责拼正文） */
export function renderFrontmatter(fields: Record<string, FrontmatterValue | undefined>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

/** 只更新 frontmatter 字段（合并数组去重），正文原样保留 */
export function upsertFrontmatter(
  content: string,
  updates: Record<string, FrontmatterValue>,
): string {
  const fm = parseFrontmatter(content);
  const ordered: Record<string, FrontmatterValue> = {};
  for (const key of Object.keys(fm.data)) ordered[key] = fm.data[key];
  for (const [key, value] of Object.entries(updates)) {
    const existing = ordered[key];
    if (Array.isArray(existing) || Array.isArray(value)) {
      const a = Array.isArray(existing) ? existing : existing ? [existing] : [];
      const b = Array.isArray(value) ? value : [value];
      ordered[key] = [...new Set([...a, ...b.filter((v) => v.length > 0)])];
    } else {
      ordered[key] = value;
    }
  }
  return renderFrontmatter(ordered) + fm.body;
}

/** 把一个字段值归一成去空字符串数组 */
export function toStringList(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter((v) => v.length > 0);
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
  return [];
}

/** 把 source 字段值归一成数组 */
export function sourceValues(data: Record<string, FrontmatterValue>): string[] {
  return toStringList(data["source"]);
}

/** 从页面内容提取 `source:`（对齐 `_extract_fm_sources`：只认 frontmatter 区） */
export function extractSources(content: string | null | undefined): string[] {
  if (!content) return [];
  const block = frontmatterBlock(content);
  if (block === null) return [];
  return sourceValues(parseFrontmatterBlock(block));
}

/** 从页面内容提取 `source_hash:` 列表（可写多个） */
export function extractSourceHashes(content: string | null | undefined): string[] {
  if (!content) return [];
  const block = frontmatterBlock(content);
  if (block === null) return [];
  return toStringList(parseFrontmatterBlock(block)["source_hash"]);
}

/** 从页面内容提取 `type:` */
export function extractType(content: string | null | undefined): string | null {
  if (!content) return null;
  const block = frontmatterBlock(content);
  if (block === null) return null;
  const value = parseFrontmatterBlock(block)["type"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** 从页面内容提取 `title:` */
export function extractTitle(content: string | null | undefined): string | null {
  if (!content) return null;
  const block = frontmatterBlock(content);
  if (block === null) return null;
  const value = parseFrontmatterBlock(block)["title"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}