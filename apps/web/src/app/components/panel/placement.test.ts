import { describe, expect, test } from "bun:test";
import {
  clampPanelPosition,
  DOCK_EDGE,
  floatPanelSize,
  isInDockZone,
  PANEL_MARGIN,
  reservedDockWidth,
} from "@/app/components/panel/placement";

const viewport = { width: 1200, height: 800 };

describe("可停靠面板 · 视口约束（10.6）", () => {
  test("正常范围内的坐标原样返回", () => {
    expect(
      clampPanelPosition({ x: 400, y: 100 }, { width: 360, height: 600 }, viewport)
    ).toEqual({ x: 400, y: 100 });
  });

  test("拖向左上越界时贴住左边距", () => {
    expect(
      clampPanelPosition({ x: -999, y: -999 }, { width: 360, height: 600 }, viewport)
    ).toEqual({ x: PANEL_MARGIN, y: PANEL_MARGIN });
  });

  test("拖向右下越界时保留可见边距", () => {
    expect(
      clampPanelPosition({ x: 99999, y: 99999 }, { width: 360, height: 600 }, viewport)
    ).toEqual({ x: 1200 - 360 - PANEL_MARGIN, y: 800 - 600 - PANEL_MARGIN });
  });

  test("缩放窗口后仍然在视口内", () => {
    const small = { width: 500, height: 400 };
    const size = floatPanelSize(small, 360);
    const clamped = clampPanelPosition({ x: 1000, y: 1000 }, size, small);
    expect(clamped.x + size.width).toBeLessThanOrEqual(small.width);
    expect(clamped.y + size.height).toBeLessThanOrEqual(small.height);
  });

  test("面板比视口还大时不返回负坐标", () => {
    const clamped = clampPanelPosition(
      { x: 100, y: 100 },
      { width: 2000, height: 2000 },
      { width: 300, height: 300 }
    );
    expect(clamped).toEqual({ x: PANEL_MARGIN, y: PANEL_MARGIN });
  });
});

describe("可停靠面板 · 吸附阈值（10.6）", () => {
  test("右侧面板推到右边侧才吸附（向左拖出不吸附）", () => {
    // 锚点左边缘 840，面板已停靠在 840；向右推到 800 已超出阈值，仍判定吸附
    expect(isInDockZone(840, 840, "right")).toBe(true);
    expect(isInDockZone(800, 840, "right")).toBe(true);
    // 拖出到 700（离锚点超过 64）就不在吸附区
    expect(isInDockZone(700, 840, "right")).toBe(false);
    expect(isInDockZone(840 - DOCK_EDGE, 840, "right")).toBe(true);
  });
  test("左侧面板向左推入才吸附", () => {
    expect(isInDockZone(160, 96, "left")).toBe(true);
    expect(isInDockZone(96 + DOCK_EDGE, 96, "left")).toBe(true);
    expect(isInDockZone(200, 96, "left")).toBe(false);
  });
});

describe("可停靠面板 · 让位宽度（10.7 / 10.12）", () => {
  test("停靠且展开时让出完整宽度", () => {
    expect(reservedDockWidth(true, true, 360)).toBe(360);
  });
  test("浮动时内容区收回宽度", () => {
    expect(reservedDockWidth(true, false, 360)).toBe(0);
  });
  test("收起时让出宽度，重新打开即恢复", () => {
    expect(reservedDockWidth(false, true, 360)).toBe(0);
    expect(reservedDockWidth(true, true, 360)).toBe(360);
  });
  test("宽度为负时归零", () => {
    expect(reservedDockWidth(true, true, -10)).toBe(0);
  });
});

describe("可停靠面板 · 浮动尺寸（10.6）", () => {
  test("高度不超过上限也不超过视口", () => {
    expect(floatPanelSize(viewport, 360)).toEqual({ width: 360, height: 720 });
    expect(floatPanelSize({ width: 1200, height: 500 }, 360)).toEqual({
      width: 360,
      height: 500 - PANEL_MARGIN * 2,
    });
  });
  test("宽度超过视口时收缩到可用宽度", () => {
    expect(floatPanelSize({ width: 300, height: 500 }, 360).width).toBe(
      300 - PANEL_MARGIN * 2
    );
  });
});