"use client";

/**
 * 可停靠面板（任务 10.6 / 10.7 / 10.8 / 10.12）。
 *
 * 核心原则（对齐 design.md Decision #10 与 QwenPaw `DockableSidebar` 注释）：
 * **一个稳定子树，停靠只改呈现不改归属。**
 *
 * 实现方式：面板内容始终渲染在同一个 React 元素树里（`frame` 是宿主 `host` 的
 * React 子节点），换形态时**只把同一个 `frame` DOM 节点在「宿主内联」与
 * 「body 浮动」之间搬移**，从不条件渲染整棵子树，因此内部滚动位置 / 已展开目录 /
 * 已加载数据都不会丢。`frame.parentElement === document.body` 即浮动到 body。
 *
 * 为什么必须 portal 到 body：壳层的内容区是 flex/grid 容器且 `overflow:hidden`，
 * 留在里面会被裁掉，所以浮动时必须挂到 body，并用 fixed 定位 + 视口约束。
 *
 * 无新依赖：位移动画用 CSS transition + `cubic-bezier(.22,1,.36,1)` 模拟弹簧；
 * `prefers-reduced-motion: reduce` 时 transition 直接置为 none。
 */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { GripVertical, PanelRight } from "lucide-react";
import zh from "@/i18n/zh";
import {
  clampPanelPosition,
  floatPanelSize,
  isInDockZone,
  reservedDockWidth,
  type DockSide,
  type Point,
  type Size,
} from "./placement";

/** SSR 阶段 `useLayoutEffect` 会告警；客户端用 layout effect 保证在删除 DOM 前搬回。 */
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** 位移/让位动画时长（ms），与 CSS transition 保持一致。 */
const TRANSITION_MS = 320;
/** 拖拽开始的最小位移（px），低于它视为点击。 */
const DRAG_THRESHOLD = 8;
const SPRING = "cubic-bezier(.22,1,.36,1)";

export interface DockablePanelProps {
  /** 面板是否展开。收起时让出宽度但内容仍然挂载（状态不丢）。 */
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** 停靠时占用的固定宽度（px）。 */
  width: number;
  /** 稳定标识：用于 `data-dockable-panel` 与无障碍标签。 */
  id: string;
  /** 面板名称（无障碍标签用）。 */
  label: string;
  /** 面板归属的边侧（默认右侧）。 */
  side?: DockSide;
  children: React.ReactNode;
}

interface Gesture {
  id: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  startedFloating: boolean;
  moved: boolean;
}

export function DockablePanel({
  open,
  onOpenChange,
  width,
  id,
  label,
  side = "right",
  children,
}: DockablePanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLButtonElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const timerRef = useRef<number | null>(null);

  const [floating, setFloating] = useState(false);
  const [landing, setLanding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dockReady, setDockReady] = useState(false);
  const [pos, setPos] = useState<Point>({ x: 0, y: 0 });
  const [floatSize, setFloatSize] = useState<Size>({ width, height: 600 });
  const [reduced, setReduced] = useState(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 动效偏好：reduce 时跳过一切位移动画。
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  /*
    换形态只改「呈现」：同一个 frame 节点在宿主与 body 之间搬移。

    陷阱：`appendChild` 会隐式 detach 再插入整棵子树，浏览器会把子树里所有
    可滚动元素的 `scrollTop/scrollLeft` 归零（元素本身、React fiber 与状态都不变）。
    所以搬移前记录、搬移后原样恢复，真正做到「换形态不丢滚动位置」。

    cleanup 负责在换回 / 卸载前把 frame 放回宿主——React 删除 DOM 时依赖
    宿主整体被移除，因此必须先归位，否则浮动中的面板会在 body 里泄漏。
  */
  useIsoLayoutEffect(() => {
    const frame = frameRef.current;
    const host = hostRef.current;
    if (!frame || !host) return;
    const target = floating ? document.body : host;
    if (frame.parentElement === target) return;
    const scrollers: Array<[HTMLElement, number, number]> = [];
    const remember = (el: HTMLElement) => {
      if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
        scrollers.push([el, el.scrollTop, el.scrollLeft]);
      }
    };
    remember(frame);
    frame.querySelectorAll<HTMLElement>("*").forEach(remember);
    target.appendChild(frame);
    for (const [el, top, left] of scrollers) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  }, [floating]);

  // 卸载前把 frame 放回宿主：React 删除 DOM 时依赖宿主整体被移除，
  // 否则浮动中的面板会在 body 里泄漏。
  useIsoLayoutEffect(() => {
    return () => {
      const frame = frameRef.current;
      const host = hostRef.current;
      if (frame && host && frame.parentElement !== host) host.appendChild(frame);
    };
  }, []);

  // 收起面板时若仍在浮动/拖拽，先归位（内容保持挂载，宽度由宿主归零）。
  useEffect(() => {
    if (!open && (floating || dragging)) {
      clearTimer();
      setLanding(false);
      setFloating(false);
      setDragging(false);
      setDockReady(false);
      setPos({ x: 0, y: 0 });
    }
  }, [open, floating, dragging, clearTimer]);

  // 窗口尺寸变化：浮动面板重新约束，保证不越出视口。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => {
      if (frameRef.current && frameRef.current.parentElement === document.body) {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const size = floatPanelSize(viewport, width);
        setFloatSize(size);
        setPos((prev) => clampPanelPosition(prev, size, viewport));
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [width]);

  useEffect(() => clearTimer, [clearTimer]);

  /** 面板归属边侧的锚点左边缘（宿主父容器的左/右边缘）。 */
  const anchorLeft = useCallback(() => {
    const host = hostRef.current;
    const parent = host?.parentElement;
    if (!parent) return 0;
    const rect = parent.getBoundingClientRect();
    return side === "left" ? rect.left : rect.right - width;
  }, [side, width]);

  /** 吸附回边侧。非 reduce 时先播放位移回位动画，再改归属。 */
  const dock = useCallback(() => {
    clearTimer();
    gestureRef.current = null;
    setDragging(false);
    setDockReady(false);
    handleRef.current?.focus({ preventScroll: true });
    if (reduced) {
      setLanding(false);
      setFloating(false);
      return;
    }
    const host = hostRef.current;
    const parent = host?.parentElement;
    if (parent) {
      const rect = parent.getBoundingClientRect();
      const size = { width, height: Math.max(0, rect.height) };
      const left = side === "left" ? rect.left : rect.right - width;
      setFloatSize(size);
      setPos({ x: Math.max(0, left), y: rect.top });
    }
    setLanding(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setLanding(false);
      setFloating(false);
    }, TRANSITION_MS);
  }, [clearTimer, reduced, side, width]);

  /** 拖出成为浮动面板；`at` 缺省时原地浮动（键盘操作）。 */
  const float = useCallback(
    (at?: Point) => {
      clearTimer();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const size = floatPanelSize(viewport, width);
      const rect = frameRef.current?.getBoundingClientRect();
      const next =
        at ?? { x: rect?.left ?? 0, y: rect?.top ?? 0 };
      setFloatSize(size);
      setPos(clampPanelPosition(next, size, viewport));
      setLanding(false);
      setFloating(true);
    },
    [clearTimer, width]
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      const frame = frameRef.current;
      if (!frame) return;
      clearTimer();
      setLanding(false);
      const rect = frame.getBoundingClientRect();
      gestureRef.current = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: floating ? pos.x : rect.left,
        originY: floating ? pos.y : rect.top,
        startedFloating: floating,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [clearTimer, floating, pos.x, pos.y]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.id !== event.pointerId) return;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const size = floatPanelSize(viewport, width);
      const raw = { x: gesture.originX + dx, y: gesture.originY + dy };
      const next = clampPanelPosition(raw, size, viewport);
      if (!gesture.moved) {
        /*
          首次越过阈值：进入「拖拽脱离」呈现。此时**不立刻改归属**（仍旧留在宿主）——
          因为把带指针捕获的子树搬去 body 会触发 lostpointercapture，把拖拽打断。
          真正 portal 到 body 在松手后、确认保持在浮动时发生。
        */
        setFloatSize(size);
        setDragging(true);
        gesture.moved = true;
      }
      setPos(next);
      setDockReady(isInDockZone(raw.x, anchorLeft(), side));
    },
    [anchorLeft, side, width]
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.id !== event.pointerId) return;
      gestureRef.current = null;
      setDragging(false);
      if (!gesture.moved) {
        setDockReady(false);
        return;
      }
      const rawLeft = gesture.originX + (event.clientX - gesture.startX);
      if (isInDockZone(rawLeft, anchorLeft(), side)) {
        dock();
      } else {
        setDragging(false);
        setDockReady(false);
        // 保持在浮动：此时才把同一个子树 portal 到 body。
        if (!gesture.startedFloating) setFloating(true);
      }
    },
    [anchorLeft, dock, side]
  );

  const onPointerCancel = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setDragging(false);
    setDockReady(false);
    if (gesture && !gesture.startedFloating) {
      setLanding(false);
      setFloating(false);
      setPos({ x: 0, y: 0 });
    }
  }, []);

  const onHandleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (floating) dock();
        else float();
        return;
      }
      if (
        floating &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        event.preventDefault();
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const step = event.shiftKey ? 40 : 10;
        setPos((prev) => {
          const raw = {
            x: prev.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
            y: prev.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0),
          };
          setDockReady(isInDockZone(raw.x, anchorLeft(), side));
          return clampPanelPosition(raw, floatSize, viewport);
        });
      }
    },
    [anchorLeft, dock, float, floatSize, floating, side]
  );

  const detached = dragging || floating;
  const isFloatPresentation = detached || landing;
  const reserved = reservedDockWidth(open, !detached || landing, width);
  const placement = isFloatPresentation ? "floating" : "docked";

  const frameStyle: React.CSSProperties = isFloatPresentation
    ? {
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: floatSize.width,
        height: floatSize.height,
        zIndex: 60,
        borderRadius: 16,
        boxShadow: dragging
          ? "0 28px 70px -18px rgba(0,0,0,.38)"
          : "0 18px 50px -16px rgba(0,0,0,.30)",
        transition:
          dragging || reduced
            ? "none"
            : `left ${TRANSITION_MS}ms ${SPRING}, top ${TRANSITION_MS}ms ${SPRING}, width ${TRANSITION_MS}ms ${SPRING}, height ${TRANSITION_MS}ms ${SPRING}, border-radius ${TRANSITION_MS}ms ${SPRING}`,
      }
    : {
        position: "relative",
        width: "100%",
        height: "100%",
        transition: reduced ? "none" : undefined,
      };

  return (
    <div
      ref={hostRef}
      data-dockable-host={id}
      data-dockable-host-placement={placement}
      className="relative shrink-0 overflow-hidden"
      style={{
        width: reserved,
        transition: reduced
          ? "none"
          : `width ${TRANSITION_MS}ms ${SPRING}`,
      }}
    >
      <div
        ref={frameRef}
        data-dockable-panel={id}
        data-panel-placement={placement}
        data-panel-landing={landing || undefined}
        data-panel-dragging={dragging || undefined}
        data-panel-dock-ready={dockReady || undefined}
        data-panel-reduced-motion={reduced || undefined}
        role="complementary"
        aria-label={label}
        className="flex h-full w-full flex-col overflow-hidden border-l border-border bg-background"
        style={frameStyle}
      >
        <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-1.5">
          <button
            ref={handleRef}
            type="button"
            data-panel-handle
            aria-label={zh.panel.dragHandle}
            title={zh.panel.dragHandle}
            aria-pressed={floating}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onKeyDown={onHandleKeyDown}
            className="flex flex-1 cursor-grab items-center gap-1 rounded px-1 py-0.5 text-[11px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface)] active:cursor-grabbing focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-primary)]"
          >
            <GripVertical size={13} aria-hidden />
            <span>
              {floating ? zh.panel.floating : zh.panel.docked}
            </span>
          </button>
          {floating && (
            <button
              type="button"
              data-panel-dock
              onClick={dock}
              aria-label={zh.panel.dock}
              title={zh.panel.dock}
              className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"
            >
              <PanelRight size={13} aria-hidden />
            </button>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col" data-panel-body>
          {children}
        </div>
      </div>
    </div>
  );
}

export default DockablePanel;