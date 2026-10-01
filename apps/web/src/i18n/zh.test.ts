/**
 * 3.1 校验：界面「内置文案」是否全部来自 `src/i18n/zh.ts`。
 *
 * 为什么用测试而不是人肉 grep：文案会持续增加，漏翻的英文只能靠机械检查兜住。
 * 检查范围刻意收窄，避免误报：
 * - JSX 文本节点（`>文字<`）；
 * - `placeholder` / `aria-label` / `title` / `alt` 这几个直接面向用户的属性。
 * 技术标识（类名、CSS 变量、语言名、专有名词白名单）不算文案。
 *
 * 注意：**对话内容**（用户/助手/工具正文）不在此范围，spec 明确不翻译。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dir, "..");
const SKIP_FILES = new Set(["i18n/zh.ts", "i18n/zh.test.ts"]);

/** 专有名词 / 技术标识白名单（出现在文案里但不应翻译）。 */
const ALLOWED_VALUES = new Set([
  "LangSmith",
  "LangSmith API Key",
  "JSON",
  "TODO",
  "ID",
  "API",
  "URL",
  "AI",
  "Deep Agent",
  "e.g.",
  "vs",
  "md",
  "ts",
  "tsx",
  "js",
  "css",
  "http",
  "https",
  "stdout",
  "stderr",
  "true",
  "false",
  "null",
  "undefined",
  "utf-8",
]);

/** 一个值是否是「技术串」（正则、类名、路径、CSS 值等）。 */
function isTechnical(value: string): boolean {
  const v = value.trim();
  if (v === "") return true;
  if (ALLOWED_VALUES.has(v)) return true;
  // 只有短 token（1-4 个字母）多半是缩写/变量名
  if (/^[A-Za-z]{1,4}$/.test(v)) return true;
  // 含 CSS 变量、选择器、尖括号模板、路径分隔等
  if (/[{};:#()[\]@$&|\\/^~<>]/.test(v)) return true;
  if (/^-{1,2}[a-z]/.test(v)) return true;
  if (/(^|\s)(var|rgba?|hsla?|calc|hsl)\(/.test(v)) return true;
  // 全部由小写/数字/点/横线组成且不含空格 → 像类名或标识符
  if (/^[a-z0-9._-]+$/.test(v)) return true;
  return false;
}

interface Hit {
  file: string;
  line: number;
  kind: string;
  value: string;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  const files: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        walk(full);
      } else if (/\.(tsx|ts)$/.test(entry)) {
        files.push(full);
      }
    }
  };
  walk(SRC);

  for (const file of files) {
    const rel = relative(SRC, file).split(sep).join("/");
    if (SKIP_FILES.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/^\s*(import|export)\s/.test(line) || /\bfrom\s+"/.test(line)) return;
      // 类型/函数声明行（Promise<void>、=> Promise<void> 之类）不是文案
      if (/=>/.test(line)) return;
      if (/^\s*(export\s+)?(interface|type)\b/.test(line)) return;

      // JSX 文本节点
      for (const match of line.matchAll(/>([^<>{}]{2,80})</g)) {
        const value = match[1].trim();
        if (!/[A-Za-z]/.test(value)) continue;
        if (isTechnical(value)) continue;
        hits.push({ file: rel, line: index + 1, kind: "text", value });
      }

      // 面向用户的属性
      for (const match of line.matchAll(
        /\b(placeholder|aria-label|title|alt)\s*=\s*"([^"]*)"/g
      )) {
        const value = match[2].trim();
        if (!/[A-Za-z]/.test(value)) continue;
        if (isTechnical(value)) continue;
        hits.push({ file: rel, line: index + 1, kind: match[1], value });
      }
    });
  }

  return hits;
}

describe("界面文案集中化（3.1）", () => {
  test("除 zh.ts 外，界面内置文案里不存在英文原文", () => {
    const hits = scan();
    const report = hits
      .map((hit) => `${hit.file}:${hit.line} [${hit.kind}] ${hit.value}`)
      .join("\n");
    expect(report).toBe("");
  });

  test("中文字案确实来自 zh.ts（模块可用且可插值）", async () => {
    const zh = (await import("@/i18n/zh")).default;
    expect(zh.chat.send).toBe("发送");
    expect(zh.app.title).toBe("智能助手");
  });
});