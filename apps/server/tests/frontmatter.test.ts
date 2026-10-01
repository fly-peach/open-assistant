/**
 * `wiki/frontmatter.ts` 的 YAML 块标量（`>` 折叠 / `|` 字面量）支持。
 *
 * 背景：`SPEC.md` 的契约是 **YAML frontmatter**，`description: >-` 这类块标量是合法 YAML。
 * 手写解析器原先把值读成字面量 `">-"`、把缩进续行静默丢弃 → 子 agent 全部 `valid:false`。
 * 这里锁死三件事：块标量语义、多行值的**安全渲染与往返一致**、以及**纯增量**（老形态不变）。
 */
import { describe, expect, test } from "bun:test";

import {
  isBlockScalarHeader,
  parseFrontmatter,
  renderFrontmatter,
  upsertFrontmatter,
} from "../src/wiki/frontmatter.js";

function doc(frontmatter: string, body = "正文\n"): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

function value(key: string, frontmatter: string): unknown {
  return parseFrontmatter(doc(frontmatter)).data[key];
}

describe("frontmatter：块标量解析（`>` 折叠 / `|` 字面量）", () => {
  test("`>-`：缩进续行被消费、折叠成空格；块标量之后仍能解析后续键", () => {
    const fm = parseFrontmatter(doc("name: trainer\ndescription: >-\n  第一行\n  第二行\ntools: [ls]"));
    expect(fm.ok).toBe(true);
    expect(fm.data["description"]).toBe("第一行 第二行");
    expect(fm.data["name"]).toBe("trainer");
    expect(fm.data["tools"]).toEqual(["ls"]);
  });

  test("`>` 折叠语义：空行变换行；`>` clip / `>-` strip / `>+` keep 的尾换行不同", () => {
    expect(value("k", "k: >\n  a\n  b")).toBe("a b\n");
    expect(value("k", "k: >-\n  a\n  b")).toBe("a b");
    expect(value("k", "k: >+\n  a\n  b")).toBe("a b\n");
    // 空行 → 换行（不是空格）
    expect(value("k", "k: >\n  a\n\n  b")).toBe("a\nb\n");
  });

  test("`|` 保留换行；`|-` 去尾换行 / `|+` 保留尾换行", () => {
    expect(value("k", "k: |\n  a\n  b")).toBe("a\nb\n");
    expect(value("k", "k: |-\n  a\n  b")).toBe("a\nb");
    expect(value("k", "k: |-")).toBe("");
    expect(value("k", "k: |+\n  a")).toBe("a\n");
    expect(value("k", "k: |\n  a")).toBe("a\n");
    expect(value("k", "k: |-\n  a")).toBe("a");
  });

  test("块缩进由首个非空续行决定；回到同级缩进即结束（后续键照常解析）", () => {
    const fm = parseFrontmatter(doc("description: |-\n  第一行\n  第二行\nmode: isolated"));
    expect(fm.data["description"]).toBe("第一行\n第二行");
    expect(fm.data["mode"]).toBe("isolated");

    // 更深的缩进以「首个非空续行」为基准，多出来的空格是内容的一部分
    expect(value("k", "k: |-\n    a\n      b")).toBe("a\n  b");
  });

  test("单行但长得像块标量头的值加引号，回读不歧义", () => {
    const text = renderFrontmatter({ description: ">-" });
    expect(text).toBe('---\ndescription: ">-"\n---\n');
    expect(parseFrontmatter(text + "正文\n").data["description"]).toBe(">-");
  });

  test("isBlockScalarHeader：只认形态正确的头", () => {
    for (const header of [">", ">-", ">+", "|", "|-", "|+", "|2-", "|2", ">2+"]) {
      expect(isBlockScalarHeader(header)).toBe(true);
    }
    for (const notHeader of [">-x", "abc", "", "[a]", "- a", ">x"]) {
      expect(isBlockScalarHeader(notHeader)).toBe(false);
    }
  });
});

describe("frontmatter：多行值的安全渲染（parse(render(x)) === x）", () => {
  const cases: Record<string, string> = {
    "单行": "单行",
    "两行": "a\nb",
    "尾换行 1": "a\nb\n",
    "中间空行": "a\n\nb",
    "尾换行 2": "a\n\n",
    "首行前导空白": "  a\nb",
    "只有换行": "\n",
    "续行前导空白": "a\n  b",
    "中文多行": "多行\n描述\n",
    "尾随空格": "a \nb",
  };

  for (const [label, text] of Object.entries(cases)) {
    test(`往返一致：${label}`, () => {
      const rendered = renderFrontmatter({ description: text });
      const back = parseFrontmatter(`${rendered}正文\n`);
      expect(back.ok).toBe(true);
      expect(back.data["description"]).toBe(text);
      expect(back.body).toBe("正文\n");
    });
  }

  test("多行值渲染成块标量而不是把换行写进单行（否则会损坏文件）", () => {
    const rendered = renderFrontmatter({ description: "第一行\n第二行" });
    expect(rendered).toBe("---\ndescription: |-\n  第一行\n  第二行\n---\n");
  });

  test("upsertFrontmatter 写回多行值不损坏文件、正文原样保留", () => {
    const page = "---\ntype: summary\ntitle: 标题\nsource:\n  - wiki/raw/a.md\n---\n正文第一行\n正文第二行\n";
    const next = upsertFrontmatter(page, { description: "第一行\n第二行" });
    const parsed = parseFrontmatter(next);
    expect(parsed.data["description"]).toBe("第一行\n第二行");
    expect(parsed.data["title"]).toBe("标题");
    expect(parsed.data["source"]).toEqual(["wiki/raw/a.md"]);
    expect(parsed.body).toBe("正文第一行\n正文第二行\n");
    // 幂等：再 upsert 一次结果不变
    expect(upsertFrontmatter(next, { description: "第一行\n第二行" })).toBe(next);
  });
});

describe("frontmatter：既有形态不受影响（纯增量回归）", () => {
  test("单行标量 / 方括号列表 / `- ` 列表 / 引号", () => {
    expect(value("type", "type: summary")).toBe("summary");
    expect(value("tools", "tools: [ls, read_file]")).toEqual(["ls", "read_file"]);
    expect(value("tools", "tools: []")).toEqual([]);
    expect(value("source", "source:\n  - a.md\n  - b.md")).toEqual(["a.md", "b.md"]);
    expect(value("title", 'title: "x y"')).toBe("x y");
    expect(value("title", "title: 'x y'")).toBe("x y");
    // 引号包起来的块标量头是普通字符串
    expect(value("k", 'k: ">"')).toBe(">");
    // 空值
    expect(value("k", "k:")).toBe("");
  });

  test("渲染端既有形态不变", () => {
    expect(renderFrontmatter({ type: "summary", n: "1" })).toBe("---\ntype: summary\nn: 1\n---\n");
    expect(renderFrontmatter({ source: [] })).toBe("---\nsource: []\n---\n");
    expect(renderFrontmatter({ source: ["a.md", "b.md"] })).toBe("---\nsource:\n  - a.md\n  - b.md\n---\n");
    expect(renderFrontmatter({ a: undefined, b: "x" })).toBe("---\nb: x\n---\n");
  });
});
