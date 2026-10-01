/**
 * 重连退避与「静默连接」看门狗（task 13.11）。
 *
 * 两件事它们各自解决一个真实故障：
 * - **退避重连**：连接断了不能立刻狂重连（打爆平台侧限流，也浪费电）。
 *   指数增长 + 抖动，并封顶。
 * - **看门狗**：连接「看起来是活的」（socket 没报错）但**长时间收不到任何数据** ——
 *   这种情况最坑：消息不进来，用户以为助手坏了，而进程自己毫无察觉。
 *   QwenPaw 的飞书频道就有这条（`"feishu WebSocket no data received"`）。
 *
 * 两个都是纯计算/纯计时，**不碰网络**，所以可以完整测试。
 */

export interface BackoffOptions {
  /** 首次重连等待（毫秒） */
  baseMs?: number;
  /** 上限（毫秒） */
  maxMs?: number;
  /** 抖动比例（0~1）：在结果上叠加 ±此比例的随机偏移，避免多实例同时重连 */
  jitterRatio?: number;
  /** 注入随机数与时钟，便于测试 */
  random?: () => number;
}

const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_MS = 60_000;

/** 指数退避：第 1 次 base、第 2 次 2×base、第 3 次 4×base…封顶到 max，并叠加抖动 */
export class ExponentialBackoff {
  readonly #baseMs: number;
  readonly #maxMs: number;
  readonly #jitterRatio: number;
  readonly #random: () => number;
  #attempt = 0;

  constructor(options: BackoffOptions = {}) {
    this.#baseMs = Math.max(1, options.baseMs ?? DEFAULT_BASE_MS);
    this.#maxMs = Math.max(this.#baseMs, options.maxMs ?? DEFAULT_MAX_MS);
    this.#jitterRatio = Math.min(1, Math.max(0, options.jitterRatio ?? 0.2));
    this.#random = options.random ?? Math.random;
  }

  get attempt(): number {
    return this.#attempt;
  }

  /** 连上之后调用：下次断线从头开始退避 */
  reset(): void {
    this.#attempt = 0;
  }

  /** 取下一次重连应等待的毫秒数，并把尝试次数 +1 */
  nextDelayMs(): number {
    const raw = Math.min(this.#maxMs, this.#baseMs * 2 ** this.#attempt);
    this.#attempt += 1;
    if (this.#jitterRatio === 0) return Math.round(raw);
    const spread = raw * this.#jitterRatio;
    const offset = (this.#random() * 2 - 1) * spread;
    return Math.max(0, Math.round(raw + offset));
  }
}

export interface WatchdogOptions {
  /** 多久没收到任何数据就认为连接异常（毫秒） */
  idleMs?: number;
  /** 检查周期（毫秒） */
  checkIntervalMs?: number;
  /** 时钟与定时器注入，便于测试 */
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_CHECK_MS = 30 * 1000;

/**
 * 静默连接看门狗：记录「最后一次收到数据的时间」，周期检查是否超时。
 * 超时 → 调用 `onIdle()`（调用方负责重建连接）。
 */
export class SilentConnectionWatchdog {
  readonly #idleMs: number;
  readonly #checkIntervalMs: number;
  readonly #now: () => number;
  readonly #setInterval: (fn: () => void, ms: number) => unknown;
  readonly #clearInterval: (handle: unknown) => void;
  #lastDataAt: number;
  #handle: unknown = null;
  #firing = false;

  constructor(
    private readonly onIdle: (idleMs: number) => void,
    options: WatchdogOptions = {},
  ) {
    this.#idleMs = Math.max(1, options.idleMs ?? DEFAULT_IDLE_MS);
    this.#checkIntervalMs = Math.max(1, options.checkIntervalMs ?? DEFAULT_CHECK_MS);
    this.#now = options.now ?? (() => Date.now());
    this.#setInterval =
      options.setInterval ?? ((fn, ms) => setInterval(fn, ms) as unknown);
    this.#clearInterval = options.clearInterval ?? ((h) => clearInterval(h as never));
    this.#lastDataAt = this.#now();
  }

  /** 每收到一次数据（含心跳）都要调用 */
  touch(): void {
    this.#lastDataAt = this.#now();
  }

  /** 距离上次收到数据过了多久 */
  idleMs(): number {
    return this.#now() - this.#lastDataAt;
  }

  start(): void {
    if (this.#handle !== null) return;
    this.#lastDataAt = this.#now();
    this.#handle = this.#setInterval(() => this.check(), this.#checkIntervalMs);
  }

  stop(): void {
    if (this.#handle === null) return;
    this.#clearInterval(this.#handle);
    this.#handle = null;
  }

  /** 主动检查一次（测试直接调它，不必等定时器） */
  check(): boolean {
    if (this.#firing) return false;
    const idle = this.idleMs();
    if (idle < this.#idleMs) return false;
    this.#firing = true;
    try {
      this.onIdle(idle);
    } finally {
      this.#firing = false;
      this.#lastDataAt = this.#now(); // 避免立刻二次触发
    }
    return true;
  }
}

/** 从平台二进制帧里嗅探「服务器是否返回了错误码 10053」之类需要按断开处理的情况。
 *  返回 true 表示调用方应当主动重建连接。 */
export function isFatalCloseCode(code: number | null | undefined): boolean {
  if (typeof code !== "number") return false;
  // 1000 正常关闭由调用方自行决定；这里只把「会话失效/服务端拒绝」这类判为必须重连
  return code === 1006 || code === 1008 || code === 4004 || code === 4006 || code === 4007;
}