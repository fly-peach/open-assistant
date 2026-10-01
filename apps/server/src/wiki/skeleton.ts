/**
 * wiki 骨架初始化（tasks 11.9）——幂等、只补缺、不覆盖同名文件。
 *
 * 目录骨架（对齐 spec project-wiki / 目录骨架）：
 *   wiki/SCHEMA.md  wiki/index.md  wiki/log.md
 *   wiki/raw/  wiki/summaries/  wiki/entities/<type>/
 *
 * 不覆盖策略：文件用 `wx` 旗标（内核级「不存在才创建」），目录用
 * `mkdir {recursive:true}`（已存在不报错、不动内容）。因此工作区里
 * 已有的任意同名文件 / 目录都一个字节不变。
 */
import path from "node:path";
import fs from "node:fs/promises";

import { DEFAULT_SCHEMA_MD, loadWikiSchema } from "./schema.js";
import {
  ENTITIES_DIR,
  INDEX_FILE,
  LOG_FILE,
  SCHEMA_FILE,
  SUMMARIES_DIR,
  WIKI_DIR,
} from "./paths.js";

/** index.md 初始内容：四个固定分区，供增量维护插入条目 */
export const DEFAULT_INDEX_MD = `# 项目 Wiki 内容索引

> 本文件由 agent 增量维护：每次收录或回填都会更新。
> 提问时先读这里定位相关页面，再进入具体页面（不要直接扫描全部页面）。

## 摘要

## 实体

## 分析

## 项目记忆
`;

/** log.md 初始内容：统一前缀，可 grep */
export const DEFAULT_LOG_MD = `# 项目 Wiki 时间线

> 只增不改。每条以 \`## [YYYY-MM-DD] <动作> | <标题>\` 开头，
> 可用 \`grep "^## \\[" log.md | tail -5\` 取出最近 5 条。

`;

export interface WikiSkeletonResult {
  /** 工作区相对路径（POSIX，如 `wiki/raw`），本次新建的目录 */
  dirs: string[];
  /** 工作区相对路径，本次新写入的文件 */
  created: string[];
  /** 工作区相对路径，已存在因而跳过的文件（内容一个字节未动） */
  skipped: string[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(root: string, rel: string, dirs: string[]): Promise<void> {
  const full = path.join(root, rel);
  const existed = await pathExists(full);
  await fs.mkdir(full, { recursive: true });
  if (!existed) dirs.push(rel);
}

async function ensureFile(root: string, rel: string, content: string): Promise<"created" | "skipped"> {
  const full = path.join(root, rel);
  try {
    await fs.writeFile(full, content, { encoding: "utf8", flag: "wx" });
    return "created";
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      const st = await fs.stat(full).catch(() => null);
      if (st?.isFile()) return "skipped";
      // 同名目录 / 符号链接等无法当文件用 → 交给调用方作为错误浮现
      throw err;
    }
    throw err;
  }
}

/**
 * 幂等地补齐 wiki 骨架。工作区尚无 wiki 时创建；已有 wiki 时只补缺失项。
 *
 * 实体目录按 `SCHEMA.md` 的声明创建：已存在的 SCHEMA（可能被人改过）优先，
 * 因此新增自定义实体类型后再次初始化会自动补出它的目录。
 */
export async function ensureWikiSkeleton(workspaceDir: string): Promise<WikiSkeletonResult> {
  const root = path.resolve(workspaceDir);
  const dirs: string[] = [];
  const created: string[] = [];
  const skipped: string[] = [];

  await ensureDir(root, WIKI_DIR, dirs);
  const schemaOutcome = await ensureFile(root, `${WIKI_DIR}/${SCHEMA_FILE}`, DEFAULT_SCHEMA_MD);
  (schemaOutcome === "created" ? created : skipped).push(`${WIKI_DIR}/${SCHEMA_FILE}`);

  await ensureDir(root, `${WIKI_DIR}/${SUMMARIES_DIR}`, dirs);
  await ensureDir(root, `${WIKI_DIR}/${ENTITIES_DIR}`, dirs);

  const schema = await loadWikiSchema(root);
  const folders = new Set<string>();
  for (const def of Object.values(schema.entityTypes)) folders.add(def.folder.replace(/\/$/, ""));
  for (const folder of Object.values(schema.pageRoles)) folders.add(folder.replace(/\/$/, ""));
  for (const folder of [...folders].sort()) await ensureDir(root, folder, dirs);

  const indexOutcome = await ensureFile(root, `${WIKI_DIR}/${INDEX_FILE}`, DEFAULT_INDEX_MD);
  (indexOutcome === "created" ? created : skipped).push(`${WIKI_DIR}/${INDEX_FILE}`);
  const logOutcome = await ensureFile(root, `${WIKI_DIR}/${LOG_FILE}`, DEFAULT_LOG_MD);
  (logOutcome === "created" ? created : skipped).push(`${WIKI_DIR}/${LOG_FILE}`);

  return { dirs, created, skipped };
}

/** wiki 是否已存在（只读；不存在视为空 wiki，不报错） */
export async function wikiExists(workspaceDir: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(path.resolve(workspaceDir), WIKI_DIR));
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** 读取 wiki 内某相对路径的文件；不存在 → null */
export async function readWikiText(workspaceDir: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(path.resolve(workspaceDir), rel), "utf8");
  } catch {
    return null;
  }
}

export const WIKI_FILES = {
  SCHEMA: `${WIKI_DIR}/${SCHEMA_FILE}`,
  INDEX: `${WIKI_DIR}/${INDEX_FILE}`,
  LOG: `${WIKI_DIR}/${LOG_FILE}`,
  SUMMARIES: `${WIKI_DIR}/${SUMMARIES_DIR}`,
  ENTITIES: `${WIKI_DIR}/${ENTITIES_DIR}`,
} as const;