/**
 * 会话库建表（design D4 的三张表 + 索引）。
 *
 * 用 `PRAGMA user_version` 做迁移版本；当前只有 v1。
 * 所有 DDL 都是 `IF NOT EXISTS`，重复打开幂等。
 */

// —— 表名（测试与后续 agent 直接引用，避免散落字符串字面量） ——
export const THREADS_TABLE = "threads";
export const TURNS_TABLE = "turns";
export const MESSAGES_TABLE = "messages";

// —— 索引名 ——
export const THREADS_UPDATED_INDEX = "idx_threads_updated_at";
export const THREADS_PARENT_INDEX = "idx_threads_parent";
export const THREADS_AGENT_INDEX = "idx_threads_agent";
export const TURNS_THREAD_IDX_INDEX = "idx_turns_thread_idx";
export const MESSAGES_THREAD_SEQ_INDEX = "idx_messages_thread_seq";
export const MESSAGES_TOOL_CALL_INDEX = "idx_messages_tool_call_id";
export const MESSAGES_TURN_INDEX = "idx_messages_turn";

/** 当前 schema 版本 */
export const CONVERSATION_SCHEMA_VERSION = 1;

/** v1 DDL（字段逐字对齐 design D4，顺序也保持一致） */
export const CONVERSATION_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS ${THREADS_TABLE} (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_thread_id TEXT,
  parent_tool_call_id TEXT,
  peer_agent_id TEXT,
  title TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  meta_json TEXT
);

CREATE TABLE IF NOT EXISTS ${TURNS_TABLE} (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES ${THREADS_TABLE}(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  user_content TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  status TEXT NOT NULL,
  usage_json TEXT,
  compacted_by TEXT
);

CREATE TABLE IF NOT EXISTS ${MESSAGES_TABLE} (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES ${THREADS_TABLE}(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES ${TURNS_TABLE}(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  kind TEXT,
  content TEXT,
  tool_name TEXT,
  tool_call_id TEXT,
  namespace TEXT,
  created_at TEXT NOT NULL,
  tokens INTEGER
);

CREATE INDEX IF NOT EXISTS ${THREADS_UPDATED_INDEX} ON ${THREADS_TABLE}(updated_at);
CREATE INDEX IF NOT EXISTS ${THREADS_PARENT_INDEX} ON ${THREADS_TABLE}(parent_thread_id);
CREATE INDEX IF NOT EXISTS ${THREADS_AGENT_INDEX} ON ${THREADS_TABLE}(agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS ${TURNS_THREAD_IDX_INDEX} ON ${TURNS_TABLE}(thread_id, idx);
CREATE INDEX IF NOT EXISTS ${MESSAGES_THREAD_SEQ_INDEX} ON ${MESSAGES_TABLE}(thread_id, seq);
CREATE INDEX IF NOT EXISTS ${MESSAGES_TOOL_CALL_INDEX} ON ${MESSAGES_TABLE}(tool_call_id);
CREATE INDEX IF NOT EXISTS ${MESSAGES_TURN_INDEX} ON ${MESSAGES_TABLE}(turn_id);
`;

/** 期望的列定义（测试据此断言「字段照 D4」） */
export const EXPECTED_COLUMNS: Record<string, string[]> = {
  [THREADS_TABLE]: [
    "id",
    "agent_id",
    "kind",
    "parent_thread_id",
    "parent_tool_call_id",
    "peer_agent_id",
    "title",
    "status",
    "created_at",
    "updated_at",
    "meta_json",
  ],
  [TURNS_TABLE]: [
    "id",
    "thread_id",
    "idx",
    "user_content",
    "started_at",
    "ended_at",
    "status",
    "usage_json",
    "compacted_by",
  ],
  [MESSAGES_TABLE]: [
    "id",
    "thread_id",
    "turn_id",
    "seq",
    "role",
    "kind",
    "content",
    "tool_name",
    "tool_call_id",
    "namespace",
    "created_at",
    "tokens",
  ],
};

export const EXPECTED_INDEXES = [
  THREADS_UPDATED_INDEX,
  THREADS_PARENT_INDEX,
  THREADS_AGENT_INDEX,
  TURNS_THREAD_IDX_INDEX,
  MESSAGES_THREAD_SEQ_INDEX,
  MESSAGES_TOOL_CALL_INDEX,
  MESSAGES_TURN_INDEX,
];

/** 所有表名（测试断言用） */
export const EXPECTED_TABLES = [THREADS_TABLE, TURNS_TABLE, MESSAGES_TABLE];

export interface MinimalDb {
  exec(sql: string): void;
}

/**
 * 建表 / 升级到当前 schema 版本。幂等，可重复调用。
 * 通过 `PRAGMA user_version` 记录版本，为将来迁移留出入口。
 */
export function applyConversationSchema(db: MinimalDb): void {
  db.exec(CONVERSATION_SCHEMA_V1);
  db.exec(`PRAGMA user_version = ${CONVERSATION_SCHEMA_VERSION};`);
}