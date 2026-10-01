/**
 * 9.9 / 9.10 / 9.11 的纯逻辑测试：
 * 初始化的展示文案必须能区分「两件套全缺 / 只缺一个」，结果提示必须分别列出
 * 新建与跳过的文件（不覆盖同名文件）。
 */
import { describe, expect, test } from "bun:test";
import {
  initFileItems,
  initHint,
  initResultLines,
  missingInitFiles,
} from "@/app/utils/workspaceInit";
import zh, { t } from "@/i18n/zh";
import type { WorkspaceStatus } from "@/lib/workspaceApi";

/**
 * `initialized` 以后端语义为准：人设文件（AGENTS.md）就位即算已初始化。
 * 刻意不把 BOOTSTRAP.md 算进来 —— 它是一次性剧本，引导完成后会被删掉，
 * 若把它当作初始化条件，引导一结束初始化入口就会重新出现（见 workspace.ts 注释）。
 */
function status(
  agentsMd: boolean,
  bootstrapMd: boolean,
  bootstrapCompleted = false
): WorkspaceStatus {
  return { initialized: agentsMd, files: { agentsMd, bootstrapMd, bootstrapCompleted } };
}

describe("工作区初始化展示（9.9）", () => {
  test("两件套全缺：提示明确会写入 AGENTS.md 与 BOOTSTRAP.md", () => {
    const s = status(false, false);
    expect(initHint(s)).toBe(zh.workspace.initMissingBoth);
    expect(initHint(s)).toContain("AGENTS.md");
    expect(initHint(s)).toContain("BOOTSTRAP.md");
    expect(missingInitFiles(s)).toEqual(["AGENTS.md", "BOOTSTRAP.md"]);
  });

  test("只缺 BOOTSTRAP.md：文案与人设缺失时不同，且不声称会写 AGENTS.md", () => {
    const s = status(true, false);
    expect(initHint(s)).toBe(zh.workspace.initMissingBootstrap);
    expect(initHint(s)).not.toBe(zh.workspace.initMissingBoth);
    expect(missingInitFiles(s)).toEqual(["BOOTSTRAP.md"]);
  });

  test("只缺 AGENTS.md：文案与只缺引导时不同", () => {
    const s = status(false, true);
    expect(initHint(s)).toBe(zh.workspace.initMissingAgents);
    expect(missingInitFiles(s)).toEqual(["AGENTS.md"]);
  });

  test("逐项状态分别可见（存在与否）", () => {
    const items = initFileItems(status(true, false));
    expect(items.map((item) => [item.name, item.exists])).toEqual([
      ["AGENTS.md", true],
      ["BOOTSTRAP.md", false],
    ]);
    expect(items[0].role).toBe("人设");
    expect(items[1].role).toBe("首次引导");
  });
});

describe("初始化结果提示（9.10）", () => {
  test("新建 + 跳过分别列出", () => {
    const lines = initResultLines(["AGENTS.md"], ["BOOTSTRAP.md"]);
    expect(lines).toEqual([
      t(zh.workspace.initCreated, { files: "AGENTS.md" }),
      t(zh.workspace.initSkipped, { files: "BOOTSTRAP.md" }),
    ]);
  });

  test("全部跳过时只提示跳过", () => {
    const lines = initResultLines([], ["AGENTS.md", "BOOTSTRAP.md"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("AGENTS.md");
    expect(lines[0]).toContain("BOOTSTRAP.md");
  });

  test("无可写文件时给出中性提示", () => {
    expect(initResultLines([], [])).toEqual([zh.workspace.initNoneNeeded]);
  });
});

describe("初始化错误文案（9.11）", () => {
  test("失败文案带原始错误信息且可读", () => {
    const text = t(zh.workspace.initFailed, { error: "EACCES: permission denied" });
    expect(text).toContain("初始化失败");
    expect(text).toContain("EACCES: permission denied");
  });
});