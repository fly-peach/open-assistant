/**
 * 项目记忆：从单文件迁移到工作区内 wiki（tasks 11.9–11.17）。
 *
 * 历史形态是 `<工作区>/.open-assistant/project-memory.md`（单文件）。现在项目记忆
 * 归入 `wiki/index.md` 的「项目记忆」保留分区：
 * - `readProjectMemory`：返回 **`wiki/index.md` 的内容**（迁移后语义一致）；
 * - `writeProjectMemory`：写进 index.md 的 `## 项目记忆` 分区；
 * - 旧 `project-memory.md` 的内容**并入 index**，原文件改名为
 *   `project-memory.md.migrated` **保留**（不删，保证旧数据不丢）。
 *
 * 兼容：wiki 尚未建立时（未初始化的临时工作区）`readProjectMemory` 回退读旧单文件，
 * `writeProjectMemory` 也沿用旧单文件，语义与迁移前一致。
 */
import path from "node:path";
import fs from "node:fs/promises";

import {
  ensureAppDataDir,
  workspaceAppDataDir,
} from "./workspace.js";
import { writeTextAtomic } from "./agents/json-file.js";
import {
  readProjectMemorySection,
  readWikiIndex,
  updateProjectMemorySection,
} from "./wiki/index-log.js";

export const PROJECT_MEMORY_FILE = "project-memory.md";

/** 迁移后旧文件的保留名（不删旧数据） */
export const PROJECT_MEMORY_MIGRATED_FILE = "project-memory.md.migrated";

/** 标记一次迁移已完成（写在 index.md 的项目记忆分区里，幂等） */
export const PROJECT_MEMORY_MIGRATED_MARKER = "<!-- migrated:project-memory -->";

/** 读取上限（与 agent 记忆同量级，避免把上下文吃光） */
export const PROJECT_MEMORY_MAX_BYTES = 32 * 1024;

/** `<工作区>/.open-assistant/project-memory.md` 的绝对路径（历史路径，保留兼容） */
export function workspaceProjectMemoryPath(workspaceDir: string): string {
  return path.join(workspaceAppDataDir(workspaceDir), PROJECT_MEMORY_FILE);
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function truncate(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= PROJECT_MEMORY_MAX_BYTES) return content;
  return Buffer.from(content, "utf8").subarray(0, PROJECT_MEMORY_MAX_BYTES).toString("utf8");
}

/** 把旧单文件改名为 `.migrated` 保留；目标已被占用时加数字后缀，绝不覆盖 */
async function keepLegacyFile(workspaceDir: string, legacyPath: string): Promise<void> {
  if (!(await exists(legacyPath))) return;
  const base = path.join(workspaceAppDataDir(workspaceDir), PROJECT_MEMORY_MIGRATED_FILE);
  let target = base;
  let index = 1;
  while (await exists(target)) {
    index += 1;
    target = `${base}.${index}`;
  }
  await fs.rename(legacyPath, target).catch(() => undefined);
}

export interface ProjectMemoryMigration {
  migrated: boolean;
  reason?: "no_wiki" | "no_legacy" | "legacy_empty" | "already_migrated";
}

/**
 * 把旧 `project-memory.md` 并入 `wiki/index.md` 的「项目记忆」分区，并保留旧文件。
 * 幂等：index 里已带迁移标记时不再重复并入。
 */
export async function migrateProjectMemoryToWiki(
  workspaceDir: string,
): Promise<ProjectMemoryMigration> {
  const index = await readWikiIndex(workspaceDir);
  if (index === null) return { migrated: false, reason: "no_wiki" };

  const legacyPath = workspaceProjectMemoryPath(workspaceDir);
  const legacy = await readFileOrNull(legacyPath);
  if (legacy === null) return { migrated: false, reason: "no_legacy" };

  if (legacy.trim().length === 0) {
    await keepLegacyFile(workspaceDir, legacyPath);
    return { migrated: false, reason: "legacy_empty" };
  }

  if (index.includes(PROJECT_MEMORY_MIGRATED_MARKER)) {
    await keepLegacyFile(workspaceDir, legacyPath);
    return { migrated: false, reason: "already_migrated" };
  }

  // 保留 index 里已有的人工内容，把旧单文件内容一并并入
  const existing = await readProjectMemorySection(workspaceDir)
    .then((section) => section.replace(PROJECT_MEMORY_MIGRATED_MARKER, "").trim())
    .catch(() => "");
  const merged = [legacy.trim(), existing]
    .filter((part) => part.length > 0)
    .join("\n\n");
  await updateProjectMemorySection(
    workspaceDir,
    `${merged}\n\n${PROJECT_MEMORY_MIGRATED_MARKER}`,
  );
  await keepLegacyFile(workspaceDir, legacyPath);
  return { migrated: true };
}

/**
 * 读取项目记忆。
 * - wiki 已建立 → 返回 `wiki/index.md` 的内容（项目记忆的主入口）；
 * - wiki 尚未建立 → 回退读旧单文件（保证旧数据不丢），不存在则 ""（视为空，不报错）。
 */
export async function readProjectMemory(workspaceDir: string): Promise<string> {
  try {
    await migrateProjectMemoryToWiki(workspaceDir);
  } catch {
    // 迁移失败不影响读取：下面仍会给出可得内容
  }
  const index = await readWikiIndex(workspaceDir).catch(() => null);
  if (index !== null && index.trim().length > 0) return truncate(index);

  const legacy = await readFileOrNull(workspaceProjectMemoryPath(workspaceDir)).catch(() => null);
  if (legacy !== null && legacy.trim().length > 0) return truncate(legacy);

  // 最后兜底：迁移后的归档文件
  const kept = await readFileOrNull(
    path.join(workspaceAppDataDir(workspaceDir), PROJECT_MEMORY_MIGRATED_FILE),
  ).catch(() => null);
  return kept ? truncate(kept) : "";
}

/**
 * 写入项目记忆。
 * - wiki 已建立 → 写进 `wiki/index.md` 的 `## 项目记忆` 分区（其余分区不动）；
 * - wiki 尚未建立 → 沿用旧单文件（不隐式创建 wiki）。
 */
export async function writeProjectMemory(workspaceDir: string, content: string): Promise<void> {
  const index = await readWikiIndex(workspaceDir).catch(() => null);
  if (index !== null) {
    await updateProjectMemorySection(workspaceDir, content);
    return;
  }
  await ensureAppDataDir(workspaceDir);
  await writeTextAtomic(workspaceProjectMemoryPath(workspaceDir), content);
}