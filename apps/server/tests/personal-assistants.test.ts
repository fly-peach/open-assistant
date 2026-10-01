/**
 * 个人助理「出厂配置」：幂等播种 4 位（预加载人设 / 工具 / 私有技能），已存在的不覆盖。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { AGENTS_ROOT_ENV } from "../src/agents/root.js";
import { clearAgentRuntimeCache, readAgent } from "../src/agents/registry.js";
import {
  PERSONAL_ASSISTANTS,
  ensurePersonalAssistants,
} from "../src/agents/personal-assistants.js";

let root: string;
const originalRoot = process.env[AGENTS_ROOT_ENV];

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-assist-")));
  process.env[AGENTS_ROOT_ENV] = root;
});

afterAll(async () => {
  if (originalRoot === undefined) delete process.env[AGENTS_ROOT_ENV];
  else process.env[AGENTS_ROOT_ENV] = originalRoot;
  clearAgentRuntimeCache();
  await fs.rm(root, { recursive: true, force: true });
});

describe("个人助理出厂配置", () => {
  test("幂等创建 4 位，各自带预加载人设 / 工具 / 私有技能", async () => {
    const first = await ensurePersonalAssistants();
    expect(first.created.sort()).toEqual(["life", "nutritionist", "programmer", "trainer"]);
    expect(first.skipped).toEqual([]);

    for (const seed of PERSONAL_ASSISTANTS) {
      const def = await readAgent(seed.id);
      expect(def.name).toBe(seed.name);
      expect(def.persona.trim().length).toBeGreaterThan(20);
      // 预加载工具：skills 组默认开
      expect(def.config.tools.skills).toBe(true);
      // 预加载私有技能
      for (const skill of seed.skills) {
        const hit = def.skills.find((s) => s.name === skill.name);
        expect(hit?.source).toBe("agent");
      }
    }

    // 人设确实落进 AGENTS.md（不是只有内存）
    expect(await fs.readFile(path.join(root, "trainer", "AGENTS.md"), "utf8")).toContain("健身教练");

    // 幂等：再次调用不新建
    const second = await ensurePersonalAssistants();
    expect(second.created).toEqual([]);
    expect(second.skipped.sort()).toEqual(["life", "nutritionist", "programmer", "trainer"]);
  });

  test("已存在的 agent 不被覆盖（用户改过的人设保留）", async () => {
    const file = path.join(root, "life", "AGENTS.md");
    await fs.writeFile(file, "用户自定义人设", "utf8");
    await ensurePersonalAssistants();
    expect(await fs.readFile(file, "utf8")).toBe("用户自定义人设");
  });
});