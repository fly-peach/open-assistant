/**
 * 导航配置（任务 10.3 / 10.4 / 10.5，对齐 specs/app-shell「导航条目可配置」）。
 *
 * 这里只放**纯函数**：条目顺序与显隐的计算、localStorage 载荷的解析与校验。
 * 具体条目表在 `navRegistry.ts`，持久化在 `navConfigStore.ts`。
 *
 * 约定：
 * - `order` 只记录用户调整过的完整顺序；表里新增的条目自动落在末尾（按注册顺序）；
 * - `hidden` 只记录被隐藏的条目；核心条目即使出现在 `hidden` 里也会被忽略（不可隐藏）。
 */

export type NavSource = "core" | "builtin" | "extension";

export interface NavEntryLike {
  key: string;
  core: boolean;
}

export interface NavConfig {
  /** 导航条目的顺序（条目 key）。 */
  order: string[];
  /** 被隐藏的条目 key（核心条目无效）。 */
  hidden: string[];
}

export const NAV_CONFIG_KEY = "open-assistant.nav-config";

export const DEFAULT_NAV_CONFIG: NavConfig = { order: [], hidden: [] };

/** 把一个未知值（localStorage 里的 JSON）收敛成合法的 `NavConfig`。 */
export function parseNavConfig(raw: unknown): NavConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_NAV_CONFIG };
  const record = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === "string"))]
      : [];
  return { order: strings(record.order), hidden: strings(record.hidden) };
}

export function serializeNavConfig(config: NavConfig): string {
  return JSON.stringify({ order: config.order, hidden: config.hidden });
}

export function isDefaultNavConfig(config: NavConfig): boolean {
  return config.order.length === 0 && config.hidden.length === 0;
}

/** 条目是否可隐藏：核心条目固定可见（spec：核心条目不可隐藏）。 */
export function isHideable(entry: NavEntryLike): boolean {
  return !entry.core;
}

export function isHidden(entry: NavEntryLike, config: NavConfig): boolean {
  return isHideable(entry) && config.hidden.includes(entry.key);
}

/** 按 `config.order` 排序：未出现在 order 里的条目保持注册顺序并排在已知条目之后。 */
export function orderEntries<T extends NavEntryLike>(
  entries: readonly T[],
  config: NavConfig
): T[] {
  const rank = new Map<string, number>();
  config.order.forEach((key, index) => {
    if (!rank.has(key)) rank.set(key, index);
  });
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftRank = rank.get(left.entry.key);
      const rightRank = rank.get(right.entry.key);
      if (leftRank !== undefined && rightRank !== undefined) {
        return leftRank - rightRank;
      }
      if (leftRank !== undefined) return -1;
      if (rightRank !== undefined) return 1;
      return left.index - right.index;
    })
    .map((item) => item.entry);
}

/** 当前实际显示的条目（已排序、已过滤隐藏）。 */
export function visibleEntries<T extends NavEntryLike>(
  entries: readonly T[],
  config: NavConfig
): T[] {
  return orderEntries(entries, config).filter(
    (entry) => !isHidden(entry, config)
  );
}

export function orderedKeys(
  entries: readonly NavEntryLike[],
  config: NavConfig
): string[] {
  return orderEntries(entries, config).map((entry) => entry.key);
}

/**
 * 把 `key` 在**可见条目**中移动 `delta` 位（-1 上移 / +1 下移）。
 * 移动在完整顺序上落位，因此隐藏条目不会打乱相对次序。
 */
export function moveEntry(
  entries: readonly NavEntryLike[],
  config: NavConfig,
  key: string,
  delta: number
): NavConfig {
  const order = orderedKeys(entries, config);
  const visible = visibleEntries(entries, config).map((entry) => entry.key);
  const from = visible.indexOf(key);
  if (from < 0) return config;
  const target = visible[from + delta];
  if (!target) return config;
  const next = [...order];
  const sourceIndex = next.indexOf(key);
  const targetIndex = next.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0) return config;
  next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, key);
  return { ...config, order: next };
}

/** 把 `key` 插到 `targetKey` 前面（拖拽落位）。 */
export function moveEntryBefore(
  entries: readonly NavEntryLike[],
  config: NavConfig,
  key: string,
  targetKey: string
): NavConfig {
  if (key === targetKey) return config;
  const order = orderedKeys(entries, config);
  const sourceIndex = order.indexOf(key);
  const targetIndex = order.indexOf(targetKey);
  if (sourceIndex < 0 || targetIndex < 0) return config;
  const next = [...order];
  next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, key);
  return { ...config, order: next };
}

/** 切换显隐；核心条目直接原样返回（不可隐藏）。 */
export function toggleHidden(
  entries: readonly NavEntryLike[],
  config: NavConfig,
  key: string
): NavConfig {
  const entry = entries.find((item) => item.key === key);
  if (!entry || !isHideable(entry)) return config;
  const hidden = config.hidden.includes(key)
    ? config.hidden.filter((item) => item !== key)
    : [...config.hidden, key];
  return { ...config, hidden };
}

/** 恢复默认顺序与显隐（只影响导航配置本身）。 */
export function resetNavConfig(): NavConfig {
  return { ...DEFAULT_NAV_CONFIG };
}

/** 与当前 URL 匹配的条目：精确优先，其次最长前缀（`/todos/1` → `/todos`）。 */
export function matchEntryByPath<T extends { path: string }>(
  entries: readonly T[],
  pathname: string
): T | undefined {
  const exact = entries.find((entry) => entry.path === pathname);
  if (exact) return exact;
  const prefixed = entries
    .filter(
      (entry) => entry.path !== "/" && pathname.startsWith(`${entry.path}/`)
    )
    .sort((left, right) => right.path.length - left.path.length);
  return prefixed[0];
}