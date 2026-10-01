/**
 * 可停靠面板的**纯几何函数**（任务 10.6 / 10.7）。
 *
 * 抽出纯函数的目的：把「视口约束 / 吸附阈值 / 让位宽度」这些容易写错的规则
 * 从 React 与 DOM 里剥离，用单测锁住行为（`placement.test.ts`）。
 * 组件只负责把结果套到样式上。
 */

/** 浮动面板与视口边缘之间必须保留的可见边距（px）。 */
export const PANEL_MARGIN = 12;
/** 拖到离目标边侧这么近（px）就认为用户想重新吸附。 */
export const DOCK_EDGE = 64;

/** 面板贴附的边侧。 */
export type DockSide = "left" | "right";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/**
 * 把浮动面板的位置约束在视口内，并保留可见边距。
 * 当面板比视口还大时，退化为贴住左上边距（不产生负数或越界）。
 */
export function clampPanelPosition(
  position: Point,
  size: Size,
  viewport: Viewport,
  margin: number = PANEL_MARGIN
): Point {
  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const maxY = Math.max(margin, viewport.height - size.height - margin);
  return {
    x: Math.min(Math.max(position.x, margin), maxX),
    y: Math.min(Math.max(position.y, margin), maxY),
  };
}

/**
 * 判断面板是否进入「吸附区」：面板靠近它归属的那条边侧。
 *
 * 注意左右不对称：
 * - 左侧面板：面板左边缘 ≤ 锚点左边缘 + 阈值（向左推入即吸附）；
 * - 右侧面板：面板右边缘 ≥ 锚点右边缘 − 阈值（向右推到边即吸附），
 *   等价于 `panelLeft >= anchorLeft - threshold`。
 * 传入真实拖拽位置（而非被视口约束后的位置），否则永远吸附不回去。
 */
export function isInDockZone(
  panelLeft: number,
  anchorLeft: number,
  side: DockSide = "right",
  threshold: number = DOCK_EDGE
): boolean {
  return side === "left"
    ? panelLeft <= anchorLeft + threshold
    : panelLeft >= anchorLeft - threshold;
}

/**
 * 停靠时面板为内容区让出的宽度；浮动或收起时为 0（内容区收回宽度）。
 * `landing` 表示正在播放「吸附回位」动画，此时边侧应提前让出宽度。
 */
export function reservedDockWidth(
  open: boolean,
  docked: boolean,
  width: number
): number {
  return open && docked ? Math.max(0, width) : 0;
}

/**
 * 浮动面板的尺寸：宽度取面板宽度但不超出视口（留边距），高度取可用高度上限。
 * 窗口变小时高度随之收缩，保证不越界。
 */
export function floatPanelSize(
  viewport: Viewport,
  width: number,
  margin: number = PANEL_MARGIN,
  maxHeight = 720
): Size {
  const available = Math.max(0, viewport.width - margin * 2);
  return {
    width: Math.min(width, available),
    height: Math.min(maxHeight, Math.max(0, viewport.height - margin * 2)),
  };
}