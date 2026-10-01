/**
 * 会话库连接：按工作区缓存、打开时建表、提供显式关闭。
 *
 * 为什么需要显式关闭：库文件在工作区目录内（D4），删除工作区前必须先释放
 * 句柄（Windows 下打开中的 sqlite 文件无法被删除）。模块提供
 * `closeConversationDb` / `closeAllConversationDbs` / `removeConversationDb`。
 *
 * 驱动用 Node 24 内置的 `node:sqlite`（DatabaseSync）——它不引入额外依赖，
 * 且在 `langgraph dev` 的 Node 运行时可用（`better-sqlite3` 在 bun 下不可用，
 * 见 design Risks；因此碰 SQLite 的测试必须用 Node 跑）。
 */
import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { conversationDataDir, conversationDbPath } from "./paths.js";
import { applyConversationSchema } from "./schema.js";

/**
 * 打开（或复用）某工作区的会话库连接。副作用：按需创建
 * `<工作区>/.open-assistant/` 目录并建表。
 */
const connections = new Map<string, DatabaseSync>();

function cacheKey(workspaceDir: string): string {
  return path.resolve(workspaceDir);
}

/** 打开会话库（幂等）。调用方一般不需要直接用它，store 的 API 会内部复用。 */
export function openConversationDb(workspaceDir: string): DatabaseSync {
  if (typeof workspaceDir !== "string" || workspaceDir.trim().length === 0) {
    throw new Error("openConversationDb 需要工作区路径");
  }
  const key = cacheKey(workspaceDir);
  const existing = connections.get(key);
  if (existing) return existing;

  const dir = conversationDataDir(workspaceDir);
  // 同步建目录：connection 的创建是同步的，避免引入 async 边界。
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(conversationDbPath(workspaceDir));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  applyConversationSchema(db);
  connections.set(key, db);
  return db;
}

/** 关闭某工作区的会话库连接（删除工作区目录前调用；重复关闭无副作用） */
export function closeConversationDb(workspaceDir: string): void {
  const key = cacheKey(workspaceDir);
  const db = connections.get(key);
  if (!db) return;
  connections.delete(key);
  try {
    db.close();
  } catch {
    // 已关闭 / 句柄异常时忽略，关闭语义是「尽力释放」
  }
}

/** 关闭全部连接（进程退出 / 测试收尾用） */
export function closeAllConversationDbs(): void {
  for (const key of [...connections.keys()]) {
    const db = connections.get(key);
    connections.delete(key);
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/** 库文件是否存在（不打开连接） */
export async function conversationDbExists(workspaceDir: string): Promise<boolean> {
  try {
    const st = await fs.stat(conversationDbPath(workspaceDir));
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * 移除某工作区的会话库（关闭连接 + 删除 sessions.sqlite / -wal / -shm）。
 * 用于「删除工作区」这类显式动作：删完不留下不可达的会话与子会话数据。
 */
export async function removeConversationDb(workspaceDir: string): Promise<void> {
  closeConversationDb(workspaceDir);
  const base = conversationDbPath(workspaceDir);
  for (const file of [base, `${base}-wal`, `${base}-shm`, `${base}-journal`]) {
    await fs.rm(file, { force: true }).catch(() => undefined);
  }
}