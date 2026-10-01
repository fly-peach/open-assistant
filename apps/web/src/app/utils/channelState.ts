/**
 * 频道**配置状态**的判定与分区（纯函数，便于单测）。
 *
 * 两条不变式（见 spec channels-ui）：
 * 1. 状态判据是**必填是否齐全**，不是「有没有被添加过」——
 *    必填没齐的频道若出现在「已配置」里，会跟它「开关打不开」的事实自相矛盾。
 * 2. 这里是**配置状态**，不是连接健康。运行时还没去连接平台，
 *    展示连接状态就等于撒谎，所以状态里不包含「已连接」这种取值。
 */

/** 只依赖判定所需的最小形状，避免和 API 类型强耦合 */
export interface ChannelLike {
  key: string;
  missing: string[];
  enabled: boolean;
}

export type ChannelState = "not-configured" | "configured" | "enabled";

export function channelStateOf(view: ChannelLike): ChannelState {
  if (view.missing.length > 0) return "not-configured";
  return view.enabled ? "enabled" : "configured";
}

export function isConfigured(view: ChannelLike): boolean {
  return view.missing.length === 0;
}

/**
 * 分区：`configured` = 必填齐全；`unconfigured` = 其余（含已添加但没填完的）。
 * 第二项布尔值表示**是否已被添加进配置**（决定给「配置」还是「接入」按钮）。
 *
 * 已添加但没填完的排前面：用户刚点过它，别让它因为重排而跳位置。
 */
export function groupChannels<T extends ChannelLike>(
  configured: readonly T[],
  available: readonly T[],
): { configured: T[]; unconfigured: [T, boolean][] } {
  return {
    configured: configured.filter(isConfigured),
    unconfigured: [
      ...configured.filter((view) => !isConfigured(view)).map((view) => [view, true] as [T, boolean]),
      ...available.map((view) => [view, false] as [T, boolean]),
    ],
  };
}

/** 状态对应的颜色（文字仍由 i18n 给出；颜色只是辅助，不能是唯一信号） */
export function channelStateStyle(state: ChannelState): { color: string; background: string } {
  const background = "var(--color-surface)";
  if (state === "not-configured") return { color: "var(--color-text-tertiary)", background };
  if (state === "enabled") return { color: "var(--color-success)", background };
  return { color: "var(--color-primary)", background };
}