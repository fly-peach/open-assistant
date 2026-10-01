/**
 * 工作区 ↔ agent 的 N:1 模型（2026-10-01 从 1:1 放宽）。
 *
 * 锁住两条不变式（见 src/binding.ts 头部）：
 * 1. 默认 agent 永远是成员且永远启用（它是兜底，不能被停用/移除）
 * 2. 停用或移除激活位 → 激活位自动回落默认 agent（不留悬空激活位）
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  addWorkspaceAgent,
  readBinding,
  readWorkspaceAgentsView,
  removeWorkspaceAgent,
  setActiveAgent,
  setWorkspaceAgentEnabled,
  workspaceProjectPath,
  writeBinding,
} from "../src/binding.js";
import { createAgent, readAgentConfig, setAgentPinned } from "../src/agents/registry.js";
import { DEFAULT_AGENT_ID } from "../src/agents/root.js";

let root = "";
let agentsRoot = "";
const originalAgentsRoot = process.env["AGENTS_ROOT"];

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-wsagents-")));
  agentsRoot = path.join(root, "agents");
  process.env["AGENTS_ROOT"] = agentsRoot;
  await fs.mkdir(agentsRoot, { recursive: true });
  await createAgent({ id: DEFAULT_AGENT_ID, name: "小助" });
  await createAgent({ id: "writer", name: "写手", description: "写作助手" });
  await createAgent({ id: "memo", name: "备忘" });
});
afterAll(async () => {
  if (originalAgentsRoot === undefined) delete process.env["AGENTS_ROOT"];
  else process.env["AGENTS_ROOT"] = originalAgentsRoot;
  await fs.rm(root, { recursive: true, force: true });
});

let counter = 0;
async function freshWs(): Promise<string> {
  counter += 1;
  const dir = path.join(root, `ws-${counter}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("成员表与激活位", () => {
  test("首次写入：默认 agent 也在成员表里，且是激活位", async () => {
    const ws = await freshWs();
    const { binding } = await writeBinding(ws, "writer");
    expect(binding.activeAgentId).toBe("writer");
    expect(binding.agents.map((r) => r.agentId).sort()).toEqual([DEFAULT_AGENT_ID, "writer"].sort());
    expect(binding.agents.every((r) => r.enabled)).toBe(true);
  });

  test("加第二个 agent 不会抢走激活位", async () => {
    const ws = await freshWs();
    await writeBinding(ws, DEFAULT_AGENT_ID);
    const after = await addWorkspaceAgent(ws, "memo");
    expect(after.activeAgentId).toBe(DEFAULT_AGENT_ID);
    expect(after.agents.map((r) => r.agentId)).toContain("memo");
  });

  test("加成员可以同时设为激活（makeActive）", async () => {
    const ws = await freshWs();
    await writeBinding(ws, DEFAULT_AGENT_ID);
    const after = await addWorkspaceAgent(ws, "memo", { makeActive: true });
    expect(after.activeAgentId).toBe("memo");
  });

  test("同一个 agent 可以在不同工作区有不同启用状态", async () => {
    const a = await freshWs();
    const b = await freshWs();
    await writeBinding(a, DEFAULT_AGENT_ID);
    await writeBinding(b, DEFAULT_AGENT_ID);
    await addWorkspaceAgent(a, "writer");
    await addWorkspaceAgent(b, "writer");
    await setWorkspaceAgentEnabled(a, "writer", false);
    const [ba, bb] = [await readBinding(a), await readBinding(b)];
    expect(ba?.agents.find((r) => r.agentId === "writer")?.enabled).toBe(false);
    expect(bb?.agents.find((r) => r.agentId === "writer")?.enabled).toBe(true);
  });
});

describe("不变式 1：默认 agent 是兜底", () => {
  test("不能停用默认 agent", async () => {
    const ws = await freshWs();
    await writeBinding(ws, DEFAULT_AGENT_ID);
    await expect(setWorkspaceAgentEnabled(ws, DEFAULT_AGENT_ID, false)).rejects.toThrow();
    expect((await readBinding(ws))?.agents.find((r) => r.agentId === DEFAULT_AGENT_ID)?.enabled).toBe(true);
  });

  test("不能从工作区移除默认 agent", async () => {
    const ws = await freshWs();
    await writeBinding(ws, DEFAULT_AGENT_ID);
    await expect(removeWorkspaceAgent(ws, DEFAULT_AGENT_ID)).rejects.toThrow();
  });

  test("文件里被手工改坏的绑定也会被纠正（默认 agent 强制启用 + 进成员表）", async () => {
    const ws = await freshWs();
    await fs.mkdir(path.dirname(workspaceProjectPath(ws)), { recursive: true });
    await fs.writeFile(
      workspaceProjectPath(ws),
      JSON.stringify({
        version: 2,
        agents: [{ agentId: "writer", enabled: true, addedAt: "x" }],
        activeAgentId: "writer",
        createdAt: "x",
      }),
      "utf8",
    );
    const binding = await readBinding(ws);
    expect(binding?.agents.map((r) => r.agentId)).toContain(DEFAULT_AGENT_ID);
    expect(binding?.agents.find((r) => r.agentId === DEFAULT_AGENT_ID)?.enabled).toBe(true);
  });
});

describe("不变式 2：激活位不留悬空", () => {
  test("停用当前激活的 agent → 激活位回落默认 agent", async () => {
    const ws = await freshWs();
    await writeBinding(ws, DEFAULT_AGENT_ID);
    await addWorkspaceAgent(ws, "writer", { makeActive: true });
    const after = await setWorkspaceAgentEnabled(ws, "writer", false);
    expect(after.activeAgentId).toBe(DEFAULT_AGENT_ID);
    expect(after.agents.find((r) => r.agentId === "writer")?.enabled).toBe(false);
  });

  test("移除当前激活的 agent → 激活位回落默认 agent", async () => {
    const ws = await freshWs();
    await writeBinding(ws, DEFAULT_AGENT_ID);
    await addWorkspaceAgent(ws, "memo", { makeActive: true });
    const after = await removeWorkspaceAgent(ws, "memo");
    expect(after.activeAgentId).toBe(DEFAULT_AGENT_ID);
    expect(after.agents.map((r) => r.agentId)).not.toContain("memo");
  });

  test("激活位指向一个已停用的 agent 时（文件被改坏）读回即纠正", async () => {
    const ws = await freshWs();
    await fs.mkdir(path.dirname(workspaceProjectPath(ws)), { recursive: true });
    await fs.writeFile(
      workspaceProjectPath(ws),
      JSON.stringify({
        version: 2,
        agents: [
          { agentId: DEFAULT_AGENT_ID, enabled: true, addedAt: "x" },
          { agentId: "writer", enabled: false, addedAt: "x" },
        ],
        activeAgentId: "writer",
        createdAt: "x",
      }),
      "utf8",
    );
    expect((await readBinding(ws))?.activeAgentId).toBe(DEFAULT_AGENT_ID);
  });

  test("不能切到一个停用的成员", async () => {
    const ws = await freshWs();
    await writeBinding(ws, DEFAULT_AGENT_ID);
    await addWorkspaceAgent(ws, "writer", { enabled: false });
    await expect(setActiveAgent(ws, "writer")).rejects.toThrow();
  });

  test("切到不存在的成员 → 明确报错（不是静默什么都不做）", async () => {
    const ws = await freshWs();
    await writeBinding(ws, DEFAULT_AGENT_ID);
    await expect(setActiveAgent(ws, "memo")).rejects.toThrow();
  });
});

describe("v1 记录迁移", () => {
  test("老的 { agentId } 记录读成 v2（默认 agent 补进成员表）", async () => {
    const ws = await freshWs();
    await fs.mkdir(path.dirname(workspaceProjectPath(ws)), { recursive: true });
    await fs.writeFile(
      workspaceProjectPath(ws),
      JSON.stringify({ version: 1, agentId: "writer", createdAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    );
    const binding = await readBinding(ws);
    expect(binding?.version).toBe(2);
    expect(binding?.activeAgentId).toBe("writer");
    expect(binding?.agents.find((r) => r.agentId === "writer")?.enabled).toBe(true);
    expect(binding?.agents.map((r) => r.agentId)).toContain(DEFAULT_AGENT_ID);
    // 真正的激活位没变 → 不该被当成一次换绑
    expect(binding?.lastAgentSwitch).toBeUndefined();
  });
});

describe("置顶是 agent 自己的偏好", () => {
  test("置顶写在 agent 的 config.json 里，不属于工作区", async () => {
    const ws = await freshWs();
    await writeBinding(ws, DEFAULT_AGENT_ID);
    await setAgentPinned("memo", true);
    expect((await readAgentConfig("memo", path.join(agentsRoot, "memo"))).pinned).toBe(true);
    // 绑定文件里不该出现 pinned
    const raw = await fs.readFile(workspaceProjectPath(ws), "utf8");
    expect(raw).not.toContain("pinned");
  });
});

describe("选择器视图", () => {
  test("成员与候选分开，且带上 agent 自己的字段", async () => {
    const ws = await freshWs();
    await writeBinding(ws, DEFAULT_AGENT_ID);
    await addWorkspaceAgent(ws, "writer");
    const view = await readWorkspaceAgentsView(ws);
    expect(view.activeAgentId).toBe(DEFAULT_AGENT_ID);
    expect(view.members.map((m) => m.id).sort()).toEqual([DEFAULT_AGENT_ID, "writer"].sort());
    expect(view.candidates.map((c) => c.id)).toEqual(["memo"]);
    const writer = view.members.find((m) => m.id === "writer")!;
    expect(writer.name).toBe("写手");
    expect(writer.description).toBe("写作助手");
    expect(writer.startupStatus).toBe("running");
    expect(writer.active).toBe(false);
    // 候选还没挂上 → enabled 一律 false
    expect(view.candidates.every((c) => c.enabled === false)).toBe(true);
  });

  test("未绑定的工作区：视图也能出（默认 agent 当激活位）", async () => {
    const ws = await freshWs();
    const view = await readWorkspaceAgentsView(ws);
    expect(view.activeAgentId).toBe(DEFAULT_AGENT_ID);
    expect(view.members).toEqual([]);
  });

  test("定义被删了的成员如实标成不可用，不假装它没问题", async () => {
    const ws = await freshWs();
    await writeBinding(ws, DEFAULT_AGENT_ID);
    await addWorkspaceAgent(ws, "writer");
    await fs.rm(path.join(agentsRoot, "writer"), { recursive: true, force: true });
    const view = await readWorkspaceAgentsView(ws);
    const ghost = view.members.find((m) => m.id === "writer")!;
    expect(ghost.valid).toBe(false);
    expect(ghost.startupStatus).toBe("failed");
    expect(ghost.issues?.length).toBeGreaterThan(0);
  });

  test("配置非法的 agent → startupStatus=failed（不编造 pending/starting）", async () => {
    const ws = await freshWs();
    await fs.mkdir(path.join(agentsRoot, "broken"), { recursive: true });
    await fs.writeFile(
      path.join(agentsRoot, "broken", "config.json"),
      JSON.stringify({ version: 1, approval: "不存在的级别" }),
      "utf8",
    );
    await writeBinding(ws, DEFAULT_AGENT_ID);
    const view = await readWorkspaceAgentsView(ws);
    const broken = view.candidates.find((c) => c.id === "broken")!;
    expect(broken.valid).toBe(false);
    expect(broken.startupStatus).toBe("failed");
    expect(["disabled", "failed", "running"]).toContain(broken.startupStatus);
  });
});