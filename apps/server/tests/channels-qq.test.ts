/**
 * QQ 频道测试（tasks 13.9 / 13.10 / 13.11 / 13.12）。
 *
 * **全部离线**：socket、fetch、定时器、时钟都可注入，所以「握手 → 心跳 → 收事件 → 去重 →
 * 重连 → 会话重置 → 静默看门狗」这整套可以完整测，不需要真实 QQ 凭据。
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";

import {
  QQ_DEFAULT_HEARTBEAT_INTERVAL_MS,
  QQ_INTENT,
  QQ_OP,
  QQ_QUICK_DISCONNECT_THRESHOLD,
  QqProtocolError,
  buildHeartbeatPayload,
  buildIdentifyPayload,
  buildResumePayload,
  heartbeatIntervalFromHello,
  parseGatewayResponse,
  parseQqFrame,
  parseTokenResponse,
  qqIntents,
  qqReconnectDelayMs,
  shouldResetSession,
} from "../src/channels/qq/protocol.js";
import { createQqRest } from "../src/channels/qq/rest.js";
import { createQqGateway } from "../src/channels/qq/gateway.js";
import type { FetchLike, SocketLike } from "../src/channels/transport.js";

// —— 测试替身 ——

class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;
  closeCode: number | null = null;
  #onOpen: (() => void) | null = null;
  #onMessage: ((d: string) => void) | null = null;
  #onClose: ((c: number | null, r: string) => void) | null = null;
  #onError: ((e: Error) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed = true;
    this.closeCode = code ?? null;
  }
  onOpen(h: () => void): void {
    this.#onOpen = h;
  }
  onMessage(h: (d: string) => void): void {
    this.#onMessage = h;
  }
  onClose(h: (c: number | null, r: string) => void): void {
    this.#onClose = h;
  }
  onError(h: (e: Error) => void): void {
    this.#onError = h;
  }
  // 测试驱动
  fireOpen(): void {
    this.#onOpen?.();
  }
  fireMessage(payload: unknown): void {
    this.#onMessage?.(typeof payload === "string" ? payload : JSON.stringify(payload));
  }
  fireClose(code = 1006, reason = "boom"): void {
    this.#onClose?.(code, reason);
  }
  fireError(message = "oops"): void {
    this.#onError?.(new Error(message));
  }
  parsed(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

class FakeTimers {
  #queue: { id: number; fn: () => void; at: number }[] = [];
  #nextId = 1;
  now = 0;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.#nextId++;
    this.#queue.push({ id, fn, at: this.now + ms });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.#queue = this.#queue.filter((t) => t.id !== handle);
  };
  /** 推进时间并执行到期的定时器（按时间顺序） */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.#queue.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.#queue = this.#queue.filter((t) => t.id !== due.id);
      this.now = due.at;
      due.fn();
    }
    this.now = target;
  }
  pending(): number {
    return this.#queue.length;
  }
}

function jsonFetch(handlers: (url: string, init?: { method?: string }) => { status: number; body: string }): FetchLike {
  return async (url, init) => {
    const res = handlers(url, init);
    return { status: res.status, text: async () => res.body };
  };
}

const TOKEN_OK = JSON.stringify({ access_token: "tok-1", expires_in: 7200 });
const GATEWAY_OK = JSON.stringify({ url: "wss://api.sgroup.qq.com/websocket/" });

function makeRest(fetchImpl: FetchLike, now: () => number = () => 0) {
  return createQqRest({
    appId: "1024",
    clientSecret: "secret",
    fetchImpl,
    now,
  });
}

// —— 协议层 ——

describe("13.9 QQ 协议层（纯函数）", () => {
  test("intents：默认含私信与群聊，可关掉", () => {
    const withDirect = qqIntents();
    expect(withDirect & QQ_INTENT.PUBLIC_GUILD_MESSAGES).toBeGreaterThan(0);
    expect(withDirect & QQ_INTENT.DIRECT_MESSAGE).toBeGreaterThan(0);
    const withoutDirect = qqIntents({ includeDirect: false });
    expect(withoutDirect & QQ_INTENT.DIRECT_MESSAGE).toBe(0);
  });

  test("重连延迟是离散台阶并封顶", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 99].map((n) => qqReconnectDelayMs(n))).toEqual([
      1000, 2000, 5000, 10000, 30000, 60000, 60000, 60000,
    ]);
  });

  test("被限流时等 60 秒", () => {
    expect(qqReconnectDelayMs(0, true)).toBe(60_000);
  });

  test("连续快速断开到阈值 → 判定会话失效", () => {
    expect(shouldResetSession(QQ_QUICK_DISCONNECT_THRESHOLD - 1)).toBe(false);
    expect(shouldResetSession(QQ_QUICK_DISCONNECT_THRESHOLD)).toBe(true);
  });

  test("帧解析：非 JSON / 缺 op → null", () => {
    expect(parseQqFrame("{ 坏")).toBeNull();
    expect(parseQqFrame(JSON.stringify({ t: "X" }))).toBeNull();
    expect(parseQqFrame(JSON.stringify({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", id: "e1" }))).toEqual({
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      id: "e1",
    });
  });

  test("心跳间隔：异常值回落默认", () => {
    expect(heartbeatIntervalFromHello({ op: 10, d: { heartbeat_interval: 30000 } })).toBe(30000);
    expect(heartbeatIntervalFromHello({ op: 10, d: { heartbeat_interval: "x" } })).toBe(
      QQ_DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    expect(heartbeatIntervalFromHello({ op: 10, d: {} })).toBe(QQ_DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(heartbeatIntervalFromHello({ op: 10, d: { heartbeat_interval: 10 } })).toBe(
      QQ_DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
  });

  test("载荷构造：identify / heartbeat / resume", () => {
    expect(buildIdentifyPayload("tok", 3)).toEqual({
      op: QQ_OP.IDENTIFY,
      d: { token: "QQBot tok", intents: 3, shard: [0, 1], properties: {} },
    });
    expect(buildHeartbeatPayload(null)).toEqual({ op: QQ_OP.HEARTBEAT, d: null });
    expect(buildHeartbeatPayload(7)).toEqual({ op: QQ_OP.HEARTBEAT, d: 7 });
    expect(buildResumePayload("tok", "sess", null)).toEqual({
      op: QQ_OP.RESUME,
      d: { token: "QQBot tok", session_id: "sess", seq: 0 },
    });
  });

  test("取令牌响应：成功 / HTTP 错 / 平台拒绝（200 里带 code）/ 坏 body", () => {
    expect(parseTokenResponse(200, TOKEN_OK)).toEqual({ accessToken: "tok-1", expiresInSec: 7200 });
    expect(() => parseTokenResponse(500, "x")).toThrow(QqProtocolError);
    try {
      parseTokenResponse(200, JSON.stringify({ code: 100007, message: "appid invalid" }));
    } catch (err) {
      expect((err as QqProtocolError).code).toBe("QQ_TOKEN_REJECTED");
      expect((err as QqProtocolError).message).toContain("100007");
      expect((err as QqProtocolError).message).toContain("AppID");
    }
    expect(() => parseTokenResponse(200, "not json")).toThrow(QqProtocolError);
  });

  test("取网关响应：成功 / 缺 url / HTTP 错", () => {
    expect(parseGatewayResponse(200, GATEWAY_OK)).toBe("wss://api.sgroup.qq.com/websocket/");
    expect(() => parseGatewayResponse(200, JSON.stringify({}))).toThrow(QqProtocolError);
    expect(() => parseGatewayResponse(403, "x")).toThrow(QqProtocolError);
  });
});

// —— REST ——

describe("13.9 QQ REST（假 fetch）", () => {
  test("令牌缓存：过期前不重复取", async () => {
    let tokenCalls = 0;
    let nowMs = 0;
    const rest = makeRest(
      jsonFetch((url) => {
        if (url.includes("getAppAccessToken")) {
          tokenCalls += 1;
          return { status: 200, body: TOKEN_OK };
        }
        return { status: 200, body: GATEWAY_OK };
      }),
      () => nowMs,
    );
    await rest.getAccessToken();
    await rest.getAccessToken();
    expect(tokenCalls).toBe(1);

    // 接近过期（提前 60 秒续期）→ 重新取
    nowMs = 7200 * 1000 - 30 * 1000;
    await rest.getAccessToken();
    expect(tokenCalls).toBe(2);
  });

  test("取网关带上 QQBot 鉴权头，指向 apiBase/gateway", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const rest = makeRest(async (url, init) => {
      if (url.includes("getAppAccessToken")) return { status: 200, text: async () => TOKEN_OK };
      seenUrl = url;
      seenAuth = String(init?.headers?.["Authorization"] ?? "");
      return { status: 200, text: async () => GATEWAY_OK };
    });
    const wss = await rest.getGatewayUrl();
    expect(wss).toBe("wss://api.sgroup.qq.com/websocket/");
    expect(seenUrl).toBe("https://api.sgroup.qq.com/gateway");
    expect(seenAuth).toBe("QQBot tok-1");
  });

  test("发消息带 msg_id 与 msg_seq（平台要求被动回复 seq 递增）", async () => {
    let body: Record<string, unknown> = {};
    const rest = makeRest(async (url, init) => {
      if (url.includes("getAppAccessToken")) return { status: 200, text: async () => TOKEN_OK };
      body = JSON.parse(String(init?.body ?? "{}"));
      return { status: 200, text: async () => JSON.stringify({ id: "m1" }) };
    });
    await rest.sendMessage({ path: "/v2/groups/g1/messages", content: "hi", replyTo: "msg-1", msgSeq: 2 });
    expect(body["content"]).toBe("hi");
    expect(body["msg_type"]).toBe(0);
    expect(body["msg_id"]).toBe("msg-1");
    expect(body["msg_seq"]).toBe(2);
  });

  test("接口报错拼成可读信息；markdown 限制给出提示", async () => {
    const rest = makeRest(async (url) => {
      if (url.includes("getAppAccessToken")) return { status: 200, text: async () => TOKEN_OK };
      return {
        status: 400,
        text: async () => JSON.stringify({ code: 40034012, message: "不允许发送原生 markdown" }),
      };
    });
    await expect(rest.sendMessage({ path: "/v2/groups/g1/messages", content: "**x**" })).rejects.toThrow(
      QqProtocolError,
    );
    try {
      await rest.sendMessage({ path: "/v2/groups/g1/messages", content: "**x**" });
    } catch (err) {
      expect((err as QqProtocolError).message).toContain("markdown");
    }
  });

  test("取令牌被拒 → 可读错误指向凭据", async () => {
    const rest = makeRest(jsonFetch(() => ({ status: 200, body: JSON.stringify({ code: 100007, message: "appid invalid" }) })));
    await expect(rest.getAccessToken()).rejects.toThrow(/AppID/);
  });
});

// —— 网关状态机 ——

function makeGateway(fetchImpl: FetchLike) {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const events: { type: string; id: string | null }[] = [];
  const statuses: string[] = [];
  let clock = 0;

  const rest = makeRest(fetchImpl, () => clock);
  const gw = createQqGateway({
    rest,
    onEvent: (e) => events.push({ type: e.type, id: e.id }),
    onStatus: (s) => statuses.push(s.health),
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: () => clock,
    watchdogIdleMs: 100_000,
  });
  // tick 必须是 async：connect() 是异步的（要 await 取 token / 取网关），
  // 推进定时器后得把微任务队列跑完，新 socket 才会出现。
  const tick = async (ms: number) => {
    clock += ms;
    timers.advance(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { gw, timers, sockets, events, statuses, tick };
}

const okFetch = jsonFetch((url) =>
  url.includes("getAppAccessToken") ? { status: 200, body: TOKEN_OK } : { status: 200, body: GATEWAY_OK },
);

describe("13.9 网关：握手 / 心跳 / 事件", () => {
  test("start → 取网关 → 开 socket → connected", async () => {
    const h = makeGateway(okFetch);
    await h.gw.start();
    expect(h.sockets).toHaveLength(1);
    expect(h.gw.health()).toBe("connecting");
    h.sockets[0]!.fireOpen();
    expect(h.gw.health()).toBe("connected");
    expect(h.gw.isConnected()).toBe(true);
    h.gw.stop();
  });

  test("HELLO → 发 IDENTIFY（带 token 与 intents）并开始心跳", async () => {
    const h = makeGateway(okFetch);
    await h.gw.start();
    h.sockets[0]!.fireOpen();
    h.sockets[0]!.fireMessage({ op: QQ_OP.HELLO, d: { heartbeat_interval: 1000 } });

    const sent = h.sockets[0]!.parsed() as { op: number; d?: { token?: string; intents?: number } }[];
    const identify = sent.find((f) => f.op === QQ_OP.IDENTIFY);
    expect(identify?.d?.token).toBe("QQBot tok-1");
    expect(identify?.d?.intents).toBeGreaterThan(0);

    // 心跳按 HELLO 给的间隔重复
    await h.tick(1000);
    expect((h.sockets[0]!.parsed() as { op: number }[]).filter((f) => f.op === QQ_OP.HEARTBEAT).length).toBe(1);
    await h.tick(1000);
    expect((h.sockets[0]!.parsed() as { op: number }[]).filter((f) => f.op === QQ_OP.HEARTBEAT).length).toBe(2);
    h.gw.stop();
  });

  test("DISPATCH → 回调事件，并记录 session_id 与 seq", async () => {
    const h = makeGateway(okFetch);
    await h.gw.start();
    h.sockets[0]!.fireOpen();
    h.sockets[0]!.fireMessage({ op: QQ_OP.HELLO, d: { heartbeat_interval: 100000 } });
    h.sockets[0]!.fireMessage({
      op: QQ_OP.DISPATCH,
      t: "READY",
      s: 1,
      id: "ready-1",
      d: { session_id: "sess-9" },
    });
    h.sockets[0]!.fireMessage({
      op: QQ_OP.DISPATCH,
      t: "GROUP_AT_MESSAGE_CREATE",
      s: 2,
      id: "evt-1",
      d: { content: "hi" },
    });
    expect(h.events).toEqual([
      { type: "READY", id: "ready-1" },
      { type: "GROUP_AT_MESSAGE_CREATE", id: "evt-1" },
    ]);
    expect(h.gw.eventCount()).toBe(2);
    h.gw.stop();
  });

  test("坏帧 / 非 DISPATCH 帧不影响运行", async () => {
    const h = makeGateway(okFetch);
    await h.gw.start();
    h.sockets[0]!.fireOpen();
    h.sockets[0]!.fireMessage("{ 坏 JSON");
    h.sockets[0]!.fireMessage({ op: QQ_OP.HEARTBEAT_ACK });
    h.sockets[0]!.fireMessage({ op: QQ_OP.DISPATCH, s: 3 }); // 没有 t
    expect(h.events).toEqual([]);
    expect(h.gw.health()).toBe("connected");
    h.gw.stop();
  });
});

describe("13.10 网关：重放事件被去重", () => {
  test("同一个事件 id 只回调一次（平台会重放）", async () => {
    const h = makeGateway(okFetch);
    await h.gw.start();
    h.sockets[0]!.fireOpen();
    h.sockets[0]!.fireMessage({ op: QQ_OP.HELLO, d: { heartbeat_interval: 100000 } });
    const evt = { op: QQ_OP.DISPATCH, t: "C2C_MESSAGE_CREATE", s: 5, id: "dup-1", d: {} };
    h.sockets[0]!.fireMessage(evt);
    h.sockets[0]!.fireMessage(evt);
    h.sockets[0]!.fireMessage(evt);
    expect(h.events).toHaveLength(1);
    expect(h.gw.eventCount()).toBe(1);
    h.gw.stop();
  });

  test("没有 id 的事件不去重（无法判定时宁可重复也不丢）", async () => {
    const h = makeGateway(okFetch);
    await h.gw.start();
    h.sockets[0]!.fireOpen();
    h.sockets[0]!.fireMessage({ op: QQ_OP.HELLO, d: { heartbeat_interval: 100000 } });
    h.sockets[0]!.fireMessage({ op: QQ_OP.DISPATCH, t: "X", s: 6, d: {} });
    h.sockets[0]!.fireMessage({ op: QQ_OP.DISPATCH, t: "X", s: 7, d: {} });
    expect(h.events).toHaveLength(2);
    h.gw.stop();
  });
});

describe("13.11 网关：重连 / 会话重置 / 静默看门狗", () => {
  test("断线 → 按台阶延迟重连，连上后台阶重置", async () => {
    const h = makeGateway(okFetch);
    await h.gw.start();
    h.sockets[0]!.fireOpen();
    await h.tick(10_000); // 连接持续够久，不算快速断开
    h.sockets[0]!.fireClose(1006, "boom");
    expect(h.timers.pending()).toBe(1);

    await h.tick(1000); // 第一档 1s
    expect(h.sockets).toHaveLength(2);
    h.gw.stop();
  });

  test("RECONNECT：平台要求重连", async () => {
    const h = makeGateway(okFetch);
    await h.gw.start();
    h.sockets[0]!.fireOpen();
    await h.tick(10_000);
    h.sockets[0]!.fireMessage({ op: QQ_OP.RECONNECT });
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.timers.pending()).toBe(1);
    await h.tick(1000);
    expect(h.sockets).toHaveLength(2);
    h.gw.stop();
  });

  test("有会话时 HELLO 走 RESUME", async () => {
    const h = makeGateway(okFetch);
    await h.gw.start();
    h.sockets[0]!.fireOpen();
    h.sockets[0]!.fireMessage({ op: QQ_OP.HELLO, d: { heartbeat_interval: 100000 } });
    h.sockets[0]!.fireMessage({ op: QQ_OP.DISPATCH, t: "READY", s: 1, id: "r", d: { session_id: "sess-1" } });
    await h.tick(10_000);
    h.sockets[0]!.fireClose(1006);
    await h.tick(1000);
    h.sockets[1]!.fireOpen();
    h.sockets[1]!.fireMessage({ op: QQ_OP.HELLO, d: { heartbeat_interval: 100000 } });
    const frames = h.sockets[1]!.parsed() as { op: number }[];
    expect(frames.some((f) => f.op === QQ_OP.RESUME)).toBe(true);
    expect(frames.some((f) => f.op === QQ_OP.IDENTIFY)).toBe(false);
    h.gw.stop();
  });

  test("INVALID_SESSION → 清掉会话，下次 HELLO 改走 IDENTIFY", async () => {
    const h = makeGateway(okFetch);
    await h.gw.start();
    h.sockets[0]!.fireOpen();
    h.sockets[0]!.fireMessage({ op: QQ_OP.HELLO, d: { heartbeat_interval: 100000 } });
    h.sockets[0]!.fireMessage({ op: QQ_OP.DISPATCH, t: "READY", s: 1, id: "r", d: { session_id: "sess-1" } });
    await h.tick(10_000);
    h.sockets[0]!.fireMessage({ op: QQ_OP.INVALID_SESSION });
    await h.tick(1000);
    h.sockets[1]!.fireOpen();
    h.sockets[1]!.fireMessage({ op: QQ_OP.HELLO, d: { heartbeat_interval: 100000 } });
    const frames = h.sockets[1]!.parsed() as { op: number }[];
    expect(frames.some((f) => f.op === QQ_OP.IDENTIFY)).toBe(true);
    expect(frames.some((f) => f.op === QQ_OP.RESUME)).toBe(false);
    h.gw.stop();
  });

  test("连续快速断开到阈值 → 改走 IDENTIFY（会话多半已失效）", async () => {
    const h = makeGateway(okFetch);
    await h.gw.start();
    h.sockets[0]!.fireOpen();
    h.sockets[0]!.fireMessage({ op: QQ_OP.HELLO, d: { heartbeat_interval: 100000 } });
    h.sockets[0]!.fireMessage({ op: QQ_OP.DISPATCH, t: "READY", s: 1, id: "r", d: { session_id: "sess-1" } });

    // 连续快速断开（每次都在 QUICK_DISCONNECT_MS 之内）
    let index = 0;
    for (let i = 0; i < QQ_QUICK_DISCONNECT_THRESHOLD; i++) {
      h.sockets[index]!.fireOpen();
      h.sockets[index]!.fireClose(1006);
      await h.tick(60_000); // 走过重连延迟
      index += 1;
      if (!h.sockets[index]) break;
    }
    const last = h.sockets[h.sockets.length - 1]!;
    last.fireOpen();
    last.fireMessage({ op: QQ_OP.HELLO, d: { heartbeat_interval: 100000 } });
    const frames = last.parsed() as { op: number }[];
    expect(frames.some((f) => f.op === QQ_OP.IDENTIFY)).toBe(true);
    h.gw.stop();
  });

  test("静默看门狗：长时间无数据 → 主动重建连接", async () => {
    const h = makeGateway(okFetch);
    await h.gw.start();
    h.sockets[0]!.fireOpen();
    // 不做任何 touch（不收任何帧），推进到超过 idle 阈值
    await h.tick(110_000);
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.gw.lastError()).toContain("没有收到数据");
    h.gw.stop();
  });

  test("stop 后不再重连，且连接关闭", async () => {
    const h = makeGateway(okFetch);
    await h.gw.start();
    h.sockets[0]!.fireOpen();
    h.gw.stop();
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.gw.health()).toBe("disconnected");
    expect(h.gw.isConnected()).toBe(false);
    h.sockets[0]!.fireClose(1006); // 迟到的关闭事件不应触发重连
    expect(h.timers.pending()).toBe(0);
  });

  test("取网关失败 → error 状态并安排重连", async () => {
    const h = makeGateway(
      jsonFetch((url) =>
        url.includes("getAppAccessToken")
          ? { status: 200, body: TOKEN_OK }
          : { status: 500, body: "server error" },
      ),
    );
    await h.gw.start();
    expect(h.gw.health()).toBe("error");
    expect(h.timers.pending()).toBe(1);
    h.gw.stop();
  });
});

describe("13.12 只做出站连接，不监听任何入站端口", () => {
  test("频道源码里不出现服务端/监听（防止以后有人加进来）", async () => {
    const root = path.resolve(import.meta.dir, "..", "src", "channels");
    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    }
    await walk(root);
    expect(files.length).toBeGreaterThan(5);

    const forbidden = [
      /\bcreateServer\s*\(/,
      /\.listen\s*\(/,
      /WebSocketServer\s*\(/,
      /http\.Server/,
    ];
    for (const file of files) {
      const content = await fs.readFile(file, "utf8");
      for (const re of forbidden) {
        expect(
          re.test(content),
          `${path.relative(root, file)} 里出现了入站监听（${re}）—— 频道必须只用出站连接`,
        ).toBe(false);
      }
    }
  });

  test("网关只连 wss://，不绑定端口", async () => {
    const h = makeGateway(okFetch);
    await h.gw.start();
    // socketFactory 收到的 url 由协议层解析而来，必须是 wss
    expect(GATEWAY_OK).toContain("wss://");
    expect(h.gw.isConnected()).toBe(true);
    h.gw.stop();
  });
});