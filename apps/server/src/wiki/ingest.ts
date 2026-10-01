/**
 * 收录（ingest）流程（tasks 11.13 / 11.14 / 11.15）。
 *
 * 一次收录**不只索引原始资料，而是把它整合进 wiki**：
 *   1. 写出摘要页（带 `source:` / `source_hash:` 元数据）
 *   2. 更新受影响的实体页（新论断；与旧论断冲突时**标记而非覆盖**）
 *   3. 更新 index.md（内容目录）
 *   4. 追加 log.md（统一前缀时间线）
 *
 * 「已收录判定以页面元数据 `source:` 为准」：`findIngestedSource` 命中时
 * **不重复收录**并直接返回；原始资料改名而内容不变时靠 `source_hash` 仍能识别。
 */
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

import { writeTextAtomic } from "../agents/json-file.js";
import { parseFrontmatter, renderFrontmatter, upsertFrontmatter } from "./frontmatter.js";
import { appendWikiLog, todayIso, upsertIndexEntry } from "./index-log.js";
import {
  SUMMARY_TYPE,
  SUMMARIES_DIR,
  WIKI_DIR,
  normalizeRel,
  slugify,
  toWorkspaceRel,
} from "./paths.js";
import { entityFolder, loadWikiSchema, validatePageOwnership } from "./schema.js";
import { findIngestedSource, readWikiPage } from "./pages.js";
import { ensureWikiSkeleton } from "./skeleton.js";

export interface IngestClaimInput {
  /** 论断主题（同一主题下不同措辞会触发矛盾标记） */
  topic: string;
  /** 论断正文 */
  statement: string;
}

export interface IngestEntityInput {
  /** SCHEMA.md 里声明的实体类型键（concept / paper / person / project …） */
  type: string;
  /** 文件名（缺省用 title） */
  slug?: string;
  title: string;
  claims?: IngestClaimInput[];
  /** 相关页面 wikilink（`[[页面名]]`） */
  links?: string[];
}

export interface IngestInput {
  /** 原始资料路径（绝对路径或工作区相对路径，必须落在 wiki/raw/ 下） */
  rawPath: string;
  title?: string;
  /** 一句话摘要（进 index） */
  summary?: string;
  /** 摘要页正文（缺省由原始资料自动提炼） */
  body?: string;
  entities?: IngestEntityInput[];
  date?: string;
}

export interface IngestResult {
  ingested: boolean;
  reason?: "raw_missing" | "raw_outside" | "empty" | "already_ingested";
  /** 归一后的原始资料路径（`wiki/raw/...`） */
  source: string;
  sourceHash: string;
  /** 本次写出的摘要页（工作区相对路径） */
  summaryPage: string | null;
  /** 本次更新的实体页 */
  entityPages: string[];
  /** 本次更新过的 index 条目链接 */
  indexUpdated: string[];
  logLine: string | null;
  /** 已收录命中的既有页面（reason = already_ingested 时） */
  existingPages: string[];
  warnings: string[];
}

export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/** 从正文提炼标题：优先第一个一级/二级标题，否则文件名 */
export function deriveTitle(content: string, sourceRel: string): string {
  for (const line of content.split(/\r?\n/)) {
    const m = /^#{1,2}\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return path.basename(sourceRel).replace(/\.(md|txt|markdown)$/i, "");
}

/** 从正文提炼一句话摘要 */
export function deriveSummary(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#") || t.startsWith("---") || t.startsWith(">")) continue;
    const clean = t.replace(/^[-*+]\s+/, "").replace(/\s+/g, " ");
    if (clean.length === 0) continue;
    return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean;
  }
  return "";
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 若目标页已存在则追加 `-2`、`-3` …（绝不覆盖既有页面） */
async function uniquePagePath(root: string, baseRel: string): Promise<string> {
  const dir = path.posix.dirname(baseRel);
  const ext = path.posix.extname(baseRel);
  const stem = path.posix.basename(baseRel, ext);
  let candidate = baseRel;
  let index = 1;
  while (await pathExists(path.join(root, candidate))) {
    index += 1;
    candidate = `${dir}/${stem}-${index}${ext}`;
  }
  return candidate;
}

// —— 实体页与论断维护 ——

const CONTRADICTION_HEAD = "> [!CONTRADICTION]";

function normalizeClaim(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[。.；;]+$/, "");
}

interface TopicSection {
  headerIdx: number;
  end: number;
  claims: string[];
}

function findTopicSection(lines: string[], topic: string): TopicSection | null {
  const header = `### ${topic}`;
  const headerIdx = lines.findIndex((line) => line.trim() === header);
  if (headerIdx === -1) return null;
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (/^#{2,3}\s/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  const claims: string[] = [];
  for (let i = headerIdx + 1; i < end; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith("- ")) claims.push(line.slice(2).trim());
  }
  return { headerIdx, end, claims };
}

export interface RecordClaimInput {
  topic: string;
  statement: string;
  /** 来源（原始资料路径） */
  source?: string;
  date?: string;
}

export interface RecordClaimResult {
  status: "added" | "contradiction" | "unchanged";
  /** status = contradiction 时，被保留的旧论断 */
  previous?: string;
}

/**
 * 向页面记录一条论断。
 *
 * - 同主题下没有相同措辞的断言：追加一条 bullet；
 * - 同主题下已有**不同**措辞的断言：追加一个 `[!CONTRADICTION]` 块，
 *   **旧断言原样保留**（MUST NOT 静默覆盖）。
 */
export async function recordClaim(
  workspaceDir: string,
  pageRel: string,
  claim: RecordClaimInput,
): Promise<RecordClaimResult> {
  const root = path.resolve(workspaceDir);
  const rel = normalizeRel(pageRel);
  const full = path.join(root, rel);
  const content = await fs.readFile(full, "utf8");
  const fm = parseFrontmatter(content);
  const lines = fm.body.replace(/^\n+/, "").split(/\r?\n/);
  const date = claim.date ?? todayIso();
  const source = claim.source ?? "";
  const attribution = source.length > 0 ? `（来源：${source}，${date}）` : `（${date}）`;

  const section = findTopicSection(lines, claim.topic);
  const next = normalizeClaim(claim.statement);

  if (!section) {
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
    lines.push("", `### ${claim.topic}`, "", `- ${claim.statement}${attribution}`, "");
    await writeTextAtomic(full, renderFrontmatter(fm.data) + lines.join("\n"));
    return { status: "added" };
  }

  const matched = section.claims.find((c) => normalizeClaim(c.replace(/（来源：[^）]*）$/, "")) === next);
  if (matched) return { status: "unchanged" };

  const previous = section.claims[0]?.replace(/（来源：[^）]*）$/, "").trim();
  if (!previous) {
    // 该主题下还没有任何断言（只有矛盾块）→ 直接新增
    lines.splice(section.end, 0, "", `- ${claim.statement}${attribution}`);
    await writeTextAtomic(full, renderFrontmatter(fm.data) + lines.join("\n"));
    return { status: "added" };
  }

  const block = [
    "",
    `${CONTRADICTION_HEAD} 待确认矛盾：${claim.topic}`,
    `> - 已有论断（保留）：${previous}`,
    `> - 新资料论断${source.length > 0 ? `（${source}）` : ""}：${claim.statement.trim()}`,
    `> 两处论断均已保留，需人工确认取舍（见 wiki/log.md 与 SCHEMA.md 的「收录约定」）。`,
    "",
  ];
  lines.splice(section.end, 0, ...block);
  await writeTextAtomic(full, renderFrontmatter(fm.data) + lines.join("\n"));
  return { status: "contradiction", previous };
}

export interface UpsertEntityPageResult {
  path: string;
  created: boolean;
  claims: { topic: string; status: RecordClaimResult["status"] }[];
}

/**
 * 新建 / 更新实体页：合并 `source:` 元数据，记录论断（冲突则标记）。
 * 已存在的页面**不会被覆盖**，只在原内容上追加。
 */
export async function upsertEntityPage(
  workspaceDir: string,
  entity: IngestEntityInput & { source?: string; date?: string },
): Promise<UpsertEntityPageResult> {
  const root = path.resolve(workspaceDir);
  const schema = await loadWikiSchema(root);
  const folder = entityFolder(schema, entity.type);
  if (!folder) {
    throw new Error(
      `SCHEMA.md 未声明实体类型「${entity.type}」，无法确定目录（可在 SCHEMA.md 的 entity_types 中补充）`,
    );
  }
  const pageRel = `${folder}${slugify(entity.slug && entity.slug.length > 0 ? entity.slug : entity.title)}.md`;
  const placement = validatePageOwnership(schema, pageRel, entity.type);
  if (!placement.ok) throw new Error(placement.reason ?? `页面 ${pageRel} 归属校验失败`);

  const full = path.join(root, pageRel);
  const exists = await pathExists(full);
  const date = entity.date ?? todayIso();
  if (!exists) {
    const header = renderFrontmatter({
      type: entity.type,
      title: entity.title,
      date,
      source: entity.source ? [entity.source] : [],
    });
    const links = entity.links && entity.links.length > 0
      ? `\n## 相关\n\n${entity.links.map((l) => `- [[${l}]]`).join("\n")}\n`
      : "";
    await writeTextAtomic(full, `${header}\n# ${entity.title}\n${links}`);
  } else {
    const current = await fs.readFile(full, "utf8");
    const withSource = entity.source
      ? upsertFrontmatter(current, { source: [entity.source] })
      : current;
    if (withSource !== current) await writeTextAtomic(full, withSource);
  }

  const claims: UpsertEntityPageResult["claims"] = [];
  for (const claim of entity.claims ?? []) {
    const result = await recordClaim(root, pageRel, {
      topic: claim.topic,
      statement: claim.statement,
      source: entity.source,
      date,
    });
    claims.push({ topic: claim.topic, status: result.status });
  }
  return { path: pageRel, created: !exists, claims };
}

// —— 收录主流程 ——

const emptyResult = (
  source: string,
  reason: IngestResult["reason"],
  extra: Partial<IngestResult> = {},
): IngestResult => ({
  ingested: false,
  reason,
  source,
  sourceHash: "",
  summaryPage: null,
  entityPages: [],
  indexUpdated: [],
  logLine: null,
  existingPages: [],
  warnings: [],
  ...extra,
});

/**
 * 收录一份 `wiki/raw/` 下的原始资料。幂等：已收录（元数据命中）时直接返回。
 */
export async function ingestRawDocument(
  workspaceDir: string,
  input: IngestInput,
): Promise<IngestResult> {
  const root = path.resolve(workspaceDir);
  await ensureWikiSkeleton(root);

  const source = normalizeRel(toWorkspaceRel(root, input.rawPath));
  // 源层 = 工作区里用户自己的文件（不另设 raw/ 目录）：只要不在 wiki/ 与 .open-assistant/ 之内即可。
  if (!source || source.startsWith(`${WIKI_DIR}/`) || source.startsWith(".open-assistant/")) {
    return emptyResult(source, "raw_outside", {
      warnings: [`源文件必须位于工作区内、且不在 ${WIKI_DIR}/ 与 .open-assistant/ 之内（收到：${source || "(空)"}）`],
    });
  }

  let content: string;
  try {
    content = await fs.readFile(path.join(root, source), "utf8");
  } catch {
    return emptyResult(source, "raw_missing", { warnings: [`原始资料不存在：${source}`] });
  }
  if (content.trim().length === 0) return emptyResult(source, "empty", { warnings: [`原始资料是空的：${source}`] });

  const hash = sha256(content);
  const already = await findIngestedSource(root, { source, hash });
  if (already.found) {
    return emptyResult(source, "already_ingested", {
      sourceHash: hash,
      existingPages: already.pages,
    });
  }

  const date = input.date ?? todayIso();
  const title = input.title?.trim() || deriveTitle(content, source);
  const summary = input.summary?.trim() || deriveSummary(content);
  const warnings: string[] = [];

  // 1) 摘要页
  const summaryRel = await uniquePagePath(root, `${WIKI_DIR}/${SUMMARIES_DIR}/${slugify(title)}.md`);
  const summaryBody = input.body?.trim()
    ? input.body.trim()
    : [
        `# ${title}`,
        "",
        summary.length > 0 ? summary : `（收录自 ${source}，暂无自动摘要）`,
        "",
        "## 来源",
        "",
        `- \`${source}\``,
      ].join("\n");
  await writeTextAtomic(
    path.join(root, summaryRel),
    renderFrontmatter({
      type: SUMMARY_TYPE,
      title,
      date,
      source: [source],
      source_hash: hash,
    }) + `\n${summaryBody}\n`,
  );

  // 2) 实体页（类型由 SCHEMA.md 校验）
  const entityPages: string[] = [];
  for (const entity of input.entities ?? []) {
    try {
      const result = await upsertEntityPage(root, { ...entity, source, date });
      entityPages.push(result.path);
      for (const claim of result.claims) {
        if (claim.status === "contradiction") {
          warnings.push(`论断冲突：${result.path} 的「${claim.topic}」保留了两处论断，待人工确认`);
        }
      }
    } catch (err) {
      warnings.push((err as Error).message);
    }
  }

  // 3) index.md
  const indexUpdated: string[] = [];
  await upsertIndexEntry(root, {
    section: "摘要",
    title,
    link: summaryRel,
    summary: summary.length > 0 ? summary : `收录自 ${source}`,
  });
  indexUpdated.push(summaryRel);
  for (const entityRel of entityPages) {
    const page = await readWikiPage(root, entityRel);
    await upsertIndexEntry(root, {
      section: "实体",
      title: page?.title ?? path.posix.basename(entityRel, ".md"),
      link: entityRel,
      summary: `实体页（${page?.type ?? "entity"}）`,
    });
    indexUpdated.push(entityRel);
  }

  // 4) log.md
  const touched = [summaryRel, ...entityPages];
  const logLine = await appendWikiLog(root, {
    date,
    action: "ingest",
    title,
    details: [
      `原始资料：\`${source}\``,
      `触及 ${touched.length} 个页面：`,
      ...touched.map((p) => `- \`${p}\``),
    ].join("\n"),
  });

  return {
    ingested: true,
    source,
    sourceHash: hash,
    summaryPage: summaryRel,
    entityPages,
    indexUpdated,
    logLine,
    existingPages: [],
    warnings,
  };
}
