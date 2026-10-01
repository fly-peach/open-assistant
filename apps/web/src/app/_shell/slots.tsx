"use client";

/**
 * 扩展插槽（任务 10.10，对齐 specs/app-shell「扩展插槽」）。
 *
 * 两个固定注入点：
 * - `content.statusBar`：内容区上方的状态栏；
 * - `overlay.global`：外壳最上层的全局浮层。
 *
 * 关键约束：**没有任何注册时插槽不得占位**——`Slot` 直接返回 `null`，
 * 不渲染包裹元素（浏览器验证会读 DOM 高度/节点是否存在）。
 * 注册方在 `useEffect` 里 `slotStore.register(...)` / `unregister(...)`。
 */
import React, {
  Fragment,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type SlotName = "content.statusBar" | "overlay.global";

export interface SlotRegistration {
  id: string;
  node: ReactNode;
  order: number;
}

const EMPTY: SlotRegistration[] = [];
const registry = new Map<SlotName, SlotRegistration[]>();
const listeners = new Set<() => void>();
let revision = 0;
const cache = new Map<SlotName, { revision: number; list: SlotRegistration[] }>();

function notify(): void {
  revision += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const slotStore = {
  subscribe,
  register(name: SlotName, id: string, node: ReactNode, order = 0): void {
    const current = registry.get(name) ?? [];
    const next = [
      ...current.filter((entry) => entry.id !== id),
      { id, node, order },
    ];
    registry.set(name, next);
    notify();
  },
  unregister(name: SlotName, id: string): void {
    const current = registry.get(name);
    if (!current) return;
    const next = current.filter((entry) => entry.id !== id);
    if (next.length === current.length) return;
    if (next.length === 0) registry.delete(name);
    else registry.set(name, next);
    notify();
  },
  /** 当前注册内容（按 order 稳定排序）。 */
  getSnapshot(name: SlotName): SlotRegistration[] {
    const current = registry.get(name);
    if (!current || current.length === 0) return EMPTY;
    const cached = cache.get(name);
    if (cached && cached.revision === revision) return cached.list;
    const list = [...current].sort((left, right) => left.order - right.order);
    cache.set(name, { revision, list });
    return list;
  },
  getServerSnapshot(name: SlotName): SlotRegistration[] {
    return this.getSnapshot(name);
  },
  /** 插槽是否有内容——无注册即不占位。 */
  hasContent(name: SlotName): boolean {
    return this.getSnapshot(name).length > 0;
  },
  /** 测试/调试用：清空所有插槽。 */
  clear(): void {
    registry.clear();
    cache.clear();
    notify();
  },
};

export function useSlotEntries(name: SlotName): SlotRegistration[] {
  return useSyncExternalStore(
    subscribe,
    () => slotStore.getSnapshot(name),
    () => slotStore.getServerSnapshot(name)
  );
}

interface SlotProps {
  name: SlotName;
  className?: string;
}

/** 无注册时返回 `null`（不渲染包裹元素，因此不占据可见空间）。 */
export function Slot({ name, className }: SlotProps) {
  const entries = useSlotEntries(name);
  if (entries.length === 0) return null;
  return (
    <div
      className={className}
      data-slot={name}
    >
      {entries.map((entry) => (
        <Fragment key={entry.id}>{entry.node}</Fragment>
      ))}
    </div>
  );
}