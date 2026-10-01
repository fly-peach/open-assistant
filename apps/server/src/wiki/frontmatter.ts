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

// —— YAML 块标量（`>` 折叠 / `|` 字面量，含 chomping 与显式缩进指示符）——
//
// 手写解析器原先只认「单行键: 值」，把 `description: >-` 读成字符串 ">-"、
// 并把缩进续行静默丢弃。但 SPEC.md 的契约是 **YAML frontmatter**，块标量是合法 YAML，
// 解析器必须支持（不能要求用户迁就解析器）。以下为**纯增量**：只有值恰好是块标量头时
// 才进入新分支，其余路径逐字节不变。

type BlockChomp = "strip" | "clip" | "keep";

interface BlockScalarHeader {
  /** `>` 折叠成空格；`|` 保留换行 */
  style: "|" | ">";
  /** `-` 去尾换行；`+` 保留；缺省 clip（恰好一个尾换行） */
  chomp: BlockChomp;
  /** 显式缩进指示符（`|2-`），缺省 null = 由首个非空续行的缩进决定 */
  indentIndicator: number | null;
}

const BLOCK_SCALAR_HEADER = /^([|>])([+-]?)(\d*)$/;
const BLOCK_SCALAR_HEADER_ALT = /^([|>])(\d+)([+-]?)$/;

function chompOf(flag: string): BlockChomp {
  if (flag === "-") return "strip";
  if (flag === "+") return "keep";
  return "clip";
}

function parseBlockScalarHeader(raw: string): BlockScalarHeader | null {
  const m = BLOCK_SCALAR_HEADER.exec(raw);
  if (m) {
    return { style: m[1] as "|" | ">", chomp: chompOf(m[2]), indentIndicator: m[3] === "" ? null : Number(m[3]) };
  }
  const alt = BLOCK_SCALAR_HEADER_ALT.exec(raw);
  if (alt) {
    return { style: alt[1] as "|" | ">", chomp: chompOf(alt[3]), indentIndicator: Number(alt[2]) };
  }
  return null;
}

/** 值是否恰好是一个块标量头（供渲染端避免写出歧义值、供 agents/team.ts 识别续行） */
export function isBlockScalarHeader(value: string): boolean {
  return parseBlockScalarHeader(value.trim()) !== null;
}

function leadingSpaces(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].length : 0;
}

/**
 * 从 `start` 行起消费一个块标量：只吃**缩进比 key 更深**的行（空行算续行），
 * 遇到同级 / 更浅的非空行即停（该行留给主循环）。
 */
function readBlockScalar(
  lines: string[],
  start: number,
  keyIndent: number,
  header: BlockScalarHeader,
): { text: string; next: number } {
  const collected: string[] = [];
  let blockIndent = header.indentIndicator === null ? null : keyIndent + header.indentIndicator;
  let i = start;
  for (; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.replace(/\s+$/, "").trim() === "") {
      collected.push("");
      continue;
    }
    const indent = leadingSpaces(raw);
    if (indent <= keyIndent) break;
    if (blockIndent === null) blockIndent = indent;
    else if (indent < blockIndent) break;
    collected.push(raw.slice(blockIndent));
  }

  let text: string;
  if (header.style === ">") {
    // 折叠：相邻文本行用空格连接，空行折叠成换行
    let out = "";
    let blanks = 0;
    for (const line of collected) {
      if (line.trim() === "") {
        blanks += 1;
        continue;
      }
      if (out !== "") out += blanks > 0 ? "\n".repeat(blanks) : " ";
      out += line;
      blanks = 0;
    }
    text = `${out}${"\n".repeat(1 + blanks)}`;
  } else {
    text = collected.map((line) => `${line}\n`).join("");
  }

  if (header.chomp === "strip") {
    text = text.replace(/\n+$/, "");
  } else if (header.chomp === "clip") {
    const stripped = text.replace(/\n+$/, "");
    text = stripped === "" ? "" : `${stripped}\n`;
  }
  return { text, next: i };
}

/**
 * 渲染一个多行字符串为块标量：保证 `parse(render(x)) === x`。
 * 一律用显式 chomping（`|-` / `|+`），尾随换行数因此可精确还原；
 * 首行以空白开头时补上缩进指示符，避免缩进宽度被当成块缩进而丢空格。
 */
function renderBlockScalarLines(key: string, value: string): string[] {
  const indent = "  ";
  const trailing = value.length - value.replace(/\n+$/, "").length;
  const core = value.slice(0, value.length - trailing);
  let header: string;
  let content: string[];
  if (trailing === 0) {
    header = "|-";
    content = value.split("\n");
  } else {
    header = "|+";
    content = [...core.split("\n"), ...new Array<string>(trailing - 1).fill("")];
  }
  if (content.length > 0 && /^[ \t]/.test(content[0])) {
    header = `|${indent.length}${header.slice(1)}`;
  }
  return [`${key}: ${header}`, ...content.map((line) => (line === "" ? "" : `${indent}${line}`))];
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
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
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
      const header = parseBlockScalarHeader(rawValue);
      if (header) {
        const { text, next } = readBlockScalar(lines, i + 1, leadingSpaces(raw), header);
        data[currentKey] = text;
        i = next - 1;
      } else {
        data[currentKey] = stripQuotes(rawValue);
      }
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
    } else if (value.includes("\n")) {
      // 多行字符串必须写成块标量：直接 `${key}: ${value}` 会把真实换行写进单行、损坏文件
      lines.push(...renderBlockScalarLines(key, value));
    } else if (isBlockScalarHeader(value)) {
      // 单行但恰好长得像块标量头（">-"、"|"）→ 加引号，避免回读时被当成块标量
      lines.push(`${key}: ${JSON.stringify(value)}`);
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