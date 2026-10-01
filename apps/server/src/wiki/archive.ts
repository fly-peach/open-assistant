/**
 * 答案回填（tasks 11.16）。
 *
 * 「好的回答应该被归档回 wiki 成为新页」—— 探索与收录一样能复利。
 *
 * 回填**不无提示覆盖**：
 * - 目标页不存在 → 新建；
 * - 目标页已存在且正文一致 → 不动（`archived:false, reason:"unchanged"`）；
 * - 目标页已存在但正文不同 → 默认新建一个**可区分命名**的页面（`-2`、`-3`…），
 *   只有显式传 `mode:"update"` 才在原页上更新，并在返回值里标记 `updated:true`。
 */
import path from "node:path";
import fs from "node:fs/promises";

import { writeTextAtomic } from "../agents/json-file.js";
import { parseFrontmatter, renderFrontmatter, upsertFrontmatter } from "./frontmatter.js";
import { appendWikiLog, todayIso, upsertIndexEntry } from "./index-log.js";
import {
  ANALYSIS_TYPE,
  SUMMARY_TYPE,
  normalizeRel,
  slugify,
  toWorkspaceRel,
} from "./paths.js";
import { loadWikiSchema, roleFolder } from "./schema.js";
import { listWikiPages } from "./pages.js";
import { ensureWikiSkeleton } from "./skeleton.js";

export interface ArchiveAnswerInput {
  title: string;
  /** 待归档的正文（分析 / 对比 / 新关联） */
  content: string;
  /** 页面角色：analysis（默认）/ summary / SCHEMA 里自定义的 page_roles 键 */
  kind?: string;
  /** 引用的原始资料（写进 `source:`） */
  sources?: string[];
  date?: string;
  /** 相关页面 wikilink（`[[页面名]]`） */
  links?: string[];
  /** new（默认，冲突时另起新页）/ update（显式更新既有页） */
  mode?: "new" | "update";
}

export interface ArchiveResult {
  archived: boolean;
  reason?: "unchanged";
  /** 工作区相对路径 */
  path: string;
  created: boolean;
  updated: boolean;
  indexUpdated: boolean;
  logLine: string | null;
}

function sectionForKind(kind: string): "摘要" | "实体" | "分析" {
  if (kind === ANALYSIS_TYPE) return "分析";
  if (kind === SUMMARY_TYPE) return "摘要";
  return "实体";
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

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

/** 归档一次分析，返回产物路径与是否新建 / 更新 */
export async function archiveAnswer(
  workspaceDir: string,
  input: ArchiveAnswerInput,
): Promise<ArchiveResult> {
  const root = path.resolve(workspaceDir);
  await ensureWikiSkeleton(root);
  const schema = await loadWikiSchema(root);

  const kind = input.kind && input.kind.length > 0 ? input.kind : ANALYSIS_TYPE;
  const folder = roleFolder(schema, kind) ?? `${path.posix.join("wiki", "summaries")}/`;
  const date = input.date ?? todayIso();
  const slug = slugify(input.title);
  const baseRel = normalizeRel(`${folder}${slug}.md`);
  const bodyText = input.content.replace(/\s+$/, "");
  const links = input.links && input.links.length > 0
    ? `\n## 相关\n\n${input.links.map((l) => `- [[${l}]]`).join("\n")}\n`
    : "";
  const fullBody = links.length > 0 ? `${bodyText}\n${links}` : bodyText;

  // 同主题（同 type + 同 title）的页面：正文完全一致 → 不动（回填幂等，不是覆盖）
  const siblings = (await listWikiPages(root)).filter((p) => p.type === kind && p.title === input.title);
  const identical = siblings.find(
    (p) => parseFrontmatter(p.content).body.replace(/\s+$/, "").trim() === bodyText.trim(),
  );
  if (identical) {
    return {
      archived: false,
      reason: "unchanged",
      path: identical.path,
      created: false,
      updated: false,
      indexUpdated: false,
      logLine: null,
    };
  }

  const existing = await pathExists(path.join(root, baseRel));
  let targetRel = baseRel;
  let created = false;
  let updated = false;

  if (existing) {
    const current = await fs.readFile(path.join(root, baseRel), "utf8");
    if (input.mode === "update") {
      const withMeta = upsertFrontmatter(current, {
        source: (input.sources ?? []).map((s) => normalizeRel(toWorkspaceRel(root, s))),
        date,
      });
      const fmUpdated = parseFrontmatter(withMeta);
      await writeTextAtomic(path.join(root, baseRel), renderFrontmatter(fmUpdated.data) + `\n${fullBody}\n`);
      updated = true;
    } else {
      targetRel = await uniquePagePath(root, baseRel);
      created = true;
    }
  } else {
    created = true;
  }

  if (created) {
    await writeTextAtomic(
      path.join(root, targetRel),
      renderFrontmatter({
        type: kind,
        title: input.title,
        date,
        source: (input.sources ?? []).map((s) => normalizeRel(toWorkspaceRel(root, s))),
      }) + `\n${fullBody}\n`,
    );
  }

  await upsertIndexEntry(root, {
    section: sectionForKind(kind),
    title: input.title,
    link: targetRel,
    summary: "回填的分析页",
  });
  const logLine = await appendWikiLog(root, {
    date,
    action: "archive",
    title: input.title,
    details: `归档为 \`${targetRel}\`${updated ? "（更新既有页）" : ""}`,
  });

  return {
    archived: true,
    path: targetRel,
    created,
    updated,
    indexUpdated: true,
    logLine,
  };
}