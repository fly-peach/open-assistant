/**
 * 项目 wiki 层（tasks 11.9–11.17）测试。
 *
 * 覆盖：骨架初始化与不覆盖（**不含 raw 层**）、SCHEMA 解析与页面归属校验、
 * index/log 增量维护与统一前缀、收录四类产物、以元数据判定已收录（改名不重复）、
 * 矛盾标记两处保留、答案回填成新页、体检只报告不改内容。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { initWorkspace } from "../src/workspace.js";
import {
  DEFAULT_SCHEMA_MD,
  archiveAnswer,
  ensureWikiSkeleton,
  findIngestedSource,
  ingestRawDocument,
  latestLogEntries,
  listWikiPages,
  lintWiki,
  loadWikiSchema,
  parseWikiSchema,
  readWikiIndex,
  readWikiLog,
  toWorkspaceRel,
  validatePageOwnership,
} from "../src/wiki/index.js";

let root: string;
let counter = 0;

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-wiki-")));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function freshDir(name: string): Promise<string> {
  counter += 1;
  const dir = path.join(root, `${name}-${counter}`);
  await fs.mkdir(dir, { recursive: true });
  // 源层 = 工作区里用户自己的文件；测试统一把源放在 sources/（普通文件夹，不是应用数据）
  await fs.mkdir(path.join(dir, "sources"), { recursive: true });
  return dir;
}

async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        result[`${rel}/`] = "";
        await walk(full, rel);
      } else {
        result[rel] = await fs.readFile(full, "utf8");
      }
    }
  }
  await walk(dir, "");
  return result;
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
};

describe("11.9 wiki 骨架初始化：齐全、幂等、不覆盖", () => {
  test("空工作区初始化后骨架齐全（SCHEMA / index / log / summaries / entities）", async () => {
    const dir = await freshDir("skeleton");
    const res = await ensureWikiSkeleton(dir);
    for (const rel of [
      "wiki/SCHEMA.md",
      "wiki/index.md",
      "wiki/log.md",
      "wiki/summaries",
      "wiki/entities",
      "wiki/entities/concept",
      "wiki/entities/paper",
      "wiki/entities/person",
      "wiki/entities/project",
    ]) {
      expect(await exists(path.join(dir, rel))).toBe(true);
    }
    expect(res.created).toContain("wiki/SCHEMA.md");
    expect(res.created).toContain("wiki/index.md");
    expect(res.created).toContain("wiki/log.md");
  });

  test("非空目录：不覆盖已有同名文件，一个字节都不变", async () => {
    const dir = await freshDir("skeleton-keep");
    await fs.mkdir(path.join(dir, "wiki"), { recursive: true });
    await fs.writeFile(path.join(dir, "wiki", "SCHEMA.md"), "# 我自己写的规范\n", "utf8");
    await fs.writeFile(path.join(dir, "wiki", "index.md"), "# 我的目录\n", "utf8");
    await fs.writeFile(path.join(dir, "sources", "keep.md"), "源文件，别动", "utf8");

    const res = await ensureWikiSkeleton(dir);
    expect(res.skipped).toContain("wiki/SCHEMA.md");
    expect(res.skipped).toContain("wiki/index.md");
    expect(res.created).not.toContain("wiki/SCHEMA.md");
    expect(await fs.readFile(path.join(dir, "wiki", "SCHEMA.md"), "utf8")).toBe("# 我自己写的规范\n");
    expect(await fs.readFile(path.join(dir, "wiki", "index.md"), "utf8")).toBe("# 我的目录\n");
    expect(await fs.readFile(path.join(dir, "sources", "keep.md"), "utf8")).toBe("源文件，别动");
  });

  test("initWorkspace 返回 wiki 字段，且第二次调用不覆盖", async () => {
    const dir = await freshDir("init-wiki");
    const first = await initWorkspace(dir);
    expect(first.wiki.created).toContain("wiki/SCHEMA.md");
    await fs.writeFile(path.join(dir, "wiki", "index.md"), "# 人工改过的目录\n", "utf8");
    const second = await initWorkspace(dir);
    expect(second.wiki.created).toEqual([]);
    expect(second.wiki.skipped).toContain("wiki/index.md");
    expect(await fs.readFile(path.join(dir, "wiki", "index.md"), "utf8")).toBe("# 人工改过的目录\n");
  });
});

describe("11.10 SCHEMA 解析结果用于校验页面归属", () => {
  test("默认 SCHEMA 解析出实体类型与目录约定", () => {
    const schema = parseWikiSchema(DEFAULT_SCHEMA_MD);
    expect(schema.source).toBe("file");
    expect(Object.keys(schema.entityTypes)).toEqual(
      expect.arrayContaining(["concept", "paper", "person", "project"]),
    );
    expect(schema.entityTypes["concept"].folder).toBe("wiki/entities/concept/");
    expect(schema.pageRoles["summary"]).toBe("wiki/summaries/");
  });

  test("页面归属校验：类型与目录必须匹配，未声明类型被拒", () => {
    const schema = parseWikiSchema(DEFAULT_SCHEMA_MD);
    expect(validatePageOwnership(schema, "wiki/entities/concept/attention.md", "concept").ok).toBe(true);
    expect(validatePageOwnership(schema, "wiki/entities/paper/attention.md", "paper").ok).toBe(true);
    expect(validatePageOwnership(schema, "wiki/summaries/x.md", "summary").ok).toBe(true);

    const wrongFolder = validatePageOwnership(schema, "wiki/entities/paper/attention.md", "concept");
    expect(wrongFolder.ok).toBe(false);
    expect(wrongFolder.reason).toContain("concept");

    const undeclared = validatePageOwnership(schema, "wiki/entities/unknown/x.md", "unknown");
    expect(undeclared.ok).toBe(false);
    expect(undeclared.reason).toContain("SCHEMA.md");

    // 未给类型时从路径反推
    expect(validatePageOwnership(schema, "wiki/entities/concept/x.md").type).toBe("concept");
    expect(validatePageOwnership(schema, "wiki/elsewhere/x.md").ok).toBe(false);
  });

  test("自定义 SCHEMA 的新实体类型被解析（可扩展）", async () => {
    const dir = await freshDir("schema-custom");
    await ensureWikiSkeleton(dir);
    await fs.writeFile(
      path.join(dir, "wiki", "SCHEMA.md"),
      "---\nversion: 2\nentity_types:\n  dataset: {label: 数据集, folder: wiki/entities/dataset/}\n---\n\n# 自定义\n",
      "utf8",
    );
    const schema = await loadWikiSchema(dir);
    expect(schema.entityTypes["dataset"]?.label).toBe("数据集");
    expect(validatePageOwnership(schema, "wiki/entities/dataset/x.md", "dataset").ok).toBe(true);
    // 再次初始化补出新增实体目录，且不动 SCHEMA
    const res = await ensureWikiSkeleton(dir);
    expect(res.dirs).toContain("wiki/entities/dataset");
    expect(await exists(path.join(dir, "wiki", "entities", "dataset"))).toBe(true);
  });
});

describe("11.12 index 增量维护与 log 统一前缀", () => {
  test("log 每条以 `## [YYYY-MM-DD] 动作 | 标题` 开头，最近 N 条可取出", async () => {
    const dir = await freshDir("log");
    await ensureWikiSkeleton(dir);
    for (let i = 1; i <= 7; i += 1) {
      await (await import("../src/wiki/index-log.js")).appendWikiLog(dir, {
        date: `2026-01-0${i}`,
        action: "ingest",
        title: `资料${i}`,
      });
    }
    const content = (await readWikiLog(dir)) ?? "";
    const last5 = latestLogEntries(content, 5);
    expect(last5.length).toBe(5);
    expect(last5.map((e) => e.title)).toEqual(["资料3", "资料4", "资料5", "资料6", "资料7"]);
    // 统一前缀：每一行都能被 `grep "^## \["` 取到
    const matched = content.split(/\r?\n/).filter((l) => /^## \[/.test(l));
    expect(matched.length).toBe(7);
    for (const line of matched) expect(line).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] \S+ \| /);
  });

  test("index 增量维护：同链接原地更新，不整体重写", async () => {
    const dir = await freshDir("index");
    await ensureWikiSkeleton(dir);
    const { upsertIndexEntry } = await import("../src/wiki/index-log.js");
    await upsertIndexEntry(dir, { section: "摘要", title: "A", link: "wiki/summaries/a.md", summary: "一句话" });
    await upsertIndexEntry(dir, { section: "实体", title: "B", link: "wiki/entities/concept/b.md", summary: "实体" });
    let content = (await readWikiIndex(dir)) ?? "";
    expect(content).toContain("- [A](summaries/a.md) — 一句话");
    expect(content).toContain("- [B](entities/concept/b.md) — 实体");
    // 更新同一条：摘要变化，行原地替换
    await upsertIndexEntry(dir, { section: "摘要", title: "A", link: "wiki/summaries/a.md", summary: "改过的一句话" });
    content = (await readWikiIndex(dir)) ?? "";
    expect(content).toContain("改过的一句话");
    expect(content.split("summaries/a.md").length - 1).toBe(1);
  });
});

describe("11.13 收录：摘要页 + index + log + 实体页四类产物", () => {
  test("一次收录全部落盘，且 index 里有链接", async () => {
    const dir = await freshDir("ingest");
    await ensureWikiSkeleton(dir);
    await fs.writeFile(
      path.join(dir, "sources", "attention.md"),
      "# 注意力机制\n\n注意力机制按相关性加权求和。\n",
      "utf8",
    );

    const result = await ingestRawDocument(dir, {
      rawPath: "sources/attention.md",
      summary: "注意力机制按相关性加权求和。",
      entities: [{ type: "concept", title: "注意力机制", claims: [{ topic: "作用", statement: "按相关性加权求和" }] }],
    });

    expect(result.ingested).toBe(true);
    expect(result.summaryPage).toBe("wiki/summaries/注意力机制.md");
    expect(await exists(path.join(dir, result.summaryPage as string))).toBe(true);
    expect(result.entityPages).toContain("wiki/entities/concept/注意力机制.md");
    expect(await exists(path.join(dir, "wiki/entities/concept/注意力机制.md"))).toBe(true);

    const summary = await fs.readFile(path.join(dir, result.summaryPage as string), "utf8");
    expect(summary).toContain("source:");
    expect(summary).toContain("sources/attention.md");

    const index = (await readWikiIndex(dir)) ?? "";
    expect(index).toContain("(summaries/注意力机制.md)");
    expect(index).toContain("(entities/concept/注意力机制.md)");

    const log = (await readWikiLog(dir)) ?? "";
    expect(log).toContain("] ingest | 注意力机制");
  });
});

describe("11.14 已收录判定以元数据 source 为准（改名不重复）", () => {
  test("改名原始资料后再次收录 → 不重复，命中 source_hash", async () => {
    const dir = await freshDir("rename");
    await ensureWikiSkeleton(dir);
    await fs.writeFile(path.join(dir, "sources", "one.md"), "# 一\n\n内容相同。\n", "utf8");
    const first = await ingestRawDocument(dir, { rawPath: "sources/one.md" });
    expect(first.ingested).toBe(true);
    const pagesAfterFirst = (await listWikiPages(dir)).length;

    // 改名（内容不变）
    await fs.rename(path.join(dir, "sources", "one.md"), path.join(dir, "sources", "renamed.md"));
    const lookup = await findIngestedSource(dir, { source: "sources/renamed.md", hash: first.sourceHash });
    expect(lookup.found).toBe(true);
    expect(lookup.by).toBe("source_hash");

    const second = await ingestRawDocument(dir, { rawPath: "sources/renamed.md" });
    expect(second.ingested).toBe(false);
    expect(second.reason).toBe("already_ingested");
    expect((await listWikiPages(dir)).length).toBe(pagesAfterFirst);
  });

  test("同名但内容不同 → 视为新资料，另起新页不覆盖", async () => {
    const dir = await freshDir("reingest-different");
    await ensureWikiSkeleton(dir);
    await fs.writeFile(path.join(dir, "sources", "a.md"), "# A\n\n第一版。\n", "utf8");
    const first = await ingestRawDocument(dir, { rawPath: "sources/a.md" });
    expect(first.ingested).toBe(true);

    await fs.writeFile(path.join(dir, "sources", "a.md"), "# A\n\n第二版，内容变了。\n", "utf8");
    const second = await ingestRawDocument(dir, { rawPath: "sources/a.md" });
    expect(second.ingested).toBe(true);
    expect(second.summaryPage).toBe("wiki/summaries/A-2.md");
    expect(await exists(path.join(dir, "wiki", "summaries", "A.md"))).toBe(true);
  });
});

describe("11.15 矛盾标记：两处论断都保留", () => {
  test("新资料与旧论断冲突 → 标记且不覆盖", async () => {
    const dir = await freshDir("contradiction");
    await ensureWikiSkeleton(dir);
    await fs.writeFile(path.join(dir, "sources", "v1.md"), "# 复杂度\n\n注意力复杂度 O(n^2)。\n", "utf8");
    await ingestRawDocument(dir, {
      rawPath: "sources/v1.md",
      entities: [
        { type: "concept", title: "注意力复杂度", claims: [{ topic: "复杂度", statement: "注意力机制复杂度是 O(n^2)" }] },
      ],
    });
    await fs.writeFile(path.join(dir, "sources", "v2.md"), "# 复杂度修正\n\n实测复杂度 O(n)。\n", "utf8");
    const second = await ingestRawDocument(dir, {
      rawPath: "sources/v2.md",
      entities: [
        { type: "concept", title: "注意力复杂度", claims: [{ topic: "复杂度", statement: "注意力机制复杂度是 O(n)" }] },
      ],
    });
    expect(second.warnings.join("\n")).toContain("论断冲突");

    const page = await fs.readFile(path.join(dir, "wiki", "entities", "concept", "注意力复杂度.md"), "utf8");
    expect(page).toContain("O(n^2)"); // 旧论断保留
    expect(page).toContain("O(n)"); // 新论断保留
    expect(page).toContain("[!CONTRADICTION]");
  });
});

describe("11.16 答案回填成新页并更新 index", () => {
  test("归档一次分析 → 新页 + index + log；冲突时另起页不覆盖", async () => {
    const dir = await freshDir("archive");
    await ensureWikiSkeleton(dir);
    const first = await archiveAnswer(dir, {
      title: "注意力机制对比",
      content: "# 对比\n\n方案 A 更快。",
      kind: "analysis",
      sources: ["sources/a.md"],
    });
    expect(first.archived).toBe(true);
    expect(first.path).toBe("wiki/summaries/注意力机制对比.md");
    expect(await exists(path.join(dir, first.path))).toBe(true);
    const index = (await readWikiIndex(dir)) ?? "";
    expect(index).toContain("(summaries/注意力机制对比.md)");
    expect((await readWikiLog(dir)) ?? "").toContain("] archive | 注意力机制对比");

    // 同主题不同正文 → 新建可区分页面，原页不动
    const second = await archiveAnswer(dir, {
      title: "注意力机制对比",
      content: "# 对比\n\n方案 B 更省显存。",
      kind: "analysis",
    });
    expect(second.path).toBe("wiki/summaries/注意力机制对比-2.md");
    expect(await fs.readFile(path.join(dir, first.path), "utf8")).toContain("方案 A 更快");
    expect(await fs.readFile(path.join(dir, second.path), "utf8")).toContain("方案 B 更省显存");

    // 完全相同 → 不动
    const third = await archiveAnswer(dir, {
      title: "注意力机制对比",
      content: "# 对比\n\n方案 B 更省显存。",
      kind: "analysis",
    });
    expect(third.archived).toBe(false);
    expect(third.reason).toBe("unchanged");
  });
});

describe("11.17 体检：报告具体可执行且不改内容", () => {
  test("孤儿页 + 缺页被具体报告，且 wiki 内容一个字节未变", async () => {
    const dir = await freshDir("lint");
    await ensureWikiSkeleton(dir);
    await fs.writeFile(path.join(dir, "sources", "src.md"), "# 源\n\n提到 [[不存在的概念]]。\n", "utf8");
    await ingestRawDocument(dir, { rawPath: "sources/src.md" });

    // 手工造一个孤儿页（没入链、不在 index）
    await fs.mkdir(path.join(dir, "wiki", "entities", "concept"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "wiki", "entities", "concept", "孤儿页.md"),
      "---\ntype: concept\ntitle: 孤儿页\ndate: 2026-01-01\n---\n\n# 孤儿页\n\n没人引用我。\n",
      "utf8",
    );

    const before = await snapshotTree(dir);
    const report = await lintWiki(dir);
    const after = await snapshotTree(dir);

    expect(report.wikiExists).toBe(true);
    expect(report.orphans.map((o) => o.path)).toContain("wiki/entities/concept/孤儿页.md");
    expect(report.missingPages.map((m) => m.name)).toContain("不存在的概念");
    const actions = report.actions.join("\n");
    expect(actions).toContain("wiki/entities/concept/孤儿页.md");
    expect(actions).toContain("不存在的概念");
    expect(actions).toContain("待补页面");
    // 体检不改动任何 wiki 内容
    expect(after).toEqual(before);
  });

  test("wiki 不存在 → 视为空，不报错", async () => {
    const dir = await freshDir("lint-empty");
    const report = await lintWiki(dir);
    expect(report.wikiExists).toBe(false);
    expect(report.actions.length).toBeGreaterThan(0);
    expect(report.pages).toBe(0);
  });

  test("矛盾与陈旧论断进入报告", async () => {
    const dir = await freshDir("lint-contradiction");
    await ensureWikiSkeleton(dir);
    await fs.writeFile(path.join(dir, "sources", "c1.md"), "# C\n\nO(n^2)。\n", "utf8");
    await ingestRawDocument(dir, {
      rawPath: "sources/c1.md",
      entities: [{ type: "concept", title: "C", claims: [{ topic: "复杂度", statement: "O(n^2)" }] }],
    });
    await fs.writeFile(path.join(dir, "sources", "c2.md"), "# C\n\nO(n)。\n", "utf8");
    await ingestRawDocument(dir, {
      rawPath: "sources/c2.md",
      entities: [{ type: "concept", title: "C", claims: [{ topic: "复杂度", statement: "O(n)" }] }],
    });
    const report = await lintWiki(dir);
    expect(report.contradictions.length).toBeGreaterThan(0);
    expect(report.contradictions[0]?.topic).toContain("复杂度");
    expect(report.actions.join("\n")).toContain("待确认矛盾");
  });
});

describe("路径工具", () => {
  test("toWorkspaceRel 归一绝对与虚拟路径", () => {
    const ws = path.resolve("C:/tmp/ws");
    expect(toWorkspaceRel(ws, path.join(ws, "sources", "a.md"))).toBe("sources/a.md");
    expect(toWorkspaceRel(ws, "/sources/a.md")).toBe("sources/a.md");
  });
});