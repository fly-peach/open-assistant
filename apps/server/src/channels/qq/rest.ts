/**
 * QQ REST 客户端（task 13.9 的发送侧）。
 *
 * 三件事：取 access token（带缓存与提前续期）→ 取网关地址 → 调各业务接口发消息。
 * 全部通过注入的 `FetchLike` 走，测试能完全离线跑。
 */
import {
  QQ_DEFAULT_API_BASE,
  QQ_TOKEN_URL,
  parseGatewayResponse,
  parseTokenResponse,
  qqAuthHeader,
  QqProtocolError,
} from "./protocol.js";
import { defaultFetch, type FetchLike } from "../transport.js";

export interface QqRestOptions {
  appId: string;
  clientSecret: string;
  /** 国内用默认值；沙箱或自建代理可覆盖 */
  apiBase?: string;
  tokenUrl?: string;
  fetchImpl?: FetchLike;
  /** 注入时钟，便于测试过期续期 */
  now?: () => number;
}

export interface QqRest {
  getAccessToken(): Promise<string>;
  getGatewayUrl(): Promise<string>;
  apiRequest(method: string, path: string, body?: unknown): Promise<Record<string, unknown>>;
  /** 发一条消息；`replyTo` 是平台的消息 id（被动回复必须带） */
  sendMessage(input: {
    /** 形如 `/v2/users/{openid}/messages` 或 `/v2/groups/{group_openid}/messages` */
    path: string;
    content: string;
    replyTo?: string;
    /** 被动回复的序号（平台要求同一消息的多条回复递增，否则重复被拒） */
    msgSeq?: number;
  }): Promise<Record<string, unknown>>;
}

/** token 提前多少毫秒续期（避免边界上刚好过期） */
const TOKEN_REFRESH_SKEW_MS = 60_000;

export function createQqRest(options: QqRestOptions): QqRest {
  const apiBase = (options.apiBase ?? QQ_DEFAULT_API_BASE).replace(/\/+$/, "");
  const tokenUrl = options.tokenUrl ?? QQ_TOKEN_URL;
  const doFetch = options.fetchImpl ?? defaultFetch;
  const now = options.now ?? (() => Date.now());

  let cachedToken: string | null = null;
  let expiresAtMs = 0;

  async function fetchAccessToken(): Promise<string> {
    const res = await doFetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: options.appId, clientSecret: options.clientSecret }),
    });
    const body = await res.text();
    const { accessToken, expiresInSec } = parseTokenResponse(res.status, body);
    cachedToken = accessToken;
    expiresAtMs = now() + expiresInSec * 1000;
    return accessToken;
  }

  async function getAccessToken(): Promise<string> {
    if (cachedToken && now() < expiresAtMs - TOKEN_REFRESH_SKEW_MS) return cachedToken;
    return fetchAccessToken();
  }

  async function getGatewayUrl(): Promise<string> {
    const token = await getAccessToken();
    const res = await doFetch(`${apiBase}/gateway`, { method: "GET", headers: qqAuthHeader(token) });
    return parseGatewayResponse(res.status, await res.text());
  }

  async function apiRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const token = await getAccessToken();
    const res = await doFetch(`${apiBase}${path}`, {
      method,
      headers: qqAuthHeader(token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await res.text();
    let data: Record<string, unknown> = {};
    if (raw && raw.trim().length > 0) {
      try {
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }
    if (res.status >= 400) {
      throw new QqProtocolError(
        "QQ_API_ERROR",
        `QQ 接口调用失败：${method} ${path} → HTTP ${res.status}${describeApiError(data)}`,
        raw.slice(0, 300),
      );
    }
    return data;
  }

  async function sendMessage(input: {
    path: string;
    content: string;
    replyTo?: string;
    msgSeq?: number;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { content: input.content, msg_type: 0 };
    if (input.replyTo) {
      body["msg_id"] = input.replyTo;
      // 平台要求同一被动消息的多条回复 seq 递增，否则后一条被拒
      if (typeof input.msgSeq === "number") body["msg_seq"] = input.msgSeq;
    }
    return apiRequest("POST", input.path, body);
  }

  return { getAccessToken, getGatewayUrl, apiRequest, sendMessage };
}

/** 把平台错误拼成可读后缀（QQ 的 markdown 限制等常见错一眼能认出） */
function describeApiError(data: Record<string, unknown>): string {
  const code = data["code"] ?? data["err_code"];
  const message = data["message"] ?? data["err_msg"];
  const parts: string[] = [];
  if (code !== undefined) parts.push(`code=${String(code)}`);
  if (message !== undefined) parts.push(String(message));
  if (parts.length === 0) return "";
  const hint =
    String(message ?? "").includes("markdown") || String(code ?? "") === "40034012"
      ? "（该会话不允许原生 markdown，请关闭 markdown 或改用纯文本）"
      : "";
  return `：${parts.join(" ")}${hint}`;
}