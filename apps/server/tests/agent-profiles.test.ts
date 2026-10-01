/**
 * 智能体档案与工作区归属（**1:1**，照 QwenPaw 的 `AgentProfileRef { id, workspace_dir, enabled, pinned }`）。
 *
 * 锁住这条不变式：**一个工作区目录只能由一位 agent 维护** ——
 * 两个助手同时改一份文件是绝对要拦下来的（写入侧拦，且报可读原因）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { readAgentProfilesView, switchBlockReason } from "../src/agent-profiles.js";
import { readBinding, writeBinding } from "../src/binding.js";
import {
  createAgent,
  findAgentByWorkspaceDir,
  readAgentConfig,
  setAgentEnabled,
  setAgentPinned,
  setAgentWorkspaceDir,
} from "../src/agents/registry.js";
import { DEFAULT_AGENT_ID } from "../src/agents/root.js";

let root = "";
let agentsRoot = "";
const originalAgentsRoot = process.env["AGENTS_ROOT"];

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-profiles-")));
  agentsRoot = path.join(root, "agents");
  process.env["AGENTS_ROOT"] = agentsRoot;
  await fs.mkdir(agentsRoot, { recursive: true });
  await createAgent({ id: DEFAULT_AGENT_ID, name: "生活管家" });
  await createAgent({ id: "writer", name: "写手", description: "写作助手" });
  await createAgent({ id: "memo", name: "备忘" });
});
afterAll(async () => {
  if (originalAgentsRoot === undefined) delete process.env["AGENTS_ROOT"];
  else process.env["AGENTS_ROOT"] = originalAgentsRoot;
  await fs.rm(root, { recursive: true, force: true });
});

let counter = 0;
async function freshDir(tag = "ws"): Promise<string> {
  counter += 1;
  const dir = path.join(root, `${tag}-${counter}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("agent → 工作区目录（1:1）", () => {
  test("新建 agent 默认没有工作区（workspaceDir = null）", async () => {
    expect((await readAgentConfig("memo", path.join(agentsRoot, "memo"))).workspaceDir).toBe(null);
  });

  test("指定一个已存在的目录后能读回", async () => {
    const dir = await freshDir();
    const config = await setAgentWorkspaceDir("writer", dir);
    expect(config.workspaceDir).toBe(dir);
    expect((await readAgentConfig("writer", path.join(agentsRoot, "writer"))).workspaceDir).toBe(dir);
    await setAgentWorkspaceDir("writer", null);
  });

  test("目录不存在 → 拒绝（不静默接受一个指向虚空的工作区）", async () => {
    await expect(setAgentWorkspaceDir("memo", path.join(root, "does-not-exist"))).rejects.toThrow();
  });

  test("null 表示解除指定", async () => {
    const dir = await freshDir();
    await setAgentWorkspaceDir("memo", dir);
    await setAgentWorkspaceDir("memo", null);
    expect((await readAgentConfig("memo", path.join(agentsRoot, "memo"))).workspaceDir).toBe(null);
  });
});

describe("不变式：一个目录只能由一位 agent 维护", () => {
  test("第二个 agent 想认领同一个目录 → 409，且指明是谁占着", async () => {
    const dir = await freshDir();
    await setAgentWorkspaceDir("writer", dir);
    let message = "";
    try {
      await setAgentWorkspaceDir("memo", dir);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("writer");
    expect(message).toContain("一个工作区只能绑一位");
    // 被拒之后不能留下半截状态
    expect((await readAgentConfig("memo", path.join(agentsRoot, "memo"))).workspaceDir).toBe(null);
    await setAgentWorkspaceDir("writer", null);
  });

  test("同一个 agent 重新认领自己的目录不算冲突（幂等）", async () => {
    const dir = await freshDir();
    await setAgentWorkspaceDir("writer", dir);
    await setAgentWorkspaceDir("writer", dir);
    expect(await findAgentByWorkspaceDir(dir)).toBe("writer");
    await setAgentWorkspaceDir("writer", null);
  });

  test("路径比较做归一化（大小写 / 反斜杠 / 结尾分隔符都算同一个）", async () => {
    const dir = await freshDir();
    await setAgentWorkspaceDir("writer", dir);
    const variant = dir.toUpperCase() + path.sep;
    expect(await findAgentByWorkspaceDir(variant)).toBe("writer");
    await setAgentWorkspaceDir("writer", null);
  });

  test("没人认领的目录 → null", async () => {
    expect(await findAgentByWorkspaceDir(await freshDir())).toBe(null);
  });
});

describe("启用 / 停用", () => {
  test("默认 agent 不能停用（它保证任何时候都有能用的助手）", async () => {
    await expect(setAgentEnabled(DEFAULT_AGENT_ID, false)).rejects.toThrow();
    expect((await readAgentConfig(DEFAULT_AGENT_ID, path.join(agentsRoot, DEFAULT_AGENT_ID))).enabled).toBe(true);
  });

  test("普通 agent 可以停用再启用", async () => {
    await setAgentEnabled("memo", false);
    expect((await readAgentConfig("memo", path.join(agentsRoot, "memo"))).enabled).toBe(false);
    await setAgentEnabled("memo", true);
    expect((await readAgentConfig("memo", path.join(agentsRoot, "memo"))).enabled).toBe(true);
  });

  test("即使有人把默认 agent 的 enabled 手工改成 false，列表也兜住为 true", async () => {
    await fs.writeFile(
      path.join(agentsRoot, DEFAULT_AGENT_ID, "config.json"),
      JSON.stringify({ version: 1, name: "生活管家", enabled: false }),
      "utf8",
    );
    const view = await readAgentProfilesView("");
    expect(view.agents.find((a) => a.id === DEFAULT_AGENT_ID)?.enabled).toBe(true);
  });
});

describe("档案视图（选择器要的名单）", () => {
  test("列出全部 agent，带上各自的工作区目录；active 标出当前工作区用的是谁", async () => {
    const dir = await freshDir();
    await setAgentWorkspaceDir("writer", dir);
    await writeBinding(dir, "writer");

    const view = await readAgentProfilesView(dir);
    expect(view.activeAgentId).toBe("writer");
    const writer = view.agents.find((a) => a.id === "writer")!;
    expect(writer.active).toBe(true);
    expect(writer.workspaceDir).toBe(dir);
    expect(writer.name).toBe("写手");
    expect(writer.description).toBe("写作助手");
    expect(writer.startupStatus).toBe("running");
    // 别人不是 active，而且各自的目录互不相同（1:1）
    expect(view.agents.find((a) => a.id === "memo")?.active).toBe(false);
    const dirs = view.agents.map((a) => a.workspaceDir).filter((d): d is string => d !== null);
    expect(new Set(dirs).size).toBe(dirs.length);

    await setAgentWorkspaceDir("writer", null);
  });

  test("没有工作区时也能出名单（currentWorkspace 空串、没有 active）", async () => {
    const view = await readAgentProfilesView("");
    expect(view.currentWorkspace).toBe("");
    expect(view.activeAgentId).toBe(null);
    expect(view.agents.length).toBeGreaterThan(0);
    expect(view.agents.every((a) => !a.active)).toBe(true);
  });

  test("切不过去的两种原因能被一句话说清", async () => {
    const noWs: Parameters<typeof switchBlockReason>[0] = {
      id: "memo",
      name: "备忘",
      workspaceDir: null,
      enabled: true,
      pinned: false,
      availableInChat: true,
      startupStatus: "running",
      valid: true,
      active: false,
    };
    expect(switchBlockReason(noWs)).toBe("no-workspace");
    expect(switchBlockReason({ ...noWs, workspaceDir: "X", enabled: false })).toBe("disabled");
    expect(switchBlockReason({ ...noWs, workspaceDir: "X" })).toBe(null);
  });
});

describe("1:1 的两份镜像记录", () => {
  test("换绑后：目录归新 agent，且旧 agent 的 workspaceDir 必须被清掉", async () => {
    const dir = await freshDir();
    await setAgentWorkspaceDir("writer", dir);
    await writeBinding(dir, "writer");

    // 模拟「从配置页把目录改派给 memo」：先挪 workspaceDir，再改绑定
    await setAgentWorkspaceDir("writer", null);
    await setAgentWorkspaceDir("memo", dir);
    await writeBinding(dir, "memo");

    expect((await readBinding(dir))?.agentId).toBe("memo");
    expect((await readAgentConfig("writer", path.join(agentsRoot, "writer"))).workspaceDir).toBe(null);
    expect(await findAgentByWorkspaceDir(dir)).toBe("memo");
    await setAgentWorkspaceDir("memo", null);
  });

  test("置顶只影响档案字段，不影响归属", async () => {
    const dir = await freshDir();
    await setAgentPinned("memo", true);
    const view = await readAgentProfilesView(dir);
    expect(view.agents.find((a) => a.id === "memo")?.pinned).toBe(true);
    await setAgentPinned("memo", false);
  });
});