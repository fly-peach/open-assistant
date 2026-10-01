/**
 * 原生文件夹对话框：按平台生成命令（纯函数）。
 */
import { describe, expect, test } from "bun:test";

import { nativePickerCommand } from "../src/native-picker.js";

describe("原生文件夹对话框命令", () => {
  test("win32 → powershell -STA 弹 FolderBrowserDialog", () => {
    const cmd = nativePickerCommand("win32");
    expect(cmd?.file).toBe("powershell.exe");
    expect(cmd?.args).toContain("-STA");
    expect(cmd?.args.join(" ")).toContain("FolderBrowserDialog");
  });

  test("darwin → osascript choose folder", () => {
    const cmd = nativePickerCommand("darwin");
    expect(cmd?.file).toBe("osascript");
    expect(cmd?.args.join(" ")).toContain("choose folder");
  });

  test("linux → zenity 目录选择", () => {
    const cmd = nativePickerCommand("linux");
    expect(cmd?.file).toBe("zenity");
    expect(cmd?.args).toContain("--directory");
  });

  test("其它平台 → null（前端退回逐层浏览）", () => {
    expect(nativePickerCommand("freebsd" as NodeJS.Platform)).toBeNull();
  });
});