/**
 * WebSocket 传输抽象（tasks 13.9）。
 *
 * 为什么要抽出这一层：**长连接的协议逻辑（握手 / 心跳 / 重连 / 去重）必须能测**，
 * 而真实平台凭据在开发机上拿不到。所以把 socket 做成可注入的：
 * 测试注入假 socket，就能完整跑「收到帧 → 解析 → 去重 → 回调」这条链路，
 * 不需要连 QQ / 飞书。
 *
 * 默认实现用全局 `WebSocket`（Node 22+ 与 Bun 都内置，不必引第三方库）。
 */

export interface SocketLike {
  /** 发一个文本帧 */
  send(data: string): void;
  /** 主动关闭 */
  close(code?: number, reason?: string): void;
  /** 注册回调（实现方保证每个回调只触发一次） */
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number | null, reason: string) => void): void;
  onError(handler: (err: Error) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

/** 一个极简的 fetch 形状（便于测试注入假的） */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

/** 默认 socket 工厂：用运行时内置的 WebSocket */
export const defaultSocketFactory: SocketFactory = (url: string) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocket }).WebSocket;
  if (!Ctor) {
    throw new Error(
      "当前运行时没有内置 WebSocket。Node 需要 22+，或显式注入 socketFactory。",
    );
  }
  const ws = new Ctor(url);
  const socket: SocketLike = {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onOpen: (handler) => ws.addEventListener("open", () => handler()),
    onMessage: (handler) =>
      ws.addEventListener("message", (ev: MessageEvent) => {
        const data = (ev as { data?: unknown }).data;
        if (typeof data === "string") handler(data);
        else if (data instanceof Uint8Array) handler(Buffer.from(data).toString("utf8"));
      }),
    onClose: (handler) =>
      ws.addEventListener("close", (ev: CloseEvent) =>
        handler((ev as { code?: number }).code ?? null, (ev as { reason?: string }).reason ?? ""),
      ),
    onError: (handler) =>
      ws.addEventListener("error", () => handler(new Error("WebSocket 连接错误"))),
  };
  return socket;
};

export const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init as RequestInit);
  return { status: res.status, text: () => res.text() };
};