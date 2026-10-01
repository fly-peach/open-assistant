"use client";

/**
 * 导航配置的持久化（任务 10.4 / 10.5）。
 *
 * 放在模块级的 store 里，而不是某个 provider 上，原因有二：
 * 1. 导航区（壳层）与设置页各自独立挂载，必须看到同一份配置；
 * 2. `useSyncExternalStore` 会用 server snapshot 做首次水合，天然避免
 *    「localStorage 里的顺序」与「服务端渲染的默认顺序」打架导致的水合不一致。
 *
 * 持久化只碰 `NAV_CONFIG_KEY` 一个键：重置不会影响其他用户数据。
 */
import { useCallback, useSyncExternalStore } from "react";
import { NAV_ENTRIES, type NavEntry } from "./navRegistry";
import {
  DEFAULT_NAV_CONFIG,
  NAV_CONFIG_KEY,
  isHidden,
  moveEntry,
  moveEntryBefore,
  orderedKeys,
  parseNavConfig,
  resetNavConfig,
  toggleHidden,
  visibleEntries,
  type NavConfig,
} from "./navConfig";

function readFromStorage(): NavConfig {
  if (typeof window === "undefined") return { ...DEFAULT_NAV_CONFIG };
  try {
    const raw = window.localStorage.getItem(NAV_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_NAV_CONFIG };
    return parseNavConfig(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_NAV_CONFIG };
  }
}

let snapshot: NavConfig | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

/** 导航配置 store（也是开发环境浏览器验证的入口）。 */
export const navConfigStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** 客户端快照：首次读取时懒加载 localStorage。 */
  getSnapshot(): NavConfig {
    if (snapshot === null) snapshot = readFromStorage();
    return snapshot;
  },
  /** 服务端 / 水合快照：默认配置。 */
  getServerSnapshot(): NavConfig {
    return DEFAULT_NAV_CONFIG;
  },
  write(next: NavConfig): void {
    snapshot = next;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(NAV_CONFIG_KEY, JSON.stringify(next));
      } catch {
        /* 存储不可用时只影响持久化，不影响本次会话 */
      }
    }
    emit();
  },
  reset(): void {
    this.write(resetNavConfig());
  },
  /** 测试/调试用：丢弃内存快照，下次读取重新落盘。 */
  reload(): void {
    snapshot = readFromStorage();
    emit();
  },
};

export interface UseNavConfigResult {
  config: NavConfig;
  /** 当前显示的条目（已排序、已过滤隐藏）。 */
  visible: NavEntry[];
  /** 全部条目（注册顺序）。 */
  all: NavEntry[];
  keys: string[];
  hidden: (entry: NavEntry) => boolean;
  moveUp: (key: string) => void;
  moveDown: (key: string) => void;
  moveBefore: (key: string, targetKey: string) => void;
  toggle: (key: string) => void;
  reset: () => void;
}

export function useNavConfig(): UseNavConfigResult {
  const config = useSyncExternalStore(
    navConfigStore.subscribe,
    navConfigStore.getSnapshot,
    navConfigStore.getServerSnapshot
  );

  const moveUp = useCallback((key: string) => {
    navConfigStore.write(
      moveEntry(NAV_ENTRIES, navConfigStore.getSnapshot(), key, -1)
    );
  }, []);
  const moveDown = useCallback((key: string) => {
    navConfigStore.write(
      moveEntry(NAV_ENTRIES, navConfigStore.getSnapshot(), key, 1)
    );
  }, []);
  const moveBefore = useCallback((key: string, targetKey: string) => {
    navConfigStore.write(
      moveEntryBefore(NAV_ENTRIES, navConfigStore.getSnapshot(), key, targetKey)
    );
  }, []);
  const toggle = useCallback((key: string) => {
    navConfigStore.write(
      toggleHidden(NAV_ENTRIES, navConfigStore.getSnapshot(), key)
    );
  }, []);
  const reset = useCallback(() => {
    navConfigStore.reset();
  }, []);

  return {
    config,
    visible: visibleEntries(NAV_ENTRIES, config),
    all: NAV_ENTRIES as NavEntry[],
    keys: orderedKeys(NAV_ENTRIES, config),
    hidden: (entry: NavEntry) => isHidden(entry, config),
    moveUp,
    moveDown,
    moveBefore,
    toggle,
    reset,
  };
}