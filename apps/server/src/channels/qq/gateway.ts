/**
 * QQ 网关连接状态机（task 13.9 / 13.10 / 13.11 / 13.12）。
 *
 * 负责：握手（HELLO → IDENTIFY）→ 心跳 → 收事件（DISPATCH，**按事件 id 去重**）
 * → 断线按台阶重连 → 连续快速断开则重置会话（重新 IDENTIFY 而不是 RESUME）
 * → 静默看门狗（长连接「看着活着」但没数据）。
 *
 * **socket、fetch、定时器、时钟全部可注入** —— 所以这一整套逻辑可以离线完整测试，
 * 不需要真实 QQ 凭据（真实凭据在开发机上拿不到）。
 *
 * ⚠️ 它**不监听任何入站端口**：QQ 是「我们主动外连 + 平台推事件」的模型（task 13.12）。
 */
import { BoundedDedupe } from "../dedupe.js";
import { SilentConnectionWatchdog } from "../backoff.js";
import { defaultSocketFactory, type SocketFactory, type SocketLike } from "../transport.js";
import {
  QQ_OP,
  QQ_QUICK_DISCONNECT_MS,
  buildHeartbeatPayload,
  buildIdentifyPayload,
  buildResumePayload,
  heartbeatIntervalFromHello,
  parseQqFrame,
  qqIntents,
  qqReconnectDelayMs,
  shouldResetSession,
} from "./protocol.js";
import type { QqRest } from "./rest.js";

export type QqHealth = "disconnected" | "connecting" | "connected" | "error";

export interface QqGatewayEvent {
  /** 事件类型，如 `GROUP_AT_MESSAGE_CREATE` / `C2C_MESSAGE_CREATE` */
  type: string;
  /** 平台事件标识（已去重） */
  id: string | null;
  data: unknown;
}

export interface QqGatewayOptions {
  rest: Pick<QqRest, "getGatewayUrl" | "getAccessToken">;
  /** 收到事件（已去重） */
  onEvent: (event: QqGatewayEvent) => void | Promise<void>;
  /** 连接状态变化 */
  onStatus?: (status: { health: QqHealth; lastError?: string }) => void;
  socketFactory?: SocketFactory;
  /** 心跳间隔缺省值（HELLO 里一般会带真实值） */
  heartbeatIntervalMs?: number;
  /** 静默多久认为连接需要重建 */
  watchdogIdleMs?: number;
  /** 是否包含私信/群聊 intents */
  includeDirect?: boolean;
  /** 注入定时器与时钟（测试用） */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
  /** 去重容量/TTL 覆盖（测试用） */
  dedupe?: BoundedDedupe;
}

export interface QqGateway {
  start(): Promise<void>;
  stop(): void;
  health(): QqHealth;
  lastError(): string | undefined;
  /** 收到的、通过去重的 DISPATCH 事件数（可观测性） */
  eventCount(): number;
  /** 当前是否持有 socket（测试断言用） */
  isConnected(): boolean;
}

export function createQqGateway(options: QqGatewayOptions): QqGateway {
  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  const setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
  const clearTimer = options.clearTimeout ?? ((h) => clearTimeout(h as never));
  const now = options.now ?? (() => Date.now());
  const dedupe = options.dedupe ?? new BoundedDedupe();
  const intents = qqIntents({ includeDirect: options.includeDirect !== false });

  let socket: SocketLike | null = null;
  let health: QqHealth = "disconnected";
  let lastError: string | undefined;
  let stopped = true;

  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let heartbeatHandle: unknown = null;
  let heartbeatIntervalMs = options.heartbeatIntervalMs ?? 45_000;
  let reconnectHandle: unknown = null;
  let reconnectAttempt = 0;
  let quickDisconnects = 0;
  let connectedAtMs = 0;
  let eventCount = 0;

  const watchdog = new SilentConnectionWatchdog(
    () => {
      // 静默超时：连接看着是活的但没数据 → 主动重建
      lastError = `连接长时间没有收到数据（静默超过 ${options.watchdogIdleMs ?? 0} ms），已主动重建`;
      closeSocketAndReconnect(false);
    },
    {
      ...(options.watchdogIdleMs === undefined ? {} : { idleMs: options.watchdogIdleMs }),
      now,
      setInterval: (fn, ms) => setTimer(fn, ms),
      clearInterval: (h) => clearTimer(h),
    },
  );

  function setHealth(next: QqHealth, error?: string): void {
    health = next;
    if (error !== undefined) lastError = error;
    options.onStatus?.({ health, ...(lastError === undefined ? {} : { lastError }) });
  }

  function clearHeartbeat(): void {
    if (heartbeatHandle !== null) {
      clearTimer(heartbeatHandle);
      heartbeatHandle = null;
    }
  }

  function sendHeartbeat(): void {
    if (!socket) return;
    socket.send(JSON.stringify(buildHeartbeatPayload(lastSeq)));
  }

  function startHeartbeat(): void {
    clearHeartbeat();
    heartbeatHandle = setTimer(() => {
      sendHeartbeat();
      startHeartbeat();
    }, heartbeatIntervalMs);
  }

  function handleFrame(raw: string): void {
    watchdog.touch();
    const frame = parseQqFrame(raw);
    if (!frame) return;

    switch (frame.op) {
      case QQ_OP.HELLO: {
        heartbeatIntervalMs = heartbeatIntervalFromHello(
          frame as { op: number; d?: { heartbeat_interval?: unknown } },
        );
        startHeartbeat();
        if (!socket) return;
        // 有会话且没被判定失效 → 尝试 RESUME；否则重新 IDENTIFY
        if (sessionId && !shouldResetSession(quickDisconnects)) {
          socket.send(
            JSON.stringify(buildResumePayload(accessToken, sessionId, lastSeq)),
          );
        } else {
          socket.send(JSON.stringify(buildIdentifyPayload(accessToken, intents)));
        }
        return;
      }
      case QQ_OP.HEARTBEAT_ACK:
        return;
      case QQ_OP.DISPATCH: {
        if (typeof frame.s === "number") lastSeq = frame.s;
        // READY 事件里带 session_id，用于后续 RESUME
        const data = frame.d as { session_id?: unknown } | undefined;
        if (!sessionId && data && typeof data.session_id === "string") sessionId = data.session_id;
        if (typeof frame.t !== "string") return;
        // **去重**：平台会重放事件，同一个 id 只能算一次
        if (!dedupe.first(frame.id)) return;
        eventCount += 1;
        void options.onEvent({ type: frame.t, id: frame.id ?? null, data: frame.d });
        return;
      }
      case QQ_OP.RECONNECT:
        setHealth("connecting", "平台要求重连");
        closeSocketAndReconnect(false);
        return;
      case QQ_OP.INVALID_SESSION:
        // 会话失效：必须重新 IDENTIFY，RESUME 会一直被拒
        sessionId = null;
        lastSeq = null;
        quickDisconnects = 0;
        setHealth("connecting", "会话已失效，将重新建立身份");
        closeSocketAndReconnect(false);
        return;
      default:
        return;
    }
  }


  function closeSocketAndReconnect(countAsDisconnect: boolean): void {
    const current = socket;
    socket = null;
    clearHeartbeat();
    watchdog.stop();
    if (countAsDisconnect && connectedAtMs > 0) {
      if (now() - connectedAtMs < QQ_QUICK_DISCONNECT_MS) quickDisconnects += 1;
      else quickDisconnects = 0;
    }
    try {
      current?.close(1000, "reconnect");
    } catch {
      /* 忽略关闭异常 */
    }
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = qqReconnectDelayMs(reconnectAttempt);
    reconnectAttempt += 1;
    if (reconnectHandle !== null) clearTimer(reconnectHandle);
    reconnectHandle = setTimer(() => {
      reconnectHandle = null;
      void connect();
    }, delay);
  }

  /** 最近一次取到的 access token（IDENTIFY / RESUME 要用） */
  let accessToken = "";

  async function connect(): Promise<void> {
    if (stopped) return;
    setHealth("connecting");
    try {
      accessToken = await options.rest.getAccessToken();
      const url = await options.rest.getGatewayUrl();
      const s = socketFactory(url);
      socket = s;

      s.onOpen(() => {
        connectedAtMs = now();
        reconnectAttempt = 0;
        setHealth("connected");
        watchdog.start();
      });
      s.onMessage((data) => handleFrame(data));
      s.onError((err) => {
        setHealth("error", `连接错误：${err.message}`);
      });
      s.onClose(() => {
        if (stopped) return;
        if (socket !== s) return; // 已被替换，忽略旧 socket 的关闭
        socket = null;
        clearHeartbeat();
        watchdog.stop();
        if (now() - connectedAtMs < QQ_QUICK_DISCONNECT_MS) quickDisconnects += 1;
        else quickDisconnects = 0;
        setHealth("connecting", "连接已断开，准备重连");
        scheduleReconnect();
      });
    } catch (err) {
      setHealth("error", err instanceof Error ? err.message : String(err));
      scheduleReconnect();
    }
  }

  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      reconnectAttempt = 0;
      quickDisconnects = 0;
      await connect();
    },
    stop() {
      stopped = true;
      if (reconnectHandle !== null) {
        clearTimer(reconnectHandle);
        reconnectHandle = null;
      }
      clearHeartbeat();
      watchdog.stop();
      const current = socket;
      socket = null;
      try {
        current?.close(1000, "stopped");
      } catch {
        /* 忽略 */
      }
      setHealth("disconnected");
    },
    health: () => health,
    lastError: () => lastError,
    eventCount: () => eventCount,
    isConnected: () => socket !== null,
  };
}