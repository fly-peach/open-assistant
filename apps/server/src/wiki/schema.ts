/**
 * `wiki/SCHEMA.md` 的默认内容、解析与页面归属校验（tasks 11.9 / 11.10）。
 *
 * 规范文件是**纪律来源**：它告诉 agent 实体类型 / 目录约定 / 页面字段，
 * 使 wiki 保持一致结构（spec project-wiki / 规范文件是纪律来源）。
 *
 * 解析目标（对齐 llm-wiki `api/services/schema.py` 的 load_schema）：
 *   entity_types: { <key>: { label, folder, parent?, fields? } }
 *   page_roles:   { <role>: <folder> }
 *   relations:    [ <key>... ]
 *
 * 没有引入 YAML 依赖：本项目的 SCHEMA frontmatter 只用到一个受控子集
 * （缩进映射 / 短横线序列 / `{a: b}` 与 `[a, b]` 内联形式），这里自带一个
 * 小型解析器；任何解析失败都回落到默认规范并记录 errors（不阻断调用）。
 */
import fs from "node:fs/promises";

import { frontmatterBlock } from "./frontmatter.js";
import { isInsideFolder, normalizeFolder, normalizeRel } from "./paths.js";
import { wikiSchemaPath } from "./paths.js";

export interface WikiFieldDef {
  name: string;
  type: string;
}
export interface WikiEntityType {
  key: string;
  label: string;
  folder: string;
  parent?: string;
  fields: WikiFieldDef[];
}
export interface WikiSchema {
  version: number;
  entityTypes: Record<string, WikiEntityType>;
  pageRoles: Record<string, string>;
  relations: string[];
  /** 来源：文件解析结果 or 内置默认（文件缺失 / 解析失败） */
  source: "file" | "default";
  /** 解析过程中的可读问题（非致命） */
  errors: string[];
  /** 原始解析结果，便于调试 */
  raw: Record<string, unknown>;
}

/** SCHEMA.md 的默认内容（首次初始化写入；非空目录不覆盖同名文件） */
export const DEFAULT_SCHEMA_MD = `---
version: 1
entity_types:
  concept: {label: 概念, folder: wiki/entities/concept/}
  paper: {label: 论文, folder: wiki/entities/paper/}
  person: {label: 人物, folder: wiki/entities/person/}
  project: {label: 项目, folder: wiki/entities/project/}
page_roles:
  summary: wiki/summaries/
  analysis: wiki/summaries/
relations:
  - 对比
  - 支持
  - 引用
---

# 项目 Wiki 规范（SCHEMA）

这份文件是 wiki 的**纪律来源**：agent 维护 wiki 时必须遵循下面的约定，
这样即使资料不断累加，结构也不会散架。

## 三层结构

| 层 | 位置 | 谁拥有 | 可变性 |
| --- | --- | --- | --- |
| 源层 | 工作区里**用户自己的文件**（不另设 raw/ 目录） | 人 / 外部来源 | agent 读取，不擅自改写 |
| wiki | \`wiki/summaries/\`、\`wiki/entities/\`、\`wiki/graph.json\` | agent | agent 可创建与维护 |
| 规范 | \`wiki/SCHEMA.md\`（本文件） | 人 | 人可自定义实体类型与目录 |

## 目录约定

- \`wiki/summaries/\` —— 摘要页（\`type: summary\`）与回填的分析页（\`type: analysis\`）
- \`wiki/entities/<type>/\` —— 实体页，\`<type>\` 必须是下面 \`entity_types\` 中声明的键
- \`wiki/index.md\` —— 内容目录（每次收录 / 回填更新，提问先读它）
- \`wiki/log.md\` —— 时间线（只增不改，统一前缀可 grep）
- \`wiki/graph.json\` —— 知识图谱（节点 + 边），由页面与元数据自动重建

## 页面字段（frontmatter）

每张页面都必须带前置元数据：

\`\`\`yaml
---
type: summary | analysis | <entity_types 里的键>
title: 页面标题
date: YYYY-MM-DD
source:
  - <工作区里的源文件相对路径>
source_hash: <原始资料内容的 sha256>
---
\`\`\`

- \`source\` 是**已收录判定**的唯一依据：判断一份源文件是否已收录，只看页面元数据，
  不靠文件名猜测；源文件改名而内容不变时靠 \`source_hash\` 仍能识别。
- \`[[页面名]]\` 表示「被提及但可能还没有独立页的概念」，体检（lint）据此报告待补页面。
- 页面之间应互相引用（markdown 链接），使读者能沿链接浏览。

## 编辑约定

- 人可以直接编辑任意 wiki 页面；agent 的后续维护必须**在人的修改基础上继续**，
  不得回退人的改动。
- 收录发现矛盾时**标记而非覆盖**：两处论断都要保留，等人工确认。
`;

/** 内置默认 schema 对象（与 DEFAULT_SCHEMA_MD 的 frontmatter 保持一致） */
export function defaultWikiSchema(): WikiSchema {
  return {
    version: 1,
    entityTypes: {
      concept: { key: "concept", label: "概念", folder: "wiki/entities/concept/", fields: [] },
      paper: { key: "paper", label: "论文", folder: "wiki/entities/paper/", fields: [] },
      person: { key: "person", label: "人物", folder: "wiki/entities/person/", fields: [] },
      project: { key: "project", label: "项目", folder: "wiki/entities/project/", fields: [] },
    },
    pageRoles: { summary: "wiki/summaries/", analysis: "wiki/summaries/" },
    relations: ["对比", "支持", "引用"],
    source: "default",
    errors: [],
    raw: {},
  };
}

// —— 受控 YAML 子集解析 ——

interface RawLine {
  indent: number;
  text: string;
}

function toLines(block: string): RawLine[] {
  const out: RawLine[] = [];
  for (const raw of block.split(/\r?\n/)) {
    const expanded = raw.replace(/\t/g, "  ");
    const trimmed = expanded.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      out.push({ indent: 0, text: "" });
      continue;
    }
    out.push({ indent: expanded.length - expanded.trimStart().length, text: trimmed });
  }
  return out;
}

function nextNonEmpty(lines: RawLine[], from: number): number {
  let i = from;
  while (i < lines.length && lines[i].text === "") i += 1;
  return i < lines.length ? i : -1;
}

function topLevelColon(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function parseScalar(value: string): unknown {
  const t = value.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  if (/^-?\d+$/.test(t)) return Number(t);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  return t;
}

function parseFlowValue(input: string): unknown {
  const s = input.trim();
  if (s.startsWith("{") && s.endsWith("}")) {
    const map: Record<string, unknown> = {};
    for (const part of splitTopLevel(s.slice(1, -1), ",")) {
      const p = part.trim();
      if (p === "") continue;
      const colon = topLevelColon(p);
      if (colon === -1) {
        map[p] = "";
        continue;
      }
      map[p.slice(0, colon).trim()] = parseFlowValue(p.slice(colon + 1));
    }
    return map;
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return splitTopLevel(inner, ",").map((x) => parseFlowValue(x)).filter((x) => x !== "");
  }
  return parseScalar(s);
}

function parseNode(lines: RawLine[], start: number, indent: number): [unknown, number] {
  let i = nextNonEmpty(lines, start);
  if (i === -1) return [{}, lines.length];

  if (lines[i].indent === indent && lines[i].text.startsWith("- ")) {
    const arr: unknown[] = [];
    while (i < lines.length) {
      if (lines[i].text === "") {
        i += 1;
        continue;
      }
      if (lines[i].indent !== indent || !lines[i].text.startsWith("- ")) break;
      const rest = lines[i].text.slice(2).trim();
      i += 1;
      if (rest === "") {
        const n = nextNonEmpty(lines, i);
        if (n !== -1 && lines[n].indent > indent) {
          const [child, ni] = parseNode(lines, i, lines[n].indent);
          arr.push(child);
          i = ni;
        } else {
          arr.push("");
        }
      } else {
        arr.push(parseFlowValue(rest));
      }
    }
    return [arr, i];
  }

  const map: Record<string, unknown> = {};
  while (i < lines.length) {
    const line = lines[i];
    if (line.text === "") {
      i += 1;
      continue;
    }
    if (line.indent < indent) break;
    if (line.indent > indent) {
      i += 1;
      continue;
    }
    if (line.text.startsWith("- ")) break;
    const colon = topLevelColon(line.text);
    if (colon === -1) {
      i += 1;
      continue;
    }
    const key = line.text.slice(0, colon).trim();
    const rest = line.text.slice(colon + 1).trim();
    i += 1;
    if (rest !== "") {
      map[key] = parseFlowValue(rest);
      continue;
    }
    const n = nextNonEmpty(lines, i);
    if (n !== -1 && lines[n].indent > indent) {
      const [child, ni] = parseNode(lines, i, lines[n].indent);
      map[key] = child;
      i = ni;
    } else {
      map[key] = "";
    }
  }
  return [map, i];
}

/** 解析受控 YAML 子集为对象 */
export function parseYamlSubset(block: string): Record<string, unknown> {
  const lines = toLines(block);
  const [value] = parseNode(lines, 0, 0);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.length > 0);
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

function parseFields(value: unknown): WikiFieldDef[] {
  if (!Array.isArray(value)) return [];
  const fields: WikiFieldDef[] = [];
  for (const item of value) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name : "";
      const type = typeof rec.type === "string" ? rec.type : "string";
      if (name.length > 0) fields.push({ name, type });
    }
  }
  return fields;
}

/** 解析 SCHEMA.md 全文 → WikiSchema（解析失败回落默认，errors 里说明） */
export function parseWikiSchema(content: string): WikiSchema {
  const block = frontmatterBlock(content);
  if (block === null) {
    const fallback = defaultWikiSchema();
    fallback.errors.push("SCHEMA.md 缺少 frontmatter，本次使用内置默认规范");
    return fallback;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYamlSubset(block);
  } catch (err) {
    const fallback = defaultWikiSchema();
    fallback.errors.push(`SCHEMA.md frontmatter 解析失败，本次使用内置默认规范：${(err as Error).message}`);
    return fallback;
  }

  const base = defaultWikiSchema();
  const errors: string[] = [];
  const entityTypes: Record<string, WikiEntityType> = {};
  const rawEntityTypes = parsed.entity_types;
  if (rawEntityTypes && typeof rawEntityTypes === "object" && !Array.isArray(rawEntityTypes)) {
    for (const [key, value] of Object.entries(rawEntityTypes as Record<string, unknown>)) {
      const def = value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
      const folderRaw = typeof def.folder === "string" && def.folder.length > 0
        ? def.folder
        : `wiki/entities/${key}/`;
      entityTypes[key] = {
        key,
        label: typeof def.label === "string" && def.label.length > 0 ? def.label : key,
        folder: normalizeFolder(folderRaw),
        parent: typeof def.parent === "string" && def.parent.length > 0 ? def.parent : undefined,
        fields: parseFields(def.fields),
      };
    }
  }
  if (Object.keys(entityTypes).length === 0) {
    errors.push("SCHEMA.md 未声明任何 entity_types，使用内置默认实体类型");
    Object.assign(entityTypes, base.entityTypes);
  }

  const pageRoles: Record<string, string> = {};
  const rawRoles = parsed.page_roles;
  if (rawRoles && typeof rawRoles === "object" && !Array.isArray(rawRoles)) {
    for (const [key, value] of Object.entries(rawRoles as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) pageRoles[key] = normalizeFolder(value);
    }
  }
  if (Object.keys(pageRoles).length === 0) Object.assign(pageRoles, base.pageRoles);

  const relations = asStringList(parsed.relations);
  const version = typeof parsed.version === "number" ? parsed.version : base.version;

  return {
    version,
    entityTypes,
    pageRoles,
    relations: relations.length > 0 ? relations : base.relations,
    source: "file",
    errors,
    raw: parsed,
  };
}

/** 读取并解析工作区的 SCHEMA.md；文件不存在 → 默认规范（不报错） */
export async function loadWikiSchema(workspaceDir: string): Promise<WikiSchema> {
  let content: string;
  try {
    content = await fs.readFile(wikiSchemaPath(workspaceDir), "utf8");
  } catch {
    const fallback = defaultWikiSchema();
    fallback.errors.push("wiki/SCHEMA.md 不存在，本次使用内置默认规范");
    return fallback;
  }
  return parseWikiSchema(content);
}

/** 某实体类型对应的目录；未声明则 null（用于拒绝未定义类型） */
export function entityFolder(schema: WikiSchema, type: string): string | null {
  const def = schema.entityTypes[type];
  if (def) return def.folder;
  return null;
}

/** 某页面角色（summary / analysis / 自定义）对应的目录 */
export function roleFolder(schema: WikiSchema, role: string): string | null {
  return schema.pageRoles[role] ?? null;
}

export interface PlacementCheck {
  ok: boolean;
  type: string | null;
  folder: string | null;
  reason?: string;
}

/**
 * 用 SCHEMA 校验页面归属（tasks 11.10）：
 * - 给了 `type`：该类型必须在 SCHEMA 中声明，且页面路径必须落在它的目录里；
 * - 没给 `type`：从路径反推类型，必须落在某个已声明目录里。
 */
export function validatePageOwnership(
  schema: WikiSchema,
  pageRel: string,
  type?: string | null,
): PlacementCheck {
  const rel = normalizeRel(pageRel);
  if (type && type.length > 0) {
    const folder = entityFolder(schema, type) ?? roleFolder(schema, type);
    if (!folder) {
      return {
        ok: false,
        type,
        folder: null,
        reason: `SCHEMA.md 未声明类型「${type}」，无法确定它的目录（可在 SCHEMA.md 的 entity_types / page_roles 里补充）`,
      };
    }
    if (!isInsideFolder(rel, folder)) {
      return {
        ok: false,
        type,
        folder,
        reason: `页面 ${rel} 不属于类型「${type}」的目录 ${folder}`,
      };
    }
    return { ok: true, type, folder };
  }

  for (const [key, def] of Object.entries(schema.entityTypes)) {
    if (isInsideFolder(rel, def.folder)) return { ok: true, type: key, folder: def.folder };
  }
  for (const [role, folder] of Object.entries(schema.pageRoles)) {
    if (isInsideFolder(rel, folder)) return { ok: true, type: role, folder };
  }
  return {
    ok: false,
    type: null,
    folder: null,
    reason: `页面 ${rel} 不在 SCHEMA.md 约定的任何目录下（见 SCHEMA.md 的 entity_types / page_roles）`,
  };
}