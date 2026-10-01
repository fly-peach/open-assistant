/**
 * 频道配置状态与分区的判定（见 spec channels-ui）。
 *
 * 这里锁住两条不变式：
 * 1. 必填没齐 → 未配置，**不许**出现在「已配置」分区
 * 2. 状态里没有「已连接」这种取值 —— 运行时还没去连接，不假装有连接
 */
import { describe, expect, test } from "bun:test";

import {
  channelStateOf,
  channelStateStyle,
  groupChannels,
  isConfigured,
  type ChannelLike,
} from "../src/app/utils/channelState";

const ch = (key: string, missing: string[], enabled: boolean): ChannelLike => ({ key, missing, enabled });

describe("配置状态", () => {
  test("必填没齐 → 未配置（哪怕已经启用）", () => {
    expect(channelStateOf(ch("qq", ["app_id"], false))).toBe("not-configured");
    // 即使 enabled=true，只要必填没齐就还是未配置
    expect(channelStateOf(ch("qq", ["app_id"], true))).toBe("not-configured");
  });

  test("必填齐了 → 已配置；再启用 → 已启用", () => {
    expect(channelStateOf(ch("qq", [], false))).toBe("configured");
    expect(channelStateOf(ch("qq", [], true))).toBe("enabled");
  });

  test("状态里不存在「已连接」——不假装有连接", () => {
    const all = [
      channelStateOf(ch("a", [], true)),
      channelStateOf(ch("a", [], false)),
      channelStateOf(ch("a", ["x"], true)),
    ];
    expect(all.sort()).toEqual(["configured", "enabled", "not-configured"]);
    expect(all.some((s) => /connect/i.test(s))).toBe(false);
  });

  test("颜色只是辅助信号（三种状态都有色，但文字才是主信号）", () => {
    for (const state of ["not-configured", "configured", "enabled"] as const) {
      expect(channelStateStyle(state).color.length).toBeGreaterThan(0);
    }
    expect(channelStateStyle("enabled").color).not.toBe(channelStateStyle("not-configured").color);
  });
});

describe("分区", () => {
  test("已添加但必填没齐的，落在未配置而不是已配置", () => {
    const { configured, unconfigured } = groupChannels([ch("qq", ["app_id"], false)], []);
    expect(configured).toEqual([]);
    expect(unconfigured.map(([v]) => v.key)).toEqual(["qq"]);
    expect(unconfigured[0]![1]).toBe(true); // 已添加 → 给「配置」按钮
  });

  test("目录里还没加的也在未配置，且标为未添加", () => {
    const { configured, unconfigured } = groupChannels([], [ch("qq", [], false), ch("feishu", [], false)]);
    expect(configured).toEqual([]);
    expect(unconfigured.map(([v]) => v.key)).toEqual(["qq", "feishu"]);
    expect(unconfigured.every(([, added]) => added === false)).toBe(true);
  });

  test("必填齐全的移到已配置", () => {
    const { configured, unconfigured } = groupChannels(
      [ch("qq", [], true), ch("feishu", ["app_secret"], false)],
      [],
    );
    expect(configured.map((v) => v.key)).toEqual(["qq"]);
    expect(unconfigured.map(([v]) => v.key)).toEqual(["feishu"]);
  });

  test("已添加但没填完的排在未添加的前面（别让它跳位置）", () => {
    const { unconfigured } = groupChannels([ch("feishu", ["app_secret"], false)], [ch("qq", [], false)]);
    expect(unconfigured.map(([v]) => v.key)).toEqual(["feishu", "qq"]);
  });

  test("全部齐全时未配置为空（界面据此不渲染该分区）", () => {
    const { configured, unconfigured } = groupChannels([ch("qq", [], false), ch("feishu", [], true)], []);
    expect(configured.length).toBe(2);
    expect(unconfigured).toEqual([]);
  });

  test("isConfigured 与状态一致", () => {
    expect(isConfigured(ch("a", [], false))).toBe(true);
    expect(isConfigured(ch("a", ["x"], false))).toBe(false);
  });
});