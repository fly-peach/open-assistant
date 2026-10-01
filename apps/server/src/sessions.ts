/**
 * 会话（thread）与工作区的归属：
 *
 * 对齐 spec：
 * - session-store / 会话可按工作区归属与检索：metadata.workspace 记录归属（工作区绝对路径），按工作区过滤
 * - session-store / 会话数据落在所属工作区内：会话索引写在工作区 `.open-assistant/sessions.json`
 *   （thread 内容本身由 LangGraph 持久化）
 *
 * 历史遗留 thread 没有 workspace 归属 → 迁移到默认工作区并记录日志（数据不删）。
 */
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { Client, type Metadata, type Thread } from "@langchain/langgraph-sdk";
import {
  ensureAppDataDir,
  getDefaultWorkspacePath,
  workspaceSessionIndexPath,
} from "./workspace.js";

export const WORKSPACE_METADATA_KEY = "workspace";

export function getLangGraphApiUrl(): string {
  return process.env.LANGGRAPH_API_URL ?? "http://localhost:2024";
}

export function createAgentClient(apiUrl: string = getLangGraphApiUrl()): Client {
  return new Client({ apiUrl });
}

export function readWorkspaceFromThreadMetadata(metadata: Metadata | undefined): string | undefined {
  if (!metadata) return undefined;
  const raw = metadata[WORKSPACE_METADATA_KEY];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

// —— 工作区内的会话索引（应用数据，落在 <工作区>/.open-assistant/） ——

export interface WorkspaceSessionIndexEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
}

export interface WorkspaceSessionIndex {
  version: 1;
  updatedAt: string;
  sessions: WorkspaceSessionIndexEntry[];
}

function emptySessionIndex(now = new Date().toISOString()): WorkspaceSessionIndex {
  return { version: 1, updatedAt: now, sessions: [] };
}

/** 读取工作区会话索引；文件不存在 → 视为空 */
export async function readWorkspaceSessionIndex(workspaceDir: string): Promise<WorkspaceSessionIndex> {
  const filePath = workspaceSessionIndexPath(workspaceDir);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return emptySessionIndex();
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as WorkspaceSessionIndex;
    if (!parsed || !Array.isArray(parsed.sessions)) throw new Error("结构非法");
    return parsed;
  } catch (err) {
    throw new Error(`工作区会话索引不是合法 JSON（${(err as Error).message}）: ${filePath}`);
  }
}

const indexLocks = new Map<string, Promise<unknown>>();
function withIndexLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = indexLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  indexLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** 原子写入会话索引（临时文件 + rename），只落在 `<工作区>/.open-assistant/sessions.json` */
async function writeWorkspaceSessionIndex(
  workspaceDir: string,
  index: WorkspaceSessionIndex,
): Promise<void> {
  await ensureAppDataDir(workspaceDir);
  const filePath = workspaceSessionIndexPath(workspaceDir);
  const payload = JSON.stringify(index, null, 2) + "\n";
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await fs.open(tmpPath, "w");
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** 把一条会话登记进所属工作区的会话索引（幂等 upsert） */
export async function upsertWorkspaceSessionIndex(
  workspaceDir: string,
  entry: { id: string; createdAt?: string; title?: string },
): Promise<void> {
  if (typeof entry.id !== "string" || entry.id.length === 0) {
    throw new Error("会话索引条目缺少 id");
  }
  const filePath = workspaceSessionIndexPath(workspaceDir);
  await withIndexLock(filePath, async () => {
    const index = await readWorkspaceSessionIndex(workspaceDir);
    const now = new Date().toISOString();
    const sessions = index.sessions.filter((s) => s.id !== entry.id);
    sessions.push({
      id: entry.id,
      createdAt: entry.createdAt ?? now,
      updatedAt: now,
      ...(entry.title !== undefined ? { title: entry.title } : {}),
    });
    await writeWorkspaceSessionIndex(workspaceDir, { version: 1, updatedAt: now, sessions });
  });
}

export interface MigrationResult {
  scanned: number;
  migrated: number;
  alreadyOwned: number;
  failures: Array<{ threadId: string; error: string }>;
}

export interface MigrationOptions {
  /** 无归属 thread 的目标工作区绝对路径；默认取 `.workspaces/default` */
  defaultWorkspacePath?: string;
  pageSize?: number;
  logger?: (msg: string) => void;
  dryRun?: boolean;
}

/**
 * 为没有 workspace 归属的历史 thread 补写默认工作区归属。
 * 只 patch metadata，不动 checkpoint / messages，因此历史数据不丢失、可继续。
 */
export async function migrateThreadsWithoutWorkspace(
  client: Client,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const defaultWorkspacePath = options.defaultWorkspacePath ?? getDefaultWorkspacePath();
  const pageSize = options.pageSize ?? 100;
  const logger = options.logger ?? (() => undefined);
  const result: MigrationResult = { scanned: 0, migrated: 0, alreadyOwned: 0, failures: [] };

  let offset = 0;
  for (;;) {
    const page = await client.threads.search({ limit: pageSize, offset });
    if (page.length === 0) break;
    for (const thread of page as Thread[]) {
      result.scanned += 1;
      const existing = readWorkspaceFromThreadMetadata(thread.metadata);
      if (existing) {
        result.alreadyOwned += 1;
        continue;
      }
      if (options.dryRun) {
        result.migrated += 1;
        logger(`[migrate] (dry-run) thread ${thread.thread_id} → workspace=${defaultWorkspacePath}`);
        continue;
      }
      try {
        await client.threads.update(thread.thread_id, {
          metadata: { ...(thread.metadata ?? {}), [WORKSPACE_METADATA_KEY]: defaultWorkspacePath },
        });
        result.migrated += 1;
        logger(`[migrate] thread ${thread.thread_id} 补写 workspace=${defaultWorkspacePath}`);
      } catch (err) {
        result.failures.push({ threadId: thread.thread_id, error: (err as Error).message });
        logger(`[migrate] thread ${thread.thread_id} 迁移失败: ${(err as Error).message}`);
      }
    }
    offset += page.length;
    if (page.length < pageSize) break;
  }
  return result;
}

/** 按工作区检索会话（只有归属该工作区的会话会返回） */
export async function searchThreadsByWorkspace(
  client: Client,
  workspacePath: string,
  query: { limit?: number; offset?: number } = {},
): Promise<Thread[]> {
  return client.threads.search({
    metadata: { [WORKSPACE_METADATA_KEY]: workspacePath },
    limit: query.limit ?? 50,
    offset: query.offset ?? 0,
    sortBy: "updated_at",
    sortOrder: "desc",
  });
}

/**
 * 创建一个归属指定工作区（绝对路径）的 thread，
 * 并把会话登记进工作区的应用数据目录（`<工作区>/.open-assistant/sessions.json`）。
 */
export async function createThreadForWorkspace(
  client: Client,
  workspacePath: string,
  metadata: Metadata = {},
): Promise<Thread> {
  const thread = await client.threads.create({
    metadata: { ...metadata, [WORKSPACE_METADATA_KEY]: workspacePath },
  });
  await upsertWorkspaceSessionIndex(workspacePath, {
    id: thread.thread_id,
    createdAt: thread.created_at ?? new Date().toISOString(),
  });
  return thread;
}

let migrationPromise: Promise<MigrationResult> | null = null;

/**
 * 进程内只跑一次迁移。放在自定义 HTTP 路由的首次请求时触发，
 * 避免在 server 尚未监听时自连失败。
 */
export function runWorkspaceMigrationOnce(logger?: (msg: string) => void): Promise<MigrationResult> {
  if (migrationPromise === null) {
    migrationPromise = migrateThreadsWithoutWorkspace(createAgentClient(), { logger }).catch((err) => {
      logger?.(`[migrate] 迁移整体失败: ${(err as Error).message}`);
      return { scanned: 0, migrated: 0, alreadyOwned: 0, failures: [{ threadId: "-", error: (err as Error).message }] };
    });
  }
  return migrationPromise;
}