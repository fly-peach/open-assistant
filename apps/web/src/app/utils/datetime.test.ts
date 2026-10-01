import { describe, expect, test } from "bun:test";

import { isoToLocalInput, localDateKey, localInputToIso } from "@/app/utils/datetime";

describe("isoToLocalInput / localInputToIso", () => {
  test("往返一致（本地时间）", () => {
    const iso = new Date(2026, 9, 3, 9, 30).toISOString();
    const local = isoToLocalInput(iso);
    expect(local).toBe("2026-10-03T09:30");
    expect(localInputToIso(local)).toBe(iso);
  });

  test("空 / 非法 → 空值", () => {
    expect(isoToLocalInput(null)).toBe("");
    expect(isoToLocalInput(undefined)).toBe("");
    expect(isoToLocalInput("nope")).toBe("");
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("nope")).toBeNull();
  });
});

describe("localDateKey", () => {
  test("按本地日期给出 YYYY-MM-DD", () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 0))).toBe("2026-01-05");
    expect(localDateKey("nope")).toBe("");
  });
});