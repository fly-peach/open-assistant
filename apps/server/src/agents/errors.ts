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
  | "AGENT_NOT_BOUND"
  /** 指定的工作区目录不存在 */
  | "WORKSPACE_NOT_FOUND"
  /** 该目录已由另一个 agent 维护（agent ↔ 工作区 1:1，一个目录只能绑一位） */
  | "WORKSPACE_ALREADY_BOUND"
  /** 子 agent 目录名非法（对齐 specs/subagent-team「拒绝非法子 agent 标识」） */
  | "SUBAGENT_INVALID_ID"
  /** 同名子 agent 目录已存在 */
  | "SUBAGENT_ALREADY_EXISTS"
  /** 该子 agent 不存在（无目录 / 无 SPEC.md） */
  | "SUBAGENT_NOT_FOUND"
  /** 声明内容非法（缺 description / mode 非法 / 工具名未知 / 元数据无法解析等），`field` 指向具体字段 */
  | "SUBAGENT_INVALID_SPEC"
  /** 技能名非法（会成为目录名） */
  | "AGENT_INVALID_SKILL"
  /** 同名 agent 私有技能已存在 */
  | "AGENT_SKILL_EXISTS"
  /** 该 agent 私有技能不存在 */
  | "AGENT_SKILL_NOT_FOUND"
  /** 对端 agent 没有可用的工作区（未指定 / 未绑定） */
  | "AGENT_NO_WORKSPACE"
  /** 对端不在发起方的可联系名单里 */
  | "AGENT_NOT_CONTACTABLE"
  /** agent 调用层数超过上限（防递归） */
  | "AGENT_CALL_DEPTH_EXCEEDED"
  /** 对端执行失败（网络 / 图运行异常） */
  | "AGENT_CALL_FAILED"
  /** 主智能体不可删除 */
  | "AGENT_MAIN_PROTECTED";

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