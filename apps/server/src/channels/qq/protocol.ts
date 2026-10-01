/**
 * QQ 机器人协议层（task 13.9）—— **纯函数**，照 QwenPaw `app/channels/qq/channel.py` 搬运。
 *
 * 协议要点（实读自 QwenPaw）：
 * - 取凭据：`POST https://bots.qq.com/app/getAppAccessToken`，body `{appId, clientSecret}`
 * - 取网关：`GET {apiBase}/gateway`，头 `Authorization: QQBot {access_token}` → `{url}`
 * - 连接后收 `HELLO`（op 10）拿到 `heartbeat_interval`（默认 45000）
 * - 发 `IDENTIFY`（op 2）带 intents；之后按间隔发 `HEARTBEAT`（op 1），收 `HEARTBEAT_ACK`（op 11）
 * - 事件是 `DISPATCH`（op 0）：`{id, t, d}` —— `id` 就是去重用的平台事件标识
 * - 服务端可能要求 `RECONNECT`（7）/ `INVALID_SESSION`（9）
 * - **重连延迟是离散台阶**（不是指数）：`[1,2,5,10,30,60]` 秒；被限流另有 60 秒
 * - 连续「刚连上就断」超过阈值 → 判定会话失效，重新 IDENTIFY 而不是 RESUME
 */
import type { ChannelError } from "../store.js";

export const QQ_OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export const QQ_INTENT = {
  GUILD_MEMBERS: 1 << 1,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
  INTERACTION: 1 << 26,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
} as const;

/** 重连延迟台阶（秒）—— 照 QwenPaw 的 `RECONNECT_DELAYS` */
export const QQ_RECONNECT_DELAYS_SEC = [1, 2, 5, 10, 30, 60] as const;
/** 被限流时的额外等待（秒） */
export const QQ_RATE_LIMIT_DELAY_SEC = 60;
/** 连续「快速断开」多少次就判定会话失效，改为重新 IDENTIFY */
export const QQ_QUICK_DISCONNECT_THRESHOLD = 5;
/** 多久之内断开算「快速断开」（毫秒） */
export const QQ_QUICK_DISCONNECT_MS = 5000;

export const QQ_DEFAULT_API_BASE = "https://api.sgroup.qq.com";
export const QQ_SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";
export const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
export const QQ_DEFAULT_HEARTBEAT_INTERVAL_MS = 45000;

/** 需要的 intents：公域消息 + 成员 + 交互，私信与群聊按需再加 */
export function qqIntents(options: { includeDirect?: boolean } = {}): number {
  let intents = QQ_INTENT.PUBLIC_GUILD_MESSAGES | QQ_INTENT.GUILD_MEMBERS | QQ_INTENT.INTERACTION;
  if (options.includeDirect !== false) {
    intents |= QQ_INTENT.DIRECT_MESSAGE | QQ_INTENT.GROUP_AND_C2C;
  }
  return intents;
}

/** 第 n 次（从 0 开始）重连应等多少毫秒 —— 离散台阶，最后一次封顶 */
export function qqReconnectDelayMs(attempt: number, rateLimited = false): number {
  if (rateLimited) return QQ_RATE_LIMIT_DELAY_SEC * 1000;
  const idx = Math.max(0, Math.min(attempt, QQ_RECONNECT_DELAYS_SEC.length - 1));
  return QQ_RECONNECT_DELAYS_SEC[idx]! * 1000;
}

/**
 * 是否应当改用「重新 IDENTIFY」而不是「RESUME」。
 * 连续快速断开次数到阈值 → 会话多半已失效，RESUME 会一直被拒。
 */
export function shouldResetSession(quickDisconnects: number): boolean {
  return quickDisconnects >= QQ_QUICK_DISCONNECT_THRESHOLD;
}

export interface QqFrame<T = unknown> {
  op: number;
  /** 事件类型（仅 DISPATCH 有），如 `GROUP_AT_MESSAGE_CREATE` */
  t?: string;
  /** 平台事件标识 —— **去重就靠它** */
  id?: string;
  /** 序号，用于心跳与 RESUME */
  s?: number;
  d?: T;
}

/** 解析一帧；不是合法 JSON 或缺 op → null（调用方忽略该帧） */
export function parseQqFrame(raw: string): QqFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const frame = parsed as Partial<QqFrame>;
  if (typeof frame.op !== "number") return null;
  return frame as QqFrame;
}

export function buildIdentifyPayload(accessToken: string, intents: number) {
  return {
    op: QQ_OP.IDENTIFY,
    d: {
      token: `QQBot ${accessToken}`,
      intents,
      shard: [0, 1],
      properties: {},
    },
  };
}

export function buildHeartbeatPayload(lastSeq: number | null) {
  return { op: QQ_OP.HEARTBEAT, d: lastSeq ?? null };
}

export function buildResumePayload(accessToken: string, sessionId: string, lastSeq: number | null) {
  return {
    op: QQ_OP.RESUME,
    d: { token: `QQBot ${accessToken}`, session_id: sessionId, seq: lastSeq ?? 0 },
  };
}

/** 从 HELLO 帧里取心跳间隔，异常值回落到默认 */
export function heartbeatIntervalFromHello(frame: QqFrame<{ heartbeat_interval?: unknown }>): number {
  const raw = frame.d?.heartbeat_interval;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1000) return raw;
  return QQ_DEFAULT_HEARTBEAT_INTERVAL_MS;
}

/** 取鉴权头 */
export function qqAuthHeader(accessToken: string): Record<string, string> {
  return { Authorization: `QQBot ${accessToken}`, "Content-Type": "application/json" };
}

/**
 * 从取令牌响应里解出 access_token / 过期秒数。
 * 平台把错误也放在 200 响应里（如 `{code: 100007}`），所以**不能只看 HTTP 状态**。
 */
export function parseTokenResponse(
  status: number,
  body: string,
): { accessToken: string; expiresInSec: number } {
  if (status >= 400) {
    throw new QqProtocolError("QQ_TOKEN_HTTP", `取 access token 失败：HTTP ${status}`, body);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new QqProtocolError("QQ_TOKEN_BAD_BODY", "取 access token 的响应不是合法 JSON", body);
  }
  const obj = parsed as { access_token?: unknown; expires_in?: unknown; code?: unknown; message?: unknown };
  if (typeof obj.access_token !== "string" || obj.access_token.length === 0) {
    const code = typeof obj.code === "number" ? obj.code : "-";
    const msg = typeof obj.message === "string" ? obj.message : body.slice(0, 200);
    throw new QqProtocolError(
      "QQ_TOKEN_REJECTED",
      `QQ 拒绝了凭据（code=${code}）：${msg}。请检查 AppID 与客户端密钥是否正确。`,
      body,
    );
  }
  const expires = Number(obj.expires_in);
  return {
    accessToken: obj.access_token,
    expiresInSec: Number.isFinite(expires) && expires > 0 ? expires : 7200,
  };
}

/** 从取网关响应里解出 wss 地址 */
export function parseGatewayResponse(status: number, body: string): string {
  if (status >= 400) {
    throw new QqProtocolError("QQ_GATEWAY_HTTP", `取网关地址失败：HTTP ${status}`, body);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new QqProtocolError("QQ_GATEWAY_BAD_BODY", "取网关地址的响应不是合法 JSON", body);
  }
  const url = (parsed as { url?: unknown }).url;
  if (typeof url !== "string" || url.length === 0) {
    throw new QqProtocolError("QQ_GATEWAY_NO_URL", "取网关地址的响应里没有 url", body);
  }
  return url;
}

export class QqProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "QqProtocolError";
  }
}

/** 便于上层统一处理的类型别名（保持与 ChannelError 同名形状） */
export type _ChannelErrorLike = ChannelError;