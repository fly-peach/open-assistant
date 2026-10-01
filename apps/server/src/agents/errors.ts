/**
 * Agent 注册表 / 工作区绑定的错误类型（对齐 specs/agent-registry、agent-binding）。
 *
 * 单列一个错误类是为了 HTTP 出口能把「非法标识 / 重名 / 配置非法 / 未绑定 / 绑定的 agent 不存在」
 * 映射成可读的 JSON `{ error, message }`（见 http.ts 的 onError）。
 */
export type AgentErrorCode =
  | "AGENT_INVALID_ID"
  | "AGENT_ALREADY_EXISTS"
  | "AGENT_NOT_FOUND"
  | "AGENT_INVALID_CONFIG"
  | "AGENT_NOT_BOUND";

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly status: number;
  /** 非法配置时指向具体字段（对齐「指出具体字段，不静默用默认值掩盖错误」） */
  readonly field?: string;

  constructor(code: AgentErrorCode, message: string, status = 400, field?: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.status = status;
    if (field !== undefined) this.field = field;
  }
}