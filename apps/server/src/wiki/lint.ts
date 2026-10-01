/**
 * 体检（lint）（tasks 11.17）。
 *
 * 检查项（对齐 spec project-wiki / 体检检查项）：
 * - 页面之间的矛盾（`[!CONTRADICTION]` 标记）
 * - 被新资料取代的陈旧论断（页面日期早于其引用的原始资料修改时间）
 * - 无入链的孤立页（既无其他页面引用、也未列入 index.md）
 * - 被提及但没有独立页的重要概念（`[[页面名]]` 无对应页）
 * - 缺失的交叉引用（markdown 链接指向不存在的页面）
 *
 * **只报告不改内容**：本文件全部是只读操作，绝不写任何文件。
 * 修复必须作为显式动作发生（另有调用方决定是否根据报告去改）。
 */
import path from "node:path";
import fs from "node:fs/promises";

import {
  INDEX_FILE,
  WIKI_DIR,
  normalizeRel,
} from "./paths.js";
import { indexLinkedTargets } from "./index-log.js";
import { readWikiText } from "./skeleton.js";
import { listSourceFiles, listWikiPages, type WikiPageInfo } from "./pages.js";

export interface LintOrphan {
  path: string;
  title: string;
  hint: string;
}
export interface LintMissingPage {
  name: string;
  mentionedIn: string[];
  hint: string;
}
export interface LintMissingCrossRef {
  from: string;
  target: string;
  hint: string;
}
export interface LintContradiction {
  path: string;
  topic: string;
  hint: string;
}
export interface LintStaleClaim {
  path: string;
  source: string;
  pageDate: string;
  sourceModified: string;
  hint: string;
}

export interface WikiLintReport {
  generatedAt: string;
  wikiExists: boolean;
  pages: number;
  rawDocuments: number;
  orphans: LintOrphan[];
  missingPages: LintMissingPage[];
  missingCrossRefs: LintMissingCrossRef[];
  contradictions: LintContradiction[];
  staleClaims: LintStaleClaim[];
  /** 可直接执行的改进项（人 / agent 都能照着做） */
  actions: string[];
}

const WIKILINK_RE = /\[\[([^\][|]+?)(?:\|[^\]]+)?\]\]/g;
const MDLINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;

function isExternal(target: string): boolean {
  return /^(https?:|mailto:|#)/i.test(target) || target.startsWith("//");
}

/** 把页面里的链接目标解析成工作区相对路径 */
function resolveLink(pageRel: string | null, target: string): string {
  const clean = target.replace(/#.*$/, "").trim();
  if (clean === "") return "";
  if (clean.startsWith(`${WIKI_DIR}/`)) return normalizeRel(clean);
  const baseDir = pageRel ? path.posix.dirname(pageRel) : WIKI_DIR;
  return normalizeRel(path.posix.normalize(path.posix.join(baseDir, clean)));
}

const baseName = (rel: string): string => path.posix.basename(rel, ".md");

async function statDate(full: string): Promise<string | null> {
  try {
    const st = await fs.stat(full);
    return st.mtime.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/** 执行一次体检（纯只读，不修改任何 wiki 内容） */
export async function lintWiki(workspaceDir: string): Promise<WikiLintReport> {
  const root = path.resolve(workspaceDir);
  const wikiAbs = path.join(root, WIKI_DIR);
  let wikiExists = false;
  try {
    wikiExists = (await fs.stat(wikiAbs)).isDirectory();
  } catch {
    wikiExists = false;
  }

  const report: WikiLintReport = {
    generatedAt: new Date().toISOString(),
    wikiExists,
    pages: 0,
    rawDocuments: 0,
    orphans: [],
    missingPages: [],
    missingCrossRefs: [],
    contradictions: [],
    staleClaims: [],
    actions: [],
  };

  if (!wikiExists) {
    report.actions.push("wiki 目录不存在（视为空 wiki）：先运行工作区初始化，或把一份资料放进工作区再收录。");
    return report;
  }

  const pages = await listWikiPages(root);
  const rawDocuments = await listSourceFiles(root);
  report.pages = pages.length;
  report.rawDocuments = rawDocuments.length;

  const pageSet = new Set(pages.map((p) => p.path));
  const byTitle = new Map<string, string>();
  const byBase = new Map<string, string>();
  for (const page of pages) {
    byTitle.set(page.title.trim(), page.path);
    byBase.set(baseName(page.path), page.path);
  }

  // index.md 里列出的链接（相对 wiki/ 目录）
  const indexContent = (await readWikiText(root, `${WIKI_DIR}/${INDEX_FILE}`)) ?? "";
  const indexTargets = new Set(indexLinkedTargets(indexContent).map((t) => resolveLink(`${WIKI_DIR}/${INDEX_FILE}`, t)));

  const inbound = new Map<string, number>();
  for (const page of pages) inbound.set(page.path, 0);

  const missingMap = new Map<string, Set<string>>();

  for (const page of pages) {
    // 交叉引用 / 缺页
    for (const m of page.content.matchAll(WIKILINK_RE)) {
      const name = m[1].trim();
      if (name === "") continue;
      const target = byTitle.get(name) ?? byBase.get(name);
      if (!target) {
        const set = missingMap.get(name) ?? new Set<string>();
        set.add(page.path);
        missingMap.set(name, set);
      } else if (target !== page.path) {
        inbound.set(target, (inbound.get(target) ?? 0) + 1);
      }
    }
    for (const m of page.content.matchAll(MDLINK_RE)) {
      const raw = m[1];
      if (isExternal(raw) || !raw.toLowerCase().includes(".md")) continue;
      const target = resolveLink(page.path, raw);
      if (target === "" || target === page.path) continue;
      if (!pageSet.has(target)) {
        report.missingCrossRefs.push({
          from: page.path,
          target,
          hint: `${page.path} 指向 ${target}，但该页面不存在 → 新建该页，或把链接改成既有页面。`,
        });
      } else {
        inbound.set(target, (inbound.get(target) ?? 0) + 1);
      }
    }
    // 矛盾标记
    for (const line of page.content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("> [!CONTRADICTION]")) continue;
      const topic = trimmed.replace(/^>\s*\[!CONTRADICTION\]\s*/, "").replace(/^待确认矛盾[:：]\s*/, "").trim()
        || baseName(page.path);
      report.contradictions.push({
        path: page.path,
        topic,
        hint: `待确认矛盾：${page.path} 的「${topic}」有两处未确认论断 → 人工确认后删掉其中一处，或补一段结论说明取舍。`,
      });
    }
    // 陈旧论断
    const pageDate = typeof page.frontmatter.data["date"] === "string" ? (page.frontmatter.data["date"] as string) : "";
    if (pageDate.length >= 10) {
      for (const source of page.sources) {
        const sourceRel = normalizeRel(source);
        const sourceModified = await statDate(path.join(root, sourceRel));
        if (sourceModified && sourceModified > pageDate) {
          report.staleClaims.push({
            path: page.path,
            source: sourceRel,
            pageDate,
            sourceModified,
            hint: `${page.path}（${pageDate}）引用的 ${sourceRel} 在 ${sourceModified} 被改动 → 重读原始资料并更新该页。`,
          });
        }
      }
    }
  }

  // 孤儿页
  for (const page of pages) {
    const linked = (inbound.get(page.path) ?? 0) > 0 || indexTargets.has(page.path);
    if (!linked) {
      report.orphans.push({
        path: page.path,
        title: page.title,
        hint: `${page.path} 既无其他页面引用，也未列入 index.md → 在 index.md 对应分区补一行链接，或从相关页面链到它。`,
      });
    }
  }

  for (const [name, mentionedIn] of [...missingMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    report.missingPages.push({
      name,
      mentionedIn: [...mentionedIn].sort(),
      hint: `待补页面：[[${name}]] 被提及但没有独立页（提及于 ${[...mentionedIn].sort().join("、")}）→ 在 wiki/entities/<type>/ 下新建该页。`,
    });
  }

  // 可执行项汇总
  for (const item of report.orphans) report.actions.push(item.hint);
  for (const item of report.missingPages) report.actions.push(item.hint);
  for (const item of report.missingCrossRefs) report.actions.push(item.hint);
  for (const item of report.contradictions) report.actions.push(item.hint);
  for (const item of report.staleClaims) report.actions.push(item.hint);
  if (report.actions.length === 0) {
    report.actions.push(`体检通过：${report.pages} 个页面、${report.rawDocuments} 份原始资料，未发现待补页面 / 待补引用 / 待确认矛盾。`);
  }

  return report;
}

/** 便于默认导出 */
export default lintWiki;

/** 供 lint 结果渲染成人类可读文本（不写文件） */
export function renderLintReport(report: WikiLintReport): string {
  const lines = [
    `# wiki 体检报告（${report.generatedAt}）`,
    "",
    `- 页面：${report.pages}`,
    `- 原始资料：${report.rawDocuments}`,
    `- 孤立页：${report.orphans.length}`,
    `- 待补页面：${report.missingPages.length}`,
    `- 缺失交叉引用：${report.missingCrossRefs.length}`,
    `- 待确认矛盾：${report.contradictions.length}`,
    `- 可能陈旧：${report.staleClaims.length}`,
    "",
    "## 可执行项",
    "",
    ...report.actions.map((a) => `- ${a}`),
  ];
  return lines.join("\n");
}

export type { WikiPageInfo };