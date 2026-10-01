/**
 * tasks 8.9 / 8.11 的纯函数覆盖：绝对路径判定、面包屑、拼接、中间省略。
 */
import { describe, expect, test } from "bun:test";
import {
  basename,
  isAbsolutePath,
  joinPath,
  middleEllipsis,
  pathBreadcrumbs,
} from "@/app/utils/path";

describe("绝对路径判定", () => {
  test("接受 POSIX / Windows / UNC 绝对路径", () => {
    expect(isAbsolutePath("/home/me/notes")).toBe(true);
    expect(isAbsolutePath("C:\\Users\\me")).toBe(true);
    expect(isAbsolutePath("C:/Users/me")).toBe(true);
    expect(isAbsolutePath("\\\\host\\share\\dir")).toBe(true);
  });

  test("拒绝旧 id / 相对路径 / 空值", () => {
    expect(isAbsolutePath("default")).toBe(false);
    expect(isAbsolutePath("./notes")).toBe(false);
    expect(isAbsolutePath("apps/server/.workspaces/default")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
    expect(isAbsolutePath("   ")).toBe(false);
    expect(isAbsolutePath(null)).toBe(false);
    expect(isAbsolutePath(undefined)).toBe(false);
  });
});

describe("路径面包屑", () => {
  test("POSIX 从根逐层", () => {
    expect(pathBreadcrumbs("/home/me/notes")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "me", path: "/home/me" },
      { label: "notes", path: "/home/me/notes" },
    ]);
  });

  test("Windows 盘符作为第一段", () => {
    expect(pathBreadcrumbs("C:\\Users\\me")).toEqual([
      { label: "C:\\", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "me", path: "C:\\Users\\me" },
    ]);
  });

  test("相对路径（旧 id）返回空，供调用方提示重选", () => {
    expect(pathBreadcrumbs("default")).toEqual([]);
    expect(pathBreadcrumbs("")).toEqual([]);
  });
});

describe("目录名与拼接", () => {
  test("basename 兼容两种分隔符", () => {
    expect(basename("/home/me/notes")).toBe("notes");
    expect(basename("C:\\Users\\me")).toBe("me");
    expect(basename("/")).toBe("/");
  });

  test("joinPath 保留分隔符风格", () => {
    expect(joinPath("/home/me", "notes")).toBe("/home/me/notes");
    expect(joinPath("/", "notes")).toBe("/notes");
    expect(joinPath("C:\\Users", "me")).toBe("C:\\Users\\me");
    expect(joinPath("C:\\", "me")).toBe("C:\\me");
  });
});

describe("路径过长时的中间省略（8.11）", () => {
  test("不超长时原样返回", () => {
    expect(middleEllipsis("/home/me", { max: 20 })).toBe("/home/me");
  });

  test("超长时保留首尾、省略中间，且长度不超过上限", () => {
    const long = "/home/me/very-long-workspace-name-with-many-segments/notes/2024";
    const display = middleEllipsis(long, { max: 30, tail: 14 });
    expect(display.length).toBeLessThanOrEqual(30);
    expect(display).toContain("…");
    expect(display.startsWith("/home/me")).toBe(true);
    expect(display.endsWith("notes/2024")).toBe(true);
    expect(display).not.toBe(long);
  });

  test("最大长度很小的退化情况也不抛错", () => {
    const long = "/aaaa/bbbb/cccc";
    const display = middleEllipsis(long, { max: 8, tail: 4 });
    expect(display.length).toBeLessThanOrEqual(8);
    expect(display).toContain("…");
  });
});