/**
 * 跨工作区 agent 通信：名单 / 前缀 / 深度 / 可联系对端解析。
 * （真正的「跑一轮」在 E2E 里验证，因为它要 langgraph 运行时。）
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { AGENTS_ROOT_ENV } from "../src/agents/root.js";
import { clearAgentRuntimeCache, createAgent, updateAgent } from "../src/agents/registry.js";
import { writeBinding } from "../src/binding.js";
import {
  canContact,
  currentCallDepth,
  identityPrefix,
  listContactableAgents,
} from "../src/agents/comms.js";
import type { AgentConfig } from "../src/agents/config.js";

let root: string;
let wsRoot: string;
const originalRoot = process.env[AGENTS_ROOT_ENV];

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-comms-")));
  wsRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-comms-ws-")));
  process.env[AGENTS_ROOT_ENV] = root;
});

afterAll(async () => {
  if (originalRoot === undefined) delete process.env[AGENTS_ROOT_ENV];
  else process.env[AGENTS_ROOT_ENV] = originalRoot;
  clearAgentRuntimeCache();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(wsRoot, { recursive: true, force: true });
});

describe("纯函数", () => {
  test("identityPrefix 标明来源", () => {
    expect(identityPrefix("life")).toContain("life");
  });

  test("canContact：空名单 = 谁都不能联系；命中才放行", () => {
    const config = { contactableAgents: ["trainer"] } as unknown as AgentConfig;
    expect(canContact(null, "trainer")).toBe(false);
    expect(canContact(config, "trainer")).toBe(true);
    expect(canContact(config, "nutritionist")).toBe(false);
    expect(canContact({ contactableAgents: [] } as unknown as AgentConfig, "trainer")).toBe(false);
  });

  test("currentCallDepth：从 configurable 取，缺省 0", () => {
    expect(currentCallDepth({ configurable: { agent_call_depth: 2 } })).toBe(2);
    expect(currentCallDepth({ configurable: {} })).toBe(0);
    expect(currentCallDepth({})).toBe(0);
  });
});

describe("listContactableAgents：按名单解析对端", () => {
  test("只列名单里的对端，并标注是否可用（有工作区且确实绑定它）", async () => {
    await createAgent({ id: "life", name: "生活管家" });
    await createAgent({ id: "trainer", name: "健身教练" });
    await createAgent({ id: "ghost", name: "没工作区的" });

    const wsLife = path.join(wsRoot, "life");
    const wsTrainer = path.join(wsRoot, "trainer");
    await fs.mkdir(wsLife, { recursive: true });
    await fs.mkdir(wsTrainer, { recursive: true });
    await writeBinding(wsLife, "life");
    await writeBinding(wsTrainer, "trainer");
    // life 可以联系 trainer（有工作区、可用）与 ghost（无工作区、不可用）
    await updateAgent("life", { config: { contactableAgents: ["trainer", "ghost"] } });

    const view = await listContactableAgents(wsLife);
    expect(view.callerAgentId).toBe("life");
    const byId = new Map(view.agents.map((a) => [a.id, a]));
    expect(byId.get("trainer")?.available).toBe(true);
    expect(byId.get("trainer")?.workspaceDir).toBe(wsTrainer);
    expect(byId.get("ghost")?.available).toBe(false);
    // 名单里没有的 agent 不出现
    expect(byId.has("nutritionist")).toBe(false);
  });

  test("未绑定的工作区 → callerAgentId 为 null、对端为空", async () => {
    const orphan = path.join(wsRoot, "orphan");
    await fs.mkdir(orphan, { recursive: true });
    const view = await listContactableAgents(orphan);
    expect(view.callerAgentId).toBeNull();
    expect(view.agents).toEqual([]);
  });
});