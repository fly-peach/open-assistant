/**
 * 上下文压缩的阈值换算（纯函数）。
 *
 * 依据：`models.json` 里这个模型的**上下文窗口**（用户可在「模型」页指定，或来自内置先验）。
 *
 * - 触发：`0.8 × 窗口`
 * - 保留：`0.1 × 窗口`
 *
 * 这两个比例对齐 QwenPaw 的 `compact_threshold_ratio = 0.8` / `reserve_threshold_ratio = 0.1`，
 * 也与 deepagents 在「模型有 profile」时用的 0.85 / 0.1 同量级。
 *
 * 窗口未知（null / 非正数）→ 返回 `null`：调用方**不猜**，让上游默认阈值兜着。
 */
export const COMPACT_TRIGGER_RATIO = 0.8;
export const COMPACT_KEEP_RATIO = 0.1;

export interface CompactionThresholds {
  /** 达到它就开始摘要（tokens） */
  trigger: number;
  /** 摘要后保留的最近上下文（tokens） */
  keep: number;
}

export function compactionThresholds(
  contextWindow: number | null | undefined,
): CompactionThresholds | null {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return {
    trigger: Math.floor(contextWindow * COMPACT_TRIGGER_RATIO),
    keep: Math.floor(contextWindow * COMPACT_KEEP_RATIO),
  };
}