/**
 * 与 OpenAI 兼容端点直接对话的极简客户端（**只用于配置页**，不在对话链路上）。
 *
 * 对话链路走 LangChain 的 `RobustChatOpenAI`（见 model.ts）；这里直接用 `fetch`
 * 是因为三件事都不适合塞进 LangChain：
 *
 * 1. **连通性测试**：只需要一次最小请求拿延迟与回显，不需要 agent 那一整套；
 * 2. **拉远端模型清单**：`GET /models` 不是 chat 接口；
 * 3. **视觉探针**：要发 `image_url` 多模态消息，还要精确控制超时与重试次数。
 *
 * 全部函数都**不抛异常**，统一返回 `{ ok, ... }` —— 配置页要把「失败原因」
 * 原样展示给用户（是 key 错、URL 错、还是没有这个模型），而不是一句「请求失败」。
 */
import { ModelError } from "./errors.js";

/** 去掉结尾斜杠：`https://x/v1/` 与 `https://x/v1` 是同一个端点 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** 校验 baseUrl 形状（必须是 http/https；不校验可达性） */
export function assertBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ModelError("MODEL_INVALID_CONFIG", "baseUrl 不能为空", 400, "baseUrl");
  }
  const url = normalizeBaseUrl(raw);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ModelError("MODEL_INVALID_CONFIG", `baseUrl 不是合法 URL：${raw}`, 400, "baseUrl");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ModelError(
      "MODEL_INVALID_CONFIG",
      `baseUrl 只支持 http/https（收到 ${parsed.protocol}）`,
      400,
      "baseUrl",
    );
  }
  return url;
}

export interface UpstreamResult {
  ok: boolean;
  status: number;
  /** 模型回复的纯文本（失败时是空串） */
  text: string;
  /** 失败说明（网络错误 / 上游 error.message / HTTP 状态） */
  error?: string;
  /** 原始响应体（排障用，已截断） */
  raw?: string;
}

export interface ChatCompletionInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  headers?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 把上游错误体压成一句人话 */
function describeFailure(status: number, body: unknown): string {
  if (status === 401 || status === 403) return `鉴权失败（HTTP ${status}）：请检查 API Key 是否有权访问该模型`;
  if (status === 404) return `端点上没有这个模型或路径不存在（HTTP 404）：确认 baseUrl 与模型 id`;
  const record = (body ?? {}) as Record<string, unknown>;
  const err = record["error"];
  if (typeof err === "string") return `HTTP ${status}：${err}`;
  if (err && typeof err === "object") {
    const message = (err as Record<string, unknown>)["message"];
    if (typeof message === "string") return `HTTP ${status}：${message}`;
  }
  const message = record["message"];
  if (typeof message === "string") return `HTTP ${status}：${message}`;
  return `HTTP ${status}`;
}

/** 一次非流式 chat completion；任何异常都收敛成 `{ ok: false }` */
export async function chatCompletion(input: ChatCompletionInput): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);
  const onOuterAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const res = await fetch(`${normalizeBaseUrl(input.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`,
        ...(input.headers ?? {}),
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        stream: false,
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        text: "",
        error: describeFailure(res.status, body),
        raw: text.slice(0, 800),
      };
    }

    const choices = (body as { choices?: unknown })?.choices;
    const message = Array.isArray(choices)
      ? ((choices[0] as { message?: { content?: unknown } })?.message?.content ?? "")
      : "";
    const content =
      typeof message === "string"
        ? message
        : Array.isArray(message)
          ? message
              .map((part) =>
                typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
                  ? (part as { text: string }).text
                  : "",
              )
              .join("")
          : "";
    return { ok: true, status: res.status, text: content, raw: text.slice(0, 800) };
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    return {
      ok: false,
      status: 0,
      text: "",
      error: aborted
        ? `请求超时（${input.timeoutMs ?? 20_000}ms）或已取消`
        : `网络错误：${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export interface RemoteModelsResult {
  ok: boolean;
  models: string[];
  error?: string;
}

/** 拉远端模型清单（`GET /models`）；失败不抛，交给调用方决定是否只用手工清单 */
export async function listRemoteModels(input: {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<RemoteModelsResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`${normalizeBaseUrl(input.baseUrl)}/models`, {
      headers: { Authorization: `Bearer ${input.apiKey}`, ...(input.headers ?? {}) },
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) return { ok: false, models: [], error: describeFailure(res.status, body) };
    const data = (body as { data?: unknown })?.data;
    const ids = Array.isArray(data)
      ? data
          .map((item) =>
            typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string"
              ? (item as { id: string }).id
              : null,
          )
          .filter((id): id is string => Boolean(id))
      : [];
    return { ok: true, models: ids.sort() };
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    return {
      ok: false,
      models: [],
      error: aborted ? `请求超时（${input.timeoutMs ?? 15_000}ms）` : `网络错误：${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
