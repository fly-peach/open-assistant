/**
 * 模型配置层的错误类型（对齐 agents/errors.ts 的写法）。
 *
 * 单列一个错误类是为了 HTTP 出口能把「供应商不存在 / 配置非法 / 还没配 key / 上游拒绝」
 * 映射成可读的 JSON `{ error, message }`（见 http.ts 的 onError）。
 */
export type ModelErrorCode =
  | "MODEL_INVALID_PROVIDER_ID"
  | "MODEL_PROVIDER_NOT_FOUND"
  | "MODEL_PROVIDER_EXISTS"
  | "MODEL_PROVIDER_LOCKED"
  | "MODEL_INVALID_CONFIG"
  | "MODEL_NOT_CONFIGURED"
  | "MODEL_UNKNOWN_CAPABILITY"
  | "MODEL_UPSTREAM";

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly status: number;
  /** 非法配置时指向具体字段（对齐「指出具体字段，不静默用默认值掩盖错误」） */
  readonly field?: string;

  constructor(code: ModelErrorCode, message: string, status = 400, field?: string) {
    super(message);
    this.name = "ModelError";
    this.code = code;
    this.status = status;
    if (field !== undefined) this.field = field;
  }
}
