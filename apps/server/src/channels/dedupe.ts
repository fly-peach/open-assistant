/**
 * 有界去重（task 13.10）。
 *
 * 为什么必须有：**平台会重放事件**。
 * - QQ 的 gateway 会重放未确认的事件（`qq/channel.py` 的注释原话：*"the QQ gateway replays..."*）
 * - 长连接断开重连后，平台常把断线期间的事件再推一遍
 *
 * 没有去重 → 同一条消息触发两轮对话 → 用户看到助手重复回复、待办被建两次。
 *
 * **为什么是「有界」**：不能用一个只增不减的 Set（长时间运行会吃内存）。这里用
 * 「容量 + TTL」双限：超容量先淘汰最旧的，超时自动失效。对齐 QwenPaw 的做法。
 */

export interface DedupeOptions {
  /** 最多记住多少个 id */
  capacity?: number;
  /** 单条记录最长记住多久（毫秒） */
  ttlMs?: number;
  /** 注入时钟，便于测试 */
  now?: () => number;
}

const DEFAULT_CAPACITY = 2048;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class BoundedDedupe {
  readonly #capacity: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  /** id → 首次见到的时间戳；Map 保持插入顺序，便于按序淘汰 */
  readonly #seen = new Map<string, number>();

  constructor(options: DedupeOptions = {}) {
    this.#capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.#ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
    this.#now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.#seen.size;
  }

  /**
   * 首次见到返回 `true`（应当处理）；重复或已过期后再次见到返回 `false`（跳过）。
   * 空 id / 非字符串 → 一律返回 `true`（无法去重时不吞消息，宁可重复也不丢）。
   */
  first(id: string | null | undefined): boolean {
    if (typeof id !== "string" || id.length === 0) return true;
    const now = this.#now();
    this.#evictExpired(now);

    const at = this.#seen.get(id);
    if (at !== undefined && now - at < this.#ttlMs) {
      // 重复：**刷新位置与时间**再返回 false。
      // 平台仍在重放它 → 保留判定更久更安全；不刷新的话「正在被重放的热门事件」
      // 反而会因为是第一个插入的而先被容量淘汰掉。
      this.#seen.delete(id);
      this.#seen.set(id, now);
      this.#evictOverflow();
      return false;
    }

    // 重复插入要刷新位置：先删再放，保证 Map 顺序 = 最近使用顺序
    this.#seen.delete(id);
    this.#seen.set(id, now);
    this.#evictOverflow();
    return true;
  }

  /** 该 id 是否在有效期内见过 */
  has(id: string): boolean {
    const at = this.#seen.get(id);
    if (at === undefined) return false;
    return this.#now() - at < this.#ttlMs;
  }

  clear(): void {
    this.#seen.clear();
  }

  #evictExpired(now: number): void {
    for (const [id, at] of this.#seen) {
      if (now - at >= this.#ttlMs) this.#seen.delete(id);
      else break; // Map 有序：第一个未过期的后面都不会过期
    }
  }

  #evictOverflow(): void {
    while (this.#seen.size > this.#capacity) {
      const oldest = this.#seen.keys().next();
      if (oldest.done) break;
      this.#seen.delete(oldest.value);
    }
  }
}