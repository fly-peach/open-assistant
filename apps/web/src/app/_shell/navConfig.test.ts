/**
 * 任务 10.3 / 10.4 / 10.5 的机械校验：
 * - 导航数据表字段完整（key / label / icon / path / 是否核心 / 来源）；
 * - 核心条目不可隐藏；
 * - 排序、显隐、重置的计算只作用于导航配置本身。
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NAV_CONFIG,
  isHidden,
  matchEntryByPath,
  moveEntry,
  moveEntryBefore,
  orderedKeys,
  parseNavConfig,
  resetNavConfig,
  serializeNavConfig,
  toggleHidden,
  visibleEntries,
  type NavEntryLike,
} from "@/app/_shell/navConfig";
import { NAV_ENTRIES, isImmersivePath, matchNavEntry } from "@/app/_shell/navRegistry";

const KEYS = NAV_ENTRIES.map((entry) => entry.key);

describe("导航数据表（10.3）", () => {
  test("每条记录都带 key / label / icon / path / 是否核心 / 来源", () => {
    for (const entry of NAV_ENTRIES) {
      expect(entry.key.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(typeof entry.icon === "function" || typeof entry.icon === "object").toBe(
        true
      );
      expect(entry.path.startsWith("/")).toBe(true);
      expect(typeof entry.core).toBe("boolean");
      expect(["core", "builtin", "extension"]).toContain(entry.source);
    }
    expect(new Set(KEYS).size).toBe(KEYS.length);
  });

  test("核心条目是对话与设置，且核心来源一定标成 core", () => {
    expect(NAV_ENTRIES.filter((entry) => entry.core).map((e) => e.key)).toEqual([
      "chat",
      "settings",
    ]);
    for (const entry of NAV_ENTRIES) {
      if (entry.core) expect(entry.source).toBe("core");
    }
  });

  test("路径匹配：精确优先，其次最长前缀", () => {
    expect(matchNavEntry("/")?.key).toBe("chat");
    expect(matchNavEntry("/settings")?.key).toBe("settings");
    expect(matchNavEntry("/todos/abc")?.key).toBe("todos");
    expect(matchNavEntry("/unknown")).toBeUndefined();
  });

  test("只有被标记的页面才是沉浸式（10.11）", () => {
    const immersive = NAV_ENTRIES.filter((entry) => entry.immersive).map(
      (entry) => entry.key
    );
    // 专注模式页面已按需求删除；`immersive` 机制保留在壳层里，当前无任何条目使用它。
    expect(immersive).toEqual([]);
    expect(isImmersivePath("/")).toBe(false);
    expect(isImmersivePath("/settings")).toBe(false);
    expect(isImmersivePath("/error-demo/recoverable")).toBe(false);
  });
});

describe("核心条目不可隐藏（10.3）", () => {
  test("toggleHidden 对核心条目是空操作", () => {
    const config = toggleHidden(NAV_ENTRIES, DEFAULT_NAV_CONFIG, "chat");
    expect(config.hidden).toEqual([]);
    expect(visibleEntries(NAV_ENTRIES, config).map((e) => e.key)).toEqual(KEYS);
  });

  test("即使配置里被人为写进核心条目，也依然可见", () => {
    const config = parseNavConfig({ hidden: ["chat", "settings", "cron"] });
    const visible = visibleEntries(NAV_ENTRIES, config).map((e) => e.key);
    expect(visible).toContain("chat");
    expect(visible).toContain("settings");
    expect(visible).not.toContain("cron");
  });

  test("扩展条目可隐藏也可恢复", () => {
    const config = toggleHidden(NAV_ENTRIES, DEFAULT_NAV_CONFIG, "cron");
    expect(visibleEntries(NAV_ENTRIES, config).map((e) => e.key)).not.toContain(
      "cron"
    );
    const restored = toggleHidden(NAV_ENTRIES, config, "cron");
    expect(visibleEntries(NAV_ENTRIES, restored).map((e) => e.key)).toContain(
      "cron"
    );
  });
});

describe("排序与持久化载荷（10.4）", () => {
  test("上移 / 下移只换相邻可见条目的位置", () => {
    const up = moveEntry(NAV_ENTRIES, DEFAULT_NAV_CONFIG, "todos", -1);
    expect(orderedKeys(NAV_ENTRIES, up).slice(0, 2)).toEqual(["todos", "chat"]);
    const down = moveEntry(NAV_ENTRIES, up, "todos", 1);
    expect(orderedKeys(NAV_ENTRIES, down).slice(0, 2)).toEqual(["chat", "todos"]);
  });

  test("越界移动不改变配置", () => {
    const config = moveEntry(NAV_ENTRIES, DEFAULT_NAV_CONFIG, "chat", -1);
    expect(config).toEqual(DEFAULT_NAV_CONFIG);
  });

  test("隐藏条目不参与相邻移动，但相对次序不乱", () => {
    const hiddenCron = toggleHidden(NAV_ENTRIES, DEFAULT_NAV_CONFIG, "cron");
    const moved = moveEntry(NAV_ENTRIES, hiddenCron, "memory", -1);
    const before = orderedKeys(NAV_ENTRIES, hiddenCron).indexOf("memory");
    const order = orderedKeys(NAV_ENTRIES, moved);
    // 不复用具体邻居名（导航表会变）：只断言「确实上移了」
    expect(order.indexOf("memory")).toBeLessThan(before);
    expect(order).toContain("cron");
  });

  test("拖拽落位（moveEntryBefore）插到目标之前", () => {
    const config = moveEntryBefore(NAV_ENTRIES, DEFAULT_NAV_CONFIG, "settings", "todos");
    expect(orderedKeys(NAV_ENTRIES, config).slice(0, 3)).toEqual([
      "chat",
      "settings",
      "todos",
    ]);
  });

  test("顺序可序列化后原样读回（刷新保持）", () => {
    const config = moveEntry(NAV_ENTRIES, DEFAULT_NAV_CONFIG, "todos", -1);
    const roundTrip = parseNavConfig(JSON.parse(serializeNavConfig(config)));
    expect(roundTrip).toEqual(config);
    expect(orderedKeys(NAV_ENTRIES, roundTrip)).toEqual(
      orderedKeys(NAV_ENTRIES, config)
    );
  });

  test("表里新增的条目排在用户配置过的条目之后，且保持注册顺序", () => {
    const entries: NavEntryLike[] = [
      { key: "a", core: false },
      { key: "b", core: false },
      { key: "c", core: false },
    ];
    const config = parseNavConfig({ order: ["c", "a"] });
    expect(orderedKeys(entries, config)).toEqual(["c", "a", "b"]);
  });

  test("垃圾载荷被收敛成默认配置", () => {
    expect(parseNavConfig(null)).toEqual(DEFAULT_NAV_CONFIG);
    expect(parseNavConfig("nope")).toEqual(DEFAULT_NAV_CONFIG);
    expect(parseNavConfig({ order: [1, "a", "a"], hidden: {} })).toEqual({
      order: ["a"],
      hidden: [],
    });
  });
});

describe("重置只影响导航配置（10.5）", () => {
  test("resetNavConfig 返回默认顺序与显隐", () => {
    const mess = parseNavConfig({ order: ["memory"], hidden: ["cron", "todos"] });
    const cronEntry = NAV_ENTRIES.find((entry) => entry.key === "cron");
    expect(cronEntry).toBeDefined();
    expect(isHidden(cronEntry!, mess)).toBe(true);
    const reset = resetNavConfig();
    expect(reset).toEqual(DEFAULT_NAV_CONFIG);
    expect(orderedKeys(NAV_ENTRIES, reset)).toEqual(KEYS);
    expect(visibleEntries(NAV_ENTRIES, reset)).toHaveLength(NAV_ENTRIES.length);
  });
});