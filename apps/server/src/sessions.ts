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
import { readBinding, readSessionOwners } from "./binding.js";

export const WORKSPACE_METADATA_KEY = "workspace";

/** thread metadata 里「创建时所属 agent」的键（会话列表据此标注「由 xxx 创建」） */
export const AGENT_METADATA_KEY = "agent_id";

/** 平台侧 PATCH `/threads/{id}` 只接受 UUID（见 langgraph-api api/threads.mjs 的 param 校验） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * 把会话归属（工作区绝对路径 + 创建时所属 agent）**合并**写进平台 thread metadata。
 *
 * 会话列表（前端 `useThreads`）据此按工作区过滤：因为工作区 ↔ agent 是 1:1
 * （见 binding.ts），「按工作区过滤」在正常情形下即「按 agent 过滤」，且换绑 keep
 * 模式下旧会话仍能看到并标注「由 xxx 创建」。
 *
 * 平台 PATCH 的 metadata 是**合并**语义（不会清掉 graph_id / assistant_id），
 * 因此只传我们要管的两个键即可。
 *
 * **best-effort**：平台暂不可达 / thread 已被删除 / thread_id 不是平台接受的 UUID
 * 都不应影响本轮对话，出错时返回 false。
 */
export async function stampThreadOwnership(
  threadId: string,
  ownership: { workspace: string; agentId?: string },
  client: Client = createAgentClient(),
): Promise<boolean> {
  if (!UUID_RE.test(threadId)) return false;
  const metadata: Metadata = { [WORKSPACE_METADATA_KEY]: ownership.workspace };
  if (ownership.agentId) metadata[AGENT_METADATA_KEY] = ownership.agentId;
  try {
    await client.threads.update(threadId, { metadata });
    return true;
  } catch {
    return false;
  }
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

export interface OwnershipBackfillResult {
  scanned: number;
  /** metadata 被补写 / 修正的 thread 数 */
  updated: number;
  /** 归属已正确、无需改动的 thread 数 */
  unchanged: number;
  failures: Array<{ threadId: string; error: string }>;
}

export interface OwnershipBackfillOptions {
  /** 完全没有归属信息时的兜底工作区绝对路径；默认取 `.workspaces/default` */
  defaultWorkspacePath?: string;
  pageSize?: number;
  logger?: (msg: string) => void;
  dryRun?: boolean;
}

/** 从 thread 的运行配置里取「最近一次 run 真正用的工作区」（前端随 run 传的绝对值） */
export function readWorkspaceFromThreadConfig(
  config: Thread["config"] | undefined,
): string | undefined {
  const configurable = config?.configurable as Record<string, unknown> | undefined;
  const raw = configurable?.[WORKSPACE_METADATA_KEY];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** 绝对路径且实际是目录 → realpath；否则 null（绝不把归属指向不存在的目录） */
async function resolveExistingDir(input: unknown): Promise<string | null> {
  if (typeof input !== "string" || input.trim().length === 0) return null;
  if (!path.isAbsolute(input)) return null;
  const resolved = path.resolve(input);
  try {
    const st = await fs.stat(resolved);
    if (!st.isDirectory()) return null;
    return await fs.realpath(resolved);
  } catch {
    return null;
  }
}

/**
 * 回填 / 修正历史 thread 的归属 metadata（`workspace` + `agent_id`）。
 *
 * 为什么需要：会话列表按 `metadata.workspace` 过滤（workspace ↔ agent 1:1）。
 * 旧 thread 的归属要么缺失、要么是早期迁移写死的 `.workspaces/default`（与实际不符），
 * 不过滤就看不到。真正的来源是 `thread.config.configurable.workspace`（上次 run 用的工作区），
 * 完全没有时才退回默认工作区。
 *
 * agent 取「该工作区会话归属标注」里的历史值（换绑后仍是创建时那位），没有则取当前绑定。
 * 只补写 / 修正，不删除既有值；只 patch metadata，不动 checkpoint / messages，
 * 因此历史数据不丢失、可继续。
 */
export async function backfillThreadOwnership(
  client: Client,
  options: OwnershipBackfillOptions = {},
): Promise<OwnershipBackfillResult> {
  const defaultWorkspacePath = options.defaultWorkspacePath ?? getDefaultWorkspacePath();
  const pageSize = options.pageSize ?? 100;
  const logger = options.logger ?? (() => undefined);
  const result: OwnershipBackfillResult = { scanned: 0, updated: 0, unchanged: 0, failures: [] };

  // 同一工作区（可能有很多 thread）只读一次归属标注 / 绑定
  const ownersCache = new Map<string, Record<string, string>>();
  const bindingCache = new Map<string, string | null>();
  const ownersOf = async (ws: string): Promise<Record<string, string>> => {
    const cached = ownersCache.get(ws);
    if (cached) return cached;
    const owners = await readSessionOwners(ws).catch(() => ({}) as Record<string, string>);
    ownersCache.set(ws, owners);
    return owners;
  };
  const boundAgentOf = async (ws: string): Promise<string | null> => {
    if (bindingCache.has(ws)) return bindingCache.get(ws) ?? null;
    let id: string | null = null;
    try {
      id = (await readBinding(ws))?.agentId ?? null;
    } catch {
      id = null;
    }
    bindingCache.set(ws, id);
    return id;
  };

  let offset = 0;
  for (;;) {
    const page = await client.threads.search({ limit: pageSize, offset });
    if (page.length === 0) break;
    for (const thread of page as Thread[]) {
      result.scanned += 1;
      const existingWs = readWorkspaceFromThreadMetadata(thread.metadata);
      const metadata = (thread.metadata ?? {}) as Record<string, unknown>;
      const existingAgent =
        typeof metadata[AGENT_METADATA_KEY] === "string"
          ? (metadata[AGENT_METADATA_KEY] as string)
          : undefined;

      // 目标工作区：优先「上次 run 用的真实工作区」，其次信任既有归属，最后兜底默认
      const configWs = await resolveExistingDir(readWorkspaceFromThreadConfig(thread.config));
      const existingWsDir = existingWs
        ? ((await resolveExistingDir(existingWs)) ?? existingWs)
        : undefined;
      const targetWs =
        configWs ??
        existingWsDir ??
        ((await resolveExistingDir(defaultWorkspacePath)) ?? defaultWorkspacePath);

      const needsWs = targetWs !== existingWs;
      let targetAgent: string | undefined;
      if (!existingAgent) {
        const owners = await ownersOf(targetWs);
        targetAgent = owners[thread.thread_id] ?? (await boundAgentOf(targetWs)) ?? undefined;
      }
      const needsAgent = !existingAgent && !!targetAgent;

      if (!needsWs && !needsAgent) {
        result.unchanged += 1;
        continue;
      }
      if (options.dryRun) {
        result.updated += 1;
        logger(
          `[backfill] (dry-run) thread ${thread.thread_id} → workspace=${targetWs} agent=${targetAgent ?? "-"}`,
        );
        continue;
      }
      try {
        const patch: Metadata = {};
        if (needsWs) patch[WORKSPACE_METADATA_KEY] = targetWs;
        if (needsAgent) patch[AGENT_METADATA_KEY] = targetAgent;
        await client.threads.update(thread.thread_id, { metadata: patch });
        result.updated += 1;
        logger(`[backfill] thread ${thread.thread_id} → workspace=${targetWs} agent=${targetAgent ?? "-"}`);
      } catch (err) {
        result.failures.push({ threadId: thread.thread_id, error: (err as Error).message });
        logger(`[backfill] thread ${thread.thread_id} 回填失败: ${(err as Error).message}`);
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

let migrationPromise: Promise<OwnershipBackfillResult> | null = null;

/**
 * 进程内只跑一次「历史会话归属回填」。放在自定义 HTTP 路由的首次请求时触发，
 * 避免在 server 尚未监听时自连失败。
 */
export function runWorkspaceMigrationOnce(
  logger?: (msg: string) => void,
): Promise<OwnershipBackfillResult> {
  if (migrationPromise === null) {
    migrationPromise = backfillThreadOwnership(createAgentClient(), { logger }).catch((err) => {
      logger?.(`[backfill] 整体失败: ${(err as Error).message}`);
      return {
        scanned: 0,
        updated: 0,
        unchanged: 0,
        failures: [{ threadId: "-", error: (err as Error).message }],
      };
    });
  }
  return migrationPromise;
}