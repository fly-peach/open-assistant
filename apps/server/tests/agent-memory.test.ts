/**
 * agent 长期记忆分层测试（tasks 11.1–11.6，design D12）。
 *
 * 覆盖四件最容易做错的事：
 * - **迁移不丢数据**：旧单文件 `memory.md` → `MEMORY.md`，原文件改名保留
 * - **注入有上限**：超长核心记忆被截断并留标记
 * - **主题笔记幂等**：同日同话题重复归纳是覆盖而非追加
 * - **日记兼索引**：只替换索引块，保留 agent 自己写的当日正文
 *
 * ⚠️ 大小写不敏感平台（Windows / macOS）上 `memory.md` 与 `MEMORY.md` 是同一个文件 ——
 * 迁移逻辑必须识别这点，否则会把刚建好的 `MEMORY.md` 改名掉。这条有专门用例。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  CORE_MEMORY_MAX_BYTES,
  TOPIC_INDEX_END,
  TOPIC_INDEX_START,
  appendCoreMemory,
  dailyNotePath,
  ensureMemoryLayout,
  listDailyTopics,
  listMemoryTree,
  localDate,
  migrateLegacyMemoryFile,
  readCoreMemory,
  readDailyNote,
  readMemoryFile,
  readMemoryForPrompt,
  refreshDailyIndex,
  searchMemory,
  slugTopic,
  topicNotePath,
  upsertTopicNote,
  writeCoreMemory,
} from "../src/agents/memory.js";

let root = "";
let counter = 0;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oa-mem-"));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function freshAgent(name: string): Promise<string> {
  counter += 1;
  const dir = path.join(root, `${name}-${counter}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("11.1 分层骨架与迁移", () => {
  test("骨架齐全：MEMORY.md + memory/ + digest/ + memory/imports/", async () => {
    const dir = await freshAgent("layout");
    const res = await ensureMemoryLayout(dir);
    expect(res.created).toContain("MEMORY.md");
    expect(await fs.stat(path.join(dir, "memory")).then((s) => s.isDirectory())).toBe(true);
    expect(await fs.stat(path.join(dir, "digest")).then((s) => s.isDirectory())).toBe(true);
    expect(await fs.stat(path.join(dir, "memory", "imports")).then((s) => s.isDirectory())).toBe(true);
    // ⚠️ 大小写不敏感平台上 MEMORY.md 与 memory.md 是同一个文件：
    // 迁移绝不能把刚建好的它改名掉
    expect(await fs.readdir(dir).then((e) => e.filter((n) => n.includes("migrated")))).toEqual([]);
  });

  test("幂等：再跑一次不覆盖已有内容", async () => {
    const dir = await freshAgent("idempotent");
    await ensureMemoryLayout(dir);
    await writeCoreMemory(dir, "# 我写的东西\n");
    await ensureMemoryLayout(dir);
    expect(await readCoreMemory(dir)).toBe("# 我写的东西\n");
  });

  test("迁移旧单文件：内容并入 MEMORY.md，原文件改名保留（用不同名模拟旧文件）", async () => {
    const dir = await freshAgent("legacy");
    // 直接测迁移函数本体：造一个"旧文件"（不是 MEMORY.md 本身）
    const legacyName = path.join(dir, "memory.md");
    await fs.writeFile(legacyName, "# 旧记忆\n\n用户叫阿明。\n", "utf8");
    const core = path.join(dir, "MEMORY.md");

    // 大小写敏感平台上这是两个文件；不敏感平台上它们是同一个 —— 两种都要么迁移、要么原样保留，
    // 关键是**不丢内容**且**不改名成 migrated 之外的意外状态**
    const migrated = await migrateLegacyMemoryFile(dir);
    const coreContent = await readCoreMemory(dir);
    if (migrated) {
      expect(coreContent).toContain("用户叫阿明");
      expect(await fs.readdir(dir)).toContain("memory.md.migrated");
    } else {
      // 同一个文件：内容仍在 MEMORY.md（即原文件）里
      expect(coreContent).toContain("用户叫阿明");
      expect(await fs.stat(core)).toBeTruthy();
    }
  });
});

describe("11.2 核心记忆读写：人与 agent 改动互不覆盖", () => {
  test("agent 追加不抹掉人写的内容，人覆盖也不影响既有格式", async () => {
    const dir = await freshAgent("core-rw");
    await ensureMemoryLayout(dir);
    await writeCoreMemory(dir, "# 人的笔记\n\n- 我不喜欢啰嗦\n");
    await appendCoreMemory(dir, "- 记住用中文\n");
    const afterAppend = await readCoreMemory(dir);
    expect(afterAppend).toContain("我不喜欢啰嗦");
    expect(afterAppend).toContain("记住用中文");

    // 人重新整体覆盖
    await writeCoreMemory(dir, "# 人的笔记\n\n- 只留这一条\n");
    expect(await readCoreMemory(dir)).toBe("# 人的笔记\n\n- 只留这一条\n");
  });

  test("文件不存在 → 空记忆，不报错", async () => {
    const dir = await freshAgent("core-missing");
    expect(await readCoreMemory(dir)).toBe("");
  });
});

describe("11.3 注入上限", () => {
  test("超长核心记忆被截断并带明确标记", async () => {
    const dir = await freshAgent("cap");
    await ensureMemoryLayout(dir);
    const long = `# 大记忆\n\n${"这是一条很长的记忆。".repeat(6000)}\n`;
    expect(Buffer.byteLength(long, "utf8")).toBeGreaterThan(CORE_MEMORY_MAX_BYTES);
    await writeCoreMemory(dir, long);

    const prompt = await readMemoryForPrompt(dir);
    expect(prompt.truncated).toBe(true);
    expect(prompt.bytes).toBeGreaterThan(CORE_MEMORY_MAX_BYTES);
    expect(prompt.content).toContain("已截断");
    expect(Buffer.byteLength(prompt.content, "utf8")).toBeLessThan(CORE_MEMORY_MAX_BYTES + 512);
  });

  test("空记忆不注入（返回空串）", async () => {
    const dir = await freshAgent("cap-empty");
    await ensureMemoryLayout(dir);
    const prompt = await readMemoryForPrompt(dir);
    expect(prompt.content).toBe("");
    expect(prompt.truncated).toBe(false);
  });

  test("未超限时不截断、不加标记", async () => {
    const dir = await freshAgent("cap-small");
    await ensureMemoryLayout(dir);
    await writeCoreMemory(dir, "# 小记忆\n\n- 一条\n");
    const prompt = await readMemoryForPrompt(dir);
    expect(prompt.truncated).toBe(false);
    expect(prompt.content).toBe("# 小记忆\n\n- 一条\n");
  });
});

describe("11.5 主题笔记幂等", () => {
  test("同日同话题重复写 → 覆盖而非追加（长度不线性增长）", async () => {
    const dir = await freshAgent("topic-idempotent");
    await ensureMemoryLayout(dir);
    const date = "2026-10-01";

    await upsertTopicNote(dir, date, "注意力机制", "第一版：按相关性加权求和。");
    const first = await fs.readFile(topicNotePath(dir, date, "注意力机制"), "utf8");
    for (let i = 0; i < 5; i++) {
      await upsertTopicNote(dir, date, "注意力机制", "第一版：按相关性加权求和。");
    }
    const after = await fs.readFile(topicNotePath(dir, date, "注意力机制"), "utf8");
    expect(after).toBe(first);
    expect(after.length).toBeLessThan(first.length * 2);
  });

  test("不同话题各自成文件，不堆进一个大文件", async () => {
    const dir = await freshAgent("topic-split");
    await ensureMemoryLayout(dir);
    const date = "2026-10-01";
    await upsertTopicNote(dir, date, "注意力", "甲");
    await upsertTopicNote(dir, date, "卷积", "乙");
    const topics = await listDailyTopics(dir, date);
    expect(topics.map((t) => t.topic).sort()).toEqual(["卷积", "注意力"].sort());
  });

  test("话题名被清洗成安全文件名", async () => {
    expect(slugTopic("a/b:c*d?e")).toBe("a-b-c-d-e");
    expect(slugTopic("  多 个   空格 ")).toBe("多-个-空格");
    expect(slugTopic("")).toBe("untitled");
  });

  test("非法日期被拒", async () => {
    const dir = await freshAgent("topic-bad-date");
    await expect(upsertTopicNote(dir, "2026/10/01", "x", "y")).rejects.toThrow();
  });
});

describe("11.6 日记兼索引", () => {
  test("索引随主题笔记更新，且保留 agent 自己写的当日正文", async () => {
    const dir = await freshAgent("daily-index");
    await ensureMemoryLayout(dir);
    const date = "2026-10-01";

    await fs.mkdir(path.dirname(dailyNotePath(dir, date)), { recursive: true });
    await fs.writeFile(dailyNotePath(dir, date), `# ${date}\n\n今天聊了注意力机制。\n`, "utf8");

    await upsertTopicNote(dir, date, "注意力机制", "要点若干。");
    const daily = (await readDailyNote(dir, date)) ?? "";
    expect(daily).toContain("今天聊了注意力机制。"); // 正文保留
    expect(daily).toContain(TOPIC_INDEX_START);
    expect(daily).toContain(TOPIC_INDEX_END);
    expect(daily).toContain("[注意力机制](2026-10-01/注意力机制.md)");

    // 再加一个话题 → 索引块整体重写，不重复堆叠
    await upsertTopicNote(dir, date, "卷积", "要点若干。");
    const daily2 = (await readDailyNote(dir, date)) ?? "";
    expect(daily2.match(new RegExp(TOPIC_INDEX_START, "g"))!.length).toBe(1);
    expect(daily2).toContain("[卷积](2026-10-01/卷积.md)");
    expect(daily2).toContain("[注意力机制](2026-10-01/注意力机制.md)");
  });

  test("没有主题笔记时索引显示空占位而不是报错", async () => {
    const dir = await freshAgent("daily-empty");
    await ensureMemoryLayout(dir);
    const daily = await refreshDailyIndex(dir, "2026-10-02");
    expect(daily).toContain("还没有主题笔记");
  });
});

describe("11.4 检索：先片段 + 路径", () => {
  test("多词 AND 命中，返回路径与片段", async () => {
    const dir = await freshAgent("search");
    await ensureMemoryLayout(dir);
    await writeCoreMemory(dir, "# 长期记忆\n\n用户叫阿明，喜欢简洁的回答。\n");
    await upsertTopicNote(dir, "2026-10-01", "部署", "项目部署在 E 盘，用 bun 管依赖。");

    const hits = await searchMemory(dir, "阿明 简洁");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.rel).toBe("MEMORY.md");
    expect(hits[0]!.snippet).toContain("阿明");

    const deploy = await searchMemory(dir, "bun");
    expect(deploy[0]!.rel).toContain("2026-10-01");
  });

  test("查不到 → 空数组；空查询 → 空数组", async () => {
    const dir = await freshAgent("search-miss");
    await ensureMemoryLayout(dir);
    await writeCoreMemory(dir, "# 只有这个\n");
    expect(await searchMemory(dir, "完全不存在的词")).toEqual([]);
    expect(await searchMemory(dir, "   ")).toEqual([]);
  });
});

describe("树与按路径读取（前端 / 工具共用）", () => {
  test("树含核心文件与 memory/digest 下的条目", async () => {
    const dir = await freshAgent("tree");
    await ensureMemoryLayout(dir);
    await writeCoreMemory(dir, "# x\n");
    await upsertTopicNote(dir, "2026-10-01", "话题", "内容");
    const tree = await listMemoryTree(dir);
    const rels = tree.map((e) => e.rel);
    expect(rels).toContain("MEMORY.md");
    expect(rels).toContain("memory");
    expect(rels).toContain("digest");
    expect(rels.some((r) => r.startsWith("memory/2026-10-01/"))).toBe(true);
  });

  test("按路径读取；越界与逃逸被拒", async () => {
    const dir = await freshAgent("read-file");
    await ensureMemoryLayout(dir);
    await writeCoreMemory(dir, "# 核心\n");
    expect((await readMemoryFile(dir, "MEMORY.md"))?.content).toBe("# 核心\n");

    await upsertTopicNote(dir, "2026-10-01", "话题", "内容");
    const rel = "memory/2026-10-01/话题.md";
    expect((await readMemoryFile(dir, rel))?.content).toContain("内容");

    expect(await readMemoryFile(dir, "../agents/secret.md")).toBeNull();
    expect(await readMemoryFile(dir, "config.json")).toBeNull();
    expect(await readMemoryFile(dir, "skills/x/SKILL.md")).toBeNull();
    expect(await readMemoryFile(dir, "")).toBeNull();
  });
});

describe("日期工具", () => {
  test("localDate 用本地日历（避免跨零点错位）", () => {
    expect(localDate(new Date(2026, 9, 1, 0, 30))).toBe("2026-10-01");
    expect(localDate(new Date(2026, 9, 1, 23, 30))).toBe("2026-10-01");
  });
});