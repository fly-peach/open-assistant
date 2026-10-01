/**
 * 会话库（thread / turn / message 三层）的类型定义。
 *
 * 字段逐字对齐 design D4；`meta_json` 承载 D4 未单列、但 spec 明确要求的
 * 关联信息（对端会话标识、发起方标识、token 用量、模型、标签等），
 * 在 `ThreadRecord` 上以 `peerThreadId` / `initiatorAgentId` /
 * `initiatorThreadId` 的形式暴露。
 */

/** 会话种类：主会话 / 同轮委派的子会话 / 跨工作区调用（本侧记录） */
export type ThreadKind = "main" | "subagent" | "agent-call";

/** 会话状态：活跃 / 已归档 / 出错 */
export type ThreadStatus = "active" | "archived" | "error";

/** 轮次状态：进行中 / 正常结束 / 被取消 / 出错 */
export type TurnStatus = "running" | "done" | "cancelled" | "error";

/** 消息角色 */
export type MessageRole = "human" | "ai" | "tool";

/** 消息细分类型（text / reasoning / tool-call / tool-result …） */
export type MessageKind = string;

export interface ThreadRecord {
  id: string;
  agentId: string;
  kind: ThreadKind;
  parentThreadId: string | null;
  parentToolCallId: string | null;
  peerAgentId: string | null;
  title: string | null;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  /** `meta_json` 解析结果（解析失败时为 null） */
  meta: Record<string, unknown> | null;
  /** 跨工作区调用时，本侧记录指向的对端会话标识（存在 meta.peerThreadId） */
  peerThreadId: string | null;
  /** 对端工作区中「被调用会话」记录的发起方 agent（存在 meta.initiatorAgentId） */
  initiatorAgentId: string | null;
  /** 对端工作区中「被调用会话」记录的发起方会话标识（存在 meta.initiatorThreadId） */
  initiatorThreadId: string | null;
}

/** 会话列表项：会话 + 计数摘要（列表单位是会话，不是轮次/消息） */
export interface ThreadSummary extends ThreadRecord {
  turnCount: number;
  messageCount: number;
  /** 最近活动时间（当前实现等于 updatedAt；保留独立字段以便将来区分） */
  lastActivityAt: string;
  /** 该会话中未正常结束的轮次数（running / cancelled / error） */
  unfinishedTurnCount: number;
}

export interface TurnRecord {
  id: string;
  threadId: string;
  idx: number;
  userContent: string;
  startedAt: string | null;
  endedAt: string | null;
  status: TurnStatus;
  usage: Record<string, unknown> | null;
  compactedBy: string | null;
}

export interface MessageRecord {
  id: string;
  threadId: string;
  turnId: string;
  seq: number;
  role: MessageRole;
  kind: MessageKind | null;
  content: string | null;
  toolName: string | null;
  toolCallId: string | null;
  namespace: string | null;
  createdAt: string;
  tokens: number | null;
}

/** 写入一条消息时的输入（seq 省略则在本轮内自增；id 省略则生成 uuid） */
export interface NewMessageInput {
  id?: string;
  seq?: number;
  role: MessageRole;
  kind?: string | null;
  content?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  namespace?: string | null;
  createdAt?: string;
  tokens?: number | null;
}

export interface CreateThreadInput {
  id?: string;
  agentId: string;
  kind?: ThreadKind;
  parentThreadId?: string | null;
  parentToolCallId?: string | null;
  peerAgentId?: string | null;
  /** 跨工作区调用时对端工作区里的会话标识（写入 meta.peerThreadId） */
  peerThreadId?: string | null;
  /** 被调用侧：发起方 agent（写入 meta.initiatorAgentId） */
  initiatorAgentId?: string | null;
  /** 被调用侧：发起方会话标识（写入 meta.initiatorThreadId） */
  initiatorThreadId?: string | null;
  title?: string | null;
  status?: ThreadStatus;
  createdAt?: string;
  updatedAt?: string;
  meta?: Record<string, unknown> | null;
}

export interface UpdateThreadPatch {
  title?: string | null;
  status?: ThreadStatus;
  meta?: Record<string, unknown> | null;
  /** 仅更新 meta 中的这些键（其余键保留） */
  metaPatch?: Record<string, unknown>;
  updatedAt?: string;
}

export interface ListThreadsOptions {
  /** 默认 `["main"]`：列表单位是会话，子会话默认不混进顶层列表 */
  kinds?: ThreadKind[];
  /** 默认不过滤（活跃 + 已归档 + 出错一并返回） */
  statuses?: ThreadStatus[];
  agentId?: string;
  parentThreadId?: string | null;
  limit?: number;
  offset?: number;
}

export interface RecordTurnInput {
  threadId: string;
  userContent: string;
  /** 省略则用该会话 max(idx)+1 */
  idx?: number;
  turnId?: string;
  id?: string;
  messages?: NewMessageInput[];
  status?: TurnStatus;
  startedAt?: string;
  endedAt?: string;
  usage?: Record<string, unknown> | null;
  /** 会话暂无标题时用首条用户输入生成默认标题；传 false 可关闭 */
  autoTitle?: boolean;
}

export interface RecordTurnResult {
  turn: TurnRecord;
  messages: MessageRecord[];
}

export interface DeleteThreadResult {
  deletedThreadIds: string[];
  detachedChildIds: string[];
}

export type ConversationErrorCode =
  | "CONVERSATION_THREAD_NOT_FOUND"
  | "CONVERSATION_TURN_NOT_FOUND"
  | "CONVERSATION_INVALID_INPUT"
  | "CONVERSATION_DB_ERROR";

export class ConversationStoreError extends Error {
  readonly code: ConversationErrorCode;

  constructor(code: ConversationErrorCode, message: string) {
    super(message);
    this.name = "ConversationStoreError";
    this.code = code;
  }
}