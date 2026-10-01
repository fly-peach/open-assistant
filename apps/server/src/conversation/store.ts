/**
 * 会话库读写 API（thread / turn / message 三层）。
 *
 * ============================ 下一个接线的人看这里 ============================
 * 库位置：`<工作区>/.open-assistant/sessions.sqlite`（`conversationDbPath`）。
 * 连接自动：所有函数第一个参数是工作区绝对路径，内部复用连接并自动建表，
 *          不需要手动 open；删除工作区目录前调 `closeConversationDb(ws)`。
 *
 * 典型接线（runtime 接入层：一轮结束 / 流式过程中）：
 *
 *   // ① 建会话（通常由拦截层 / run 首次进入时调用）
 *   const t = createThread(ws, { agentId, kind: "main", title: null });
 *
 *   // ② 一轮开始：插入轮次 + 用户消息（status="running"）
 *   const turn = startTurn(ws, { threadId: t.id, userContent: "你好" });
 *   //    流式过程中追加消息（seq 自动递增）
 *   appendMessage(ws, { threadId: t.id, turnId: turn.id, role: "ai", kind: "text", content: "在" });
 *   appendMessage(ws, { threadId: t.id, turnId: turn.id, role: "tool", kind: "tool-call",
 *                       toolName: "read_file", toolCallId: "call_1", content: "{...}" });
 *   //    一轮结束：标记 done / cancelled / error
 *   finishTurn(ws, turn.id, { status: "done" });
 *
 *   // 或非流式一次性落库（等价于 startTurn + 消息 + finishTurn，单事务原子）：
 *   recordTurn(ws, { threadId: t.id, userContent, messages: [...] });
 *
 *   // ③ 读
 *   listSessions(ws);                       // 会话列表（含非活跃，按最近活动倒序）
 *   getThread(ws, threadId);
 *   listTurns(ws, threadId);
 *   readThreadMessages(ws, threadId);       // 按轮次序 + 消息 seq，顺序稳定
 *   readTurnMessages(ws, threadId, 0);      // 按 (会话, 轮次序号) 定位
 *
 *   // ④ 子会话 / 跨工作区
 *   createThread(ws, { agentId, kind: "subagent",
 *                      parentThreadId: t.id, parentToolCallId: "call_2" });
 *   listChildThreads(ws, t.id);             // 挂在父会话下的子会话
 *   const call = createAgentCallThread(ws, { agentId, peerAgentId, peerThreadId }); // A 侧
 *   createCalledThread(wsB, { agentId, initiatorAgentId, initiatorThreadId });      // B 侧
 *
 *   // ⑤ 状态 / 标题 / 删
 *   updateThread(ws, t.id, { title: "改名" });
 *   updateThreadStatus(ws, t.id, "archived");       // 冻结后置为非活跃
 *   deleteThread(ws, t.id, { childAction: "cascade" }); // 默认连带子会话；"detach" 保留为孤儿
 *
 * 子会话隔离：子会话是 `threads` 里独立一行，消息的 thread_id 指向子会话，
 * 所以 `readThreadMessages(主会话)` 天然不会混入子会话消息（spec：子会话不混入主记录）。
 *
 * 对端会话标识：design D4 的 `threads` 列里只有 `peer_agent_id`，而 spec 要求
 * 「A 侧标明对端 agent 与会话标识」。因此对端会话 id 存在 `meta_json.peerThreadId`，
 * 被调用侧存在 `meta_json.initiatorAgentId/initiatorThreadId`，并在 `ThreadRecord`
 * 上以 `peerThreadId/initiatorAgentId/initiatorThreadId` 暴露。
 * ============================================================================
 */
import crypto from "node:crypto";
import path from "node:path";

import { openConversationDb } from "./db.js";
import {
  MESSAGES_TABLE,
  THREADS_TABLE,
  TURNS_TABLE,
} from "./schema.js";
import type {
  CreateThreadInput,
  DeleteThreadResult,
  ListThreadsOptions,
  MessageRecord,
  MessageRole,
  NewMessageInput,
  RecordTurnInput,
  RecordTurnResult,
  ThreadKind,
  ThreadRecord,
  ThreadStatus,
  ThreadSummary,
  TurnRecord,
  TurnStatus,
  UpdateThreadPatch,
} from "./types.js";
import { ConversationStoreError } from "./types.js";

export { ConversationStoreError } from "./types.js";
export type * from "./types.js";
export { conversationDbPath, CONVERSATION_DB_FILE } from "./paths.js";
export {
  closeAllConversationDbs,
  closeConversationDb,
  conversationDbExists,
  removeConversationDb,
} from "./db.js";

// —— 常量集合 ——

const THREAD_KINDS: readonly ThreadKind[] = ["main", "subagent", "agent-call"];
const THREAD_STATUSES: readonly ThreadStatus[] = ["active", "archived", "error"];
const TURN_STATUSES: readonly TurnStatus[] = ["running", "done", "cancelled", "error"];
const MESSAGE_ROLES: readonly MessageRole[] = ["human", "ai", "tool"];

const DEFAULT_TITLE = "未命名会话";
const DEFAULT_TITLE_MAX_CHARS = 24;

/** 事务嵌套深度（按工作区连接）。同步 API 不会交错，模块级计数即可。 */
const txDepth = new Map<string, number>();

// —— 小工具 ——

function nowIso(): string {
  return new Date().toISOString();
}

function uid(): string {
  return crypto.randomUUID();
}

/** node:sqlite 不接受 undefined，统一归一为 null */
function param(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  return value as string | number | bigint | Uint8Array;
}

function asString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  const text = asString(raw);
  if (text === null || text.length === 0) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConversationStoreError("CONVERSATION_INVALID_INPUT", `${field} 必须是非空字符串`);
  }
  return value;
}

function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ConversationStoreError(
      "CONVERSATION_INVALID_INPUT",
      `${field} 非法：${JSON.stringify(value)}（允许 ${allowed.join(" / ")}）`,
    );
  }
  return value as T;
}

function withTransaction<T>(workspaceDir: string, fn: () => T): T {
  const key = path.resolve(workspaceDir);
  const depth = txDepth.get(key) ?? 0;
  const db = openConversationDb(workspaceDir);
  const savepoint = `oa_sp_${depth}`;
  if (depth === 0) {
    db.exec("BEGIN IMMEDIATE");
  } else {
    db.exec(`SAVEPOINT ${savepoint}`);
  }
  txDepth.set(key, depth + 1);
  try {
    const result = fn();
    if (depth === 0) db.exec("COMMIT");
    else db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    try {
      if (depth === 0) db.exec("ROLLBACK");
      else db.exec(`ROLLBACK TO ${savepoint}`);
    } catch {
      // 回滚失败时保留原始错误
    }
    throw err;
  } finally {
    txDepth.set(key, depth);
  }
}

// —— 行映射 ——

type Row = Record<string, unknown>;

function mapThread(row: Row): ThreadRecord {
  const meta = parseJsonObject(row["meta_json"]);
  const peerThreadId = meta?.["peerThreadId"];
  const initiatorAgentId = meta?.["initiatorAgentId"];
  const initiatorThreadId = meta?.["initiatorThreadId"];
  return {
    id: String(row["id"]),
    agentId: String(row["agent_id"]),
    kind: String(row["kind"]) as ThreadKind,
    parentThreadId: asString(row["parent_thread_id"]),
    parentToolCallId: asString(row["parent_tool_call_id"]),
    peerAgentId: asString(row["peer_agent_id"]),
    title: asString(row["title"]),
    status: String(row["status"]) as ThreadStatus,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    meta,
    peerThreadId: typeof peerThreadId === "string" ? peerThreadId : null,
    initiatorAgentId: typeof initiatorAgentId === "string" ? initiatorAgentId : null,
    initiatorThreadId: typeof initiatorThreadId === "string" ? initiatorThreadId : null,
  };
}

function mapTurn(row: Row): TurnRecord {
  return {
    id: String(row["id"]),
    threadId: String(row["thread_id"]),
    idx: Number(row["idx"]),
    userContent: String(row["user_content"]),
    startedAt: asString(row["started_at"]),
    endedAt: asString(row["ended_at"]),
    status: String(row["status"]) as TurnStatus,
    usage: parseJsonObject(row["usage_json"]),
    compactedBy: asString(row["compacted_by"]),
  };
}

function mapMessage(row: Row): MessageRecord {
  return {
    id: String(row["id"]),
    threadId: String(row["thread_id"]),
    turnId: String(row["turn_id"]),
    seq: Number(row["seq"]),
    role: String(row["role"]) as MessageRole,
    kind: asString(row["kind"]),
    content: asString(row["content"]),
    toolName: asString(row["tool_name"]),
    toolCallId: asString(row["tool_call_id"]),
    namespace: asString(row["namespace"]),
    createdAt: String(row["created_at"]),
    tokens: asNumber(row["tokens"]),
  };
}

function mapSummary(row: Row): ThreadSummary {
  const thread = mapThread(row);
  return {
    ...thread,
    // 列表展示：尚未生成标题（还没有用户输入）时给一个可辨识的占位标题。
    // 记录本身仍保留 null，等首条用户输入再自动生成。
    title: thread.title ?? DEFAULT_TITLE,
    turnCount: Number(row["turn_count"] ?? 0),
    messageCount: Number(row["message_count"] ?? 0),
    unfinishedTurnCount: Number(row["unfinished_turn_count"] ?? 0),
    lastActivityAt: thread.updatedAt,
  };
}

// —— 会话（threads） ——

/** 由首条用户输入生成默认标题：取首个非空行的前 24 字 */
export function defaultTitleFromUserContent(
  content: string,
  maxChars: number = DEFAULT_TITLE_MAX_CHARS,
): string {
  const firstLine =
    String(content ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const title = Array.from(firstLine).slice(0, Math.max(1, maxChars)).join("");
  return title.length > 0 ? title : DEFAULT_TITLE;
}

export function createThread(workspaceDir: string, input: CreateThreadInput): ThreadRecord {
  const agentId = requireNonEmpty(input?.agentId, "agentId");
  const kind = assertOneOf(input.kind ?? "main", THREAD_KINDS, "kind");
  const status = assertOneOf(input.status ?? "active", THREAD_STATUSES, "status");
  const id = input.id ?? uid();
  const now = nowIso();
  const createdAt = input.createdAt ?? now;
  const updatedAt = input.updatedAt ?? createdAt;

  const meta: Record<string, unknown> = { ...(input.meta ?? {}) };
  if (input.peerThreadId) meta["peerThreadId"] = input.peerThreadId;
  if (input.initiatorAgentId) meta["initiatorAgentId"] = input.initiatorAgentId;
  if (input.initiatorThreadId) meta["initiatorThreadId"] = input.initiatorThreadId;
  const metaJson = Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;

  const db = openConversationDb(workspaceDir);
  const exists = db.prepare(`SELECT 1 FROM ${THREADS_TABLE} WHERE id = ?`).get(id);
  if (exists) {
    throw new ConversationStoreError("CONVERSATION_INVALID_INPUT", `会话已存在: ${id}`);
  }
  db.prepare(
    `INSERT INTO ${THREADS_TABLE}
       (id, agent_id, kind, parent_thread_id, parent_tool_call_id, peer_agent_id,
        title, status, created_at, updated_at, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    agentId,
    kind,
    param(input.parentThreadId),
    param(input.parentToolCallId),
    param(input.peerAgentId),
    param(input.title),
    status,
    createdAt,
    updatedAt,
    param(metaJson),
  );
  const created = getThread(workspaceDir, id);
  if (!created) {
    throw new ConversationStoreError("CONVERSATION_DB_ERROR", `会话写入后读不到: ${id}`);
  }
  return created;
}

export function getThread(workspaceDir: string, threadId: string): ThreadRecord | null {
  const row = openConversationDb(workspaceDir)
    .prepare(`SELECT * FROM ${THREADS_TABLE} WHERE id = ?`)
    .get(threadId) as Row | undefined;
  return row ? mapThread(row) : null;
}

export function threadExists(workspaceDir: string, threadId: string): boolean {
  return getThread(workspaceDir, threadId) !== null;
}

function requireThreadRow(workspaceDir: string, threadId: string): Row {
  const row = openConversationDb(workspaceDir)
    .prepare(`SELECT * FROM ${THREADS_TABLE} WHERE id = ?`)
    .get(threadId) as Row | undefined;
  if (!row) {
    throw new ConversationStoreError("CONVERSATION_THREAD_NOT_FOUND", `会话不存在: ${threadId}`);
  }
  return row;
}

/** 局部更新会话（标题 / 状态 / meta）。返回更新后的记录；会话不存在返回 null */
export function updateThread(
  workspaceDir: string,
  threadId: string,
  patch: UpdateThreadPatch,
): ThreadRecord | null {
  const row = openConversationDb(workspaceDir)
    .prepare(`SELECT * FROM ${THREADS_TABLE} WHERE id = ?`)
    .get(threadId) as Row | undefined;
  if (!row) return null;

  const sets: string[] = [];
  const values: Array<string | number | bigint | null | Uint8Array> = [];

  if (patch.title !== undefined) {
    sets.push("title = ?");
    values.push(param(patch.title));
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    values.push(assertOneOf(patch.status, THREAD_STATUSES, "status"));
  }
  if (patch.meta !== undefined || patch.metaPatch !== undefined) {
    const base = patch.meta !== undefined ? { ...(patch.meta ?? {}) } : parseJsonObject(row["meta_json"]) ?? {};
    const merged = { ...base, ...(patch.metaPatch ?? {}) };
    sets.push("meta_json = ?");
    values.push(JSON.stringify(merged));
  }
  sets.push("updated_at = ?");
  values.push(patch.updatedAt ?? nowIso());

  values.push(threadId);
  openConversationDb(workspaceDir)
    .prepare(`UPDATE ${THREADS_TABLE} SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
  return getThread(workspaceDir, threadId);
}

/** 标记会话状态（active / archived / error）；冻结后置为 archived 即「非活跃」 */
export function updateThreadStatus(
  workspaceDir: string,
  threadId: string,
  status: ThreadStatus,
): ThreadRecord | null {
  return updateThread(workspaceDir, threadId, { status });
}

/** 修改会话标题（用户可改；未传则不改） */
export function updateThreadTitle(
  workspaceDir: string,
  threadId: string,
  title: string | null,
): ThreadRecord | null {
  return updateThread(workspaceDir, threadId, { title });
}

interface ThreadQueryBuild {
  where: string[];
  values: Array<string | number>;
}

function buildThreadFilters(options: ListThreadsOptions = {}, alias = ""): ThreadQueryBuild {
  const prefix = alias.length > 0 ? `${alias}.` : "";
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (options.kinds && options.kinds.length > 0) {
    for (const k of options.kinds) assertOneOf(k, THREAD_KINDS, "kinds[]");
    where.push(`${prefix}kind IN (${options.kinds.map(() => "?").join(", ")})`);
    values.push(...options.kinds);
  }
  if (options.statuses && options.statuses.length > 0) {
    for (const s of options.statuses) assertOneOf(s, THREAD_STATUSES, "statuses[]");
    where.push(`${prefix}status IN (${options.statuses.map(() => "?").join(", ")})`);
    values.push(...options.statuses);
  }
  if (options.agentId !== undefined) {
    where.push(`${prefix}agent_id = ?`);
    values.push(options.agentId);
  }
  if (options.parentThreadId !== undefined) {
    if (options.parentThreadId === null) {
      where.push(`${prefix}parent_thread_id IS NULL`);
    } else {
      where.push(`${prefix}parent_thread_id = ?`);
      values.push(options.parentThreadId);
    }
  }
  return { where, values };
}

/** 列出会话（任意 kind；默认全部，含非活跃），按最近活动倒序 */
export function listThreads(workspaceDir: string, options: ListThreadsOptions = {}): ThreadRecord[] {
  const { where, values } = buildThreadFilters(options);
  const limit = options.limit ?? 200;
  const offset = options.offset ?? 0;
  const sql = `SELECT * FROM ${THREADS_TABLE}
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at DESC, created_at DESC, id ASC
    LIMIT ? OFFSET ?`;
  const rows = openConversationDb(workspaceDir)
    .prepare(sql)
    .all(...values, limit, offset) as Row[];
  return rows.map(mapThread);
}

/**
 * 会话列表（列表单位是会话）：默认只看主会话（子会话归父会话展示），
 * 同时包含活跃与非活跃（active / archived / error），按最近活动时间倒序。
 */
export function listSessions(workspaceDir: string, options: ListThreadsOptions = {}): ThreadSummary[] {
  const effective: ListThreadsOptions =
    options.kinds !== undefined ? options : { ...options, kinds: ["main"] };
  const { where, values } = buildThreadFilters(effective, "t");
  const limit = options.limit ?? 200;
  const offset = options.offset ?? 0;
  const sql = `SELECT t.*,
      (SELECT COUNT(*) FROM ${TURNS_TABLE} tn WHERE tn.thread_id = t.id) AS turn_count,
      (SELECT COUNT(*) FROM ${MESSAGES_TABLE} m WHERE m.thread_id = t.id) AS message_count,
      (SELECT COUNT(*) FROM ${TURNS_TABLE} tn2 WHERE tn2.thread_id = t.id AND tn2.status <> 'done') AS unfinished_turn_count
    FROM ${THREADS_TABLE} t
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY t.updated_at DESC, t.created_at DESC, t.id ASC
    LIMIT ? OFFSET ?`;
  const rows = openConversationDb(workspaceDir)
    .prepare(sql)
    .all(...values, limit, offset) as Row[];
  return rows.map(mapSummary);
}

/** 某父会话下的直接子会话（同轮委派 / 同侪） */
export function listChildThreads(workspaceDir: string, parentThreadId: string): ThreadRecord[] {
  const rows = openConversationDb(workspaceDir)
    .prepare(
      `SELECT * FROM ${THREADS_TABLE} WHERE parent_thread_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(parentThreadId) as Row[];
  return rows.map(mapThread);
}

/** 挂在某次 tool call 下的会话（前端把子会话挂在对应 tool call 卡片下） */
export function listThreadsByToolCall(workspaceDir: string, toolCallId: string): ThreadRecord[] {
  const rows = openConversationDb(workspaceDir)
    .prepare(
      `SELECT * FROM ${THREADS_TABLE} WHERE parent_tool_call_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(toolCallId) as Row[];
  return rows.map(mapThread);
}

/** 所有孤儿会话（父会话被以 `detach` 方式删除后保留的记录） */
export function listOrphanThreads(workspaceDir: string): ThreadRecord[] {
  const rows = openConversationDb(workspaceDir)
    .prepare(
      `SELECT * FROM ${THREADS_TABLE}
       WHERE parent_thread_id IS NULL AND json_extract(meta_json, '$.orphaned') = 1
       ORDER BY updated_at DESC, id ASC`,
    )
    .all() as Row[];
  return rows.map(mapThread);
}

// —— 跨工作区调用 ——

/** A 侧记录：`kind='agent-call'`，标明对端 agent 与对端会话标识 */
export function createAgentCallThread(
  workspaceDir: string,
  input: {
    agentId: string;
    peerAgentId: string;
    peerThreadId: string;
    parentThreadId?: string | null;
    parentToolCallId?: string | null;
    title?: string | null;
    status?: ThreadStatus;
    meta?: Record<string, unknown> | null;
    id?: string;
  },
): ThreadRecord {
  return createThread(workspaceDir, {
    ...input,
    kind: "agent-call",
    peerAgentId: requireNonEmpty(input.peerAgentId, "peerAgentId"),
    peerThreadId: requireNonEmpty(input.peerThreadId, "peerThreadId"),
  });
}

/** B 侧记录：对端在自己的工作区新建的会话，标明发起方 agent 与会话标识 */
export function createCalledThread(
  workspaceDir: string,
  input: {
    agentId: string;
    initiatorAgentId: string;
    initiatorThreadId: string;
    title?: string | null;
    meta?: Record<string, unknown> | null;
    id?: string;
  },
): ThreadRecord {
  return createThread(workspaceDir, {
    ...input,
    kind: "main",
    initiatorAgentId: requireNonEmpty(input.initiatorAgentId, "initiatorAgentId"),
    initiatorThreadId: requireNonEmpty(input.initiatorThreadId, "initiatorThreadId"),
  });
}

/** 按对端会话标识反查本侧 agent-call 记录（跨工作区两侧可互相追溯） */
export function findThreadsByPeerThreadId(
  workspaceDir: string,
  peerThreadId: string,
): ThreadRecord[] {
  const rows = openConversationDb(workspaceDir)
    .prepare(
      `SELECT * FROM ${THREADS_TABLE}
       WHERE json_extract(meta_json, '$.peerThreadId') = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(peerThreadId) as Row[];
  return rows.map(mapThread);
}

// —— 轮次（turns） ——

function nextTurnIdx(workspaceDir: string, threadId: string): number {
  const row = openConversationDb(workspaceDir)
    .prepare(`SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM ${TURNS_TABLE} WHERE thread_id = ?`)
    .get(threadId) as Row | undefined;
  return Number(row?.["next"] ?? 0);
}

export function getTurn(workspaceDir: string, turnId: string): TurnRecord | null {
  const row = openConversationDb(workspaceDir)
    .prepare(`SELECT * FROM ${TURNS_TABLE} WHERE id = ?`)
    .get(turnId) as Row | undefined;
  return row ? mapTurn(row) : null;
}

/** 按 (会话, 轮次序号) 定位一轮 */
export function getTurnByIndex(
  workspaceDir: string,
  threadId: string,
  idx: number,
): TurnRecord | null {
  const row = openConversationDb(workspaceDir)
    .prepare(`SELECT * FROM ${TURNS_TABLE} WHERE thread_id = ? AND idx = ?`)
    .get(threadId, idx) as Row | undefined;
  return row ? mapTurn(row) : null;
}

/** 某会话的全部轮次，按序号升序 */
export function listTurns(workspaceDir: string, threadId: string): TurnRecord[] {
  const rows = openConversationDb(workspaceDir)
    .prepare(`SELECT * FROM ${TURNS_TABLE} WHERE thread_id = ? ORDER BY idx ASC, id ASC`)
    .all(threadId) as Row[];
  return rows.map(mapTurn);
}

function insertMessage(
  workspaceDir: string,
  threadId: string,
  turnId: string,
  input: NewMessageInput,
): MessageRecord {
  const role = assertOneOf(input.role, MESSAGE_ROLES, "role");
  const seq =
    input.seq ??
    Number(
      (
        openConversationDb(workspaceDir)
          .prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM ${MESSAGES_TABLE} WHERE turn_id = ?`)
          .get(turnId) as Row | undefined
      )?.["next"] ?? 0,
    );
  const id = input.id ?? uid();
  openConversationDb(workspaceDir)
    .prepare(
      `INSERT INTO ${MESSAGES_TABLE}
         (id, thread_id, turn_id, seq, role, kind, content, tool_name, tool_call_id,
          namespace, created_at, tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      threadId,
      turnId,
      seq,
      role,
      param(input.kind),
      param(input.content),
      param(input.toolName),
      param(input.toolCallId),
      param(input.namespace),
      input.createdAt ?? nowIso(),
      param(input.tokens),
    );
  const row = openConversationDb(workspaceDir)
    .prepare(`SELECT * FROM ${MESSAGES_TABLE} WHERE id = ?`)
    .get(id) as Row;
  return mapMessage(row);
}

/**
 * 开始一轮：写入轮次（默认 status='running'）与对应的用户输入消息（seq=0）。
 * 流式场景先调它，随后用 `appendMessage` 追加、用 `finishTurn` 收尾。
 */
export function startTurn(
  workspaceDir: string,
  input: {
    threadId: string;
    userContent: string;
    idx?: number;
    turnId?: string;
    id?: string;
    startedAt?: string;
    usage?: Record<string, unknown> | null;
    autoTitle?: boolean;
  },
): TurnRecord {
  const threadId = requireNonEmpty(input?.threadId, "threadId");
  const userContent = typeof input.userContent === "string" ? input.userContent : "";
  const thread = requireThreadRow(workspaceDir, threadId);
  const turnId = input.turnId ?? input.id ?? uid();
  const idx = input.idx ?? nextTurnIdx(workspaceDir, threadId);
  const startedAt = input.startedAt ?? nowIso();

  withTransaction(workspaceDir, () => {
    openConversationDb(workspaceDir)
      .prepare(
        `INSERT INTO ${TURNS_TABLE}
           (id, thread_id, idx, user_content, started_at, ended_at, status, usage_json, compacted_by)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, NULL)`,
      )
      .run(
        turnId,
        threadId,
        idx,
        userContent,
        startedAt,
        null,
        input.usage ? JSON.stringify(input.usage) : null,
      );
    insertMessage(workspaceDir, threadId, turnId, {
      role: "human",
      kind: "text",
      content: userContent,
      createdAt: startedAt,
      seq: 0,
    });
    const shouldTitle = input.autoTitle !== false;
    const currentTitle = asString(thread["title"]);
    if (shouldTitle && (currentTitle === null || currentTitle.length === 0)) {
      openConversationDb(workspaceDir)
        .prepare(`UPDATE ${THREADS_TABLE} SET title = ?, updated_at = ? WHERE id = ?`)
        .run(defaultTitleFromUserContent(userContent), startedAt, threadId);
    } else {
      openConversationDb(workspaceDir)
        .prepare(`UPDATE ${THREADS_TABLE} SET updated_at = ? WHERE id = ?`)
        .run(startedAt, threadId);
    }
  });

  const turn = getTurn(workspaceDir, turnId);
  if (!turn) throw new ConversationStoreError("CONVERSATION_DB_ERROR", `轮次写入后读不到: ${turnId}`);
  return turn;
}

/** 追加一条消息（seq 自动递增，或用给定 seq） */
export function appendMessage(
  workspaceDir: string,
  input: NewMessageInput & { threadId: string; turnId: string },
): MessageRecord {
  const threadId = requireNonEmpty(input?.threadId, "threadId");
  const turnId = requireNonEmpty(input?.turnId, "turnId");
  requireThreadRow(workspaceDir, threadId);
  const turn = getTurn(workspaceDir, turnId);
  if (!turn) {
    throw new ConversationStoreError("CONVERSATION_TURN_NOT_FOUND", `轮次不存在: ${turnId}`);
  }
  return insertMessage(workspaceDir, threadId, turnId, input);
}

/** 批量追加消息（保持数组顺序，依次分配 seq） */
export function appendMessages(
  workspaceDir: string,
  threadId: string,
  turnId: string,
  messages: NewMessageInput[],
): MessageRecord[] {
  return withTransaction(workspaceDir, () =>
    messages.map((message) => appendMessage(workspaceDir, { ...message, threadId, turnId })),
  );
}

/** 结束一轮：标记 done / cancelled / error，并更新会话最近活动时间 */
export function finishTurn(
  workspaceDir: string,
  turnId: string,
  patch: {
    status: Exclude<TurnStatus, "running">;
    endedAt?: string;
    usage?: Record<string, unknown> | null;
  },
): TurnRecord {
  const status = assertOneOf(patch?.status, ["done", "cancelled", "error"] as const, "status");
  const turn = getTurn(workspaceDir, turnId);
  if (!turn) {
    throw new ConversationStoreError("CONVERSATION_TURN_NOT_FOUND", `轮次不存在: ${turnId}`);
  }
  const endedAt = patch.endedAt ?? nowIso();
  withTransaction(workspaceDir, () => {
    openConversationDb(workspaceDir)
      .prepare(
        `UPDATE ${TURNS_TABLE} SET status = ?, ended_at = ?,
           usage_json = COALESCE(?, usage_json) WHERE id = ?`,
      )
      .run(status, endedAt, patch.usage ? JSON.stringify(patch.usage) : null, turnId);
    openConversationDb(workspaceDir)
      .prepare(`UPDATE ${THREADS_TABLE} SET updated_at = ? WHERE id = ?`)
      .run(endedAt, turn.threadId);
  });
  const updated = getTurn(workspaceDir, turnId);
  if (!updated) throw new ConversationStoreError("CONVERSATION_DB_ERROR", `轮次更新后读不到: ${turnId}`);
  return updated;
}

/** 标记轮次状态（`finishTurn` 的别名，便于接线时语义直白） */
export function setTurnStatus(
  workspaceDir: string,
  turnId: string,
  status: Exclude<TurnStatus, "running">,
  options: { endedAt?: string; usage?: Record<string, unknown> | null } = {},
): TurnRecord {
  return finishTurn(workspaceDir, turnId, { status, ...options });
}

/** 若轮次被压缩，指向压缩产物（design D4: compacted_by） */
export function setTurnCompactedBy(
  workspaceDir: string,
  turnId: string,
  compactedBy: string | null,
): TurnRecord | null {
  const turn = getTurn(workspaceDir, turnId);
  if (!turn) return null;
  openConversationDb(workspaceDir)
    .prepare(`UPDATE ${TURNS_TABLE} SET compacted_by = ? WHERE id = ?`)
    .run(param(compactedBy), turnId);
  return getTurn(workspaceDir, turnId);
}

/**
 * 一轮原子落库：轮次记录 + 用户输入 + 该轮全部消息，单事务完成。
 * 非流式路径直接用这个；流式路径用 startTurn / appendMessage / finishTurn。
 */
export function recordTurn(workspaceDir: string, input: RecordTurnInput): RecordTurnResult {
  const threadId = requireNonEmpty(input?.threadId, "threadId");
  const userContent = typeof input.userContent === "string" ? input.userContent : "";
  const messages = input.messages ?? [];
  const turnStatus = assertOneOf(input.status ?? "done", TURN_STATUSES, "status");

  return withTransaction(workspaceDir, () => {
    const turn = startTurn(workspaceDir, {
      threadId,
      userContent,
      ...(input.idx !== undefined ? { idx: input.idx } : {}),
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.id !== undefined ? { id: input.id } : {}),
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(input.autoTitle !== undefined ? { autoTitle: input.autoTitle } : {}),
    });
    const stored = messages.map((message) =>
      insertMessage(workspaceDir, threadId, turn.id, message),
    );
    if (turnStatus === "running") {
      return { turn, messages: stored };
    }
    const finished = finishTurn(workspaceDir, turn.id, {
      status: turnStatus,
      ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
    });
    return { turn: finished, messages: stored };
  });
}

// —— 消息读取 ——

/**
 * 读一条会话的全部消息：按 (轮次序号, 本轮内 seq, id) 升序，顺序稳定且可重复。
 * 只返回该会话自己的消息 —— 子会话消息的 thread_id 不同，天然不混入。
 */
export function readThreadMessages(
  workspaceDir: string,
  threadId: string,
  options: { turnIdx?: number; includeToolResults?: boolean } = {},
): MessageRecord[] {
  const db = openConversationDb(workspaceDir);
  const clauses = ["m.thread_id = ?"];
  const values: Array<string | number> = [threadId];
  if (options.turnIdx !== undefined) {
    clauses.push("t.idx = ?");
    values.push(options.turnIdx);
  }
  if (options.includeToolResults === false) {
    clauses.push("m.role <> 'tool'");
  }
  const rows = db
    .prepare(
      `SELECT m.* FROM ${MESSAGES_TABLE} m
       JOIN ${TURNS_TABLE} t ON t.id = m.turn_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY t.idx ASC, m.seq ASC, m.id ASC`,
    )
    .all(...values) as Row[];
  return rows.map(mapMessage);
}

/** 按 (会话, 轮次序号) 读取该轮的消息 */
export function readTurnMessages(
  workspaceDir: string,
  threadId: string,
  turnIdx: number,
): MessageRecord[] {
  return readThreadMessages(workspaceDir, threadId, { turnIdx });
}

/** 某会话的消息条数（可限定轮次） */
export function countThreadMessages(workspaceDir: string, threadId: string): number {
  const row = openConversationDb(workspaceDir)
    .prepare(`SELECT COUNT(*) AS n FROM ${MESSAGES_TABLE} WHERE thread_id = ?`)
    .get(threadId) as Row | undefined;
  return Number(row?.["n"] ?? 0);
}

// —— 删除 ——

function collectDescendants(workspaceDir: string, rootThreadId: string): string[] {
  const db = openConversationDb(workspaceDir);
  const found: string[] = [];
  const queue = [rootThreadId];
  const seen = new Set<string>([rootThreadId]);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const children = db
      .prepare(`SELECT id FROM ${THREADS_TABLE} WHERE parent_thread_id = ?`)
      .all(current) as Row[];
    for (const child of children) {
      const id = String(child["id"]);
      if (!seen.has(id)) {
        seen.add(id);
        found.push(id);
        queue.push(id);
      }
    }
  }
  return found;
}

/**
 * 删除会话，并对「有子会话」的情况做显式处置（spec：父会话删除时子记录可控）：
 * - `childAction: "cascade"`（默认）：连带删除全部后代会话（其 turns/messages 随外键级联）
 * - `childAction: "detach"`：子会话保留为孤儿：parent_thread_id 置空 +
 *   `meta.orphaned=true`，仍可通过 `listOrphanThreads` / 列表检索到，不产生不可达数据
 */
export function deleteThread(
  workspaceDir: string,
  threadId: string,
  options: { childAction?: "cascade" | "detach" } = {},
): DeleteThreadResult {
  const childAction = options.childAction ?? "cascade";
  if (childAction !== "cascade" && childAction !== "detach") {
    throw new ConversationStoreError(
      "CONVERSATION_INVALID_INPUT",
      `childAction 非法：${JSON.stringify(childAction)}`,
    );
  }
  const thread = getThread(workspaceDir, threadId);
  if (!thread) {
    return { deletedThreadIds: [], detachedChildIds: [] };
  }

  const descendants = collectDescendants(workspaceDir, threadId);
  const directChildren = listChildThreads(workspaceDir, threadId).map((child) => child.id);

  if (childAction === "detach") {
    withTransaction(workspaceDir, () => {
      const db = openConversationDb(workspaceDir);
      for (const childId of directChildren) {
        const child = getThread(workspaceDir, childId);
        const meta = { ...(child?.meta ?? {}), orphaned: true, orphanedAt: nowIso() };
        db.prepare(
          `UPDATE ${THREADS_TABLE}
             SET parent_thread_id = NULL, parent_tool_call_id = NULL, meta_json = ?, updated_at = ?
           WHERE id = ?`,
        ).run(JSON.stringify(meta), nowIso(), childId);
      }
      db.prepare(`DELETE FROM ${THREADS_TABLE} WHERE id = ?`).run(threadId);
    });
    return { deletedThreadIds: [threadId], detachedChildIds: directChildren };
  }

  withTransaction(workspaceDir, () => {
    const db = openConversationDb(workspaceDir);
    for (const id of [...descendants].reverse()) {
      db.prepare(`DELETE FROM ${THREADS_TABLE} WHERE id = ?`).run(id);
    }
    db.prepare(`DELETE FROM ${THREADS_TABLE} WHERE id = ?`).run(threadId);
  });
  return { deletedThreadIds: [threadId, ...descendants], detachedChildIds: [] };
}

/** 清空某工作区的全部会话数据（会话 / 轮次 / 消息），保留库文件本身 */
export function deleteAllConversations(workspaceDir: string): number {
  const db = openConversationDb(workspaceDir);
  let deleted = 0;
  withTransaction(workspaceDir, () => {
    db.prepare(`DELETE FROM ${MESSAGES_TABLE}`).run();
    db.prepare(`DELETE FROM ${TURNS_TABLE}`).run();
    const info = db.prepare(`DELETE FROM ${THREADS_TABLE}`).run();
    deleted = Number(info.changes);
  });
  return deleted;
}

export const THREAD_KIND_VALUES = THREAD_KINDS;
export const THREAD_STATUS_VALUES = THREAD_STATUSES;
export const TURN_STATUS_VALUES = TURN_STATUSES;
export const MESSAGE_ROLE_VALUES = MESSAGE_ROLES;