/**
 * tasks 1.x：声明式子 agent（团队）—— `apps/server/src/agents/team.ts` + 3 条 HTTP 路由。
 *
 * 分层（对齐 `tests/agents.test.ts` 与 findings §5.2）：
 * - 纯函数层：SPEC.md 解析 / 校验 / 工具白名单解析（不碰磁盘、不碰网络）
 * - 文件系统层：`listTeam` / `loadTeam`（单个声明非法不得拖垮整体加载）
 * - HTTP 层：`GET|POST|PUT /agents/:id/team*` 契约（与前端同一份出口）
 * - 图出口层：`src/agent.ts` 的图出口必须是**工厂函数**（对象导出会让团队声明改动不生效）
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { AGENTS_ROOT_ENV } from "../src/agents/root.js";
import { defaultAgentConfig } from "../src/agents/config.js";
import { clearAgentRuntimeCache, createAgent } from "../src/agents/registry.js";
import {
  AGENT_TEAM_DIR,
  AGENT_TEAM_SPEC_FILE,
  createSubAgent,
  listTeam,
  loadTeam,
  parseSubAgentSpec,
  resolveSubAgentToolNames,
  updateSubAgent,
} from "../src/agents/team.js";

process.env.OPEN_ASSISTANT_DISABLE_MIGRATION = "1";

let root: string;
let counter = 0;
const originalAgentsRoot = process.env[AGENTS_ROOT_ENV];

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-team-")));
  process.env[AGENTS_ROOT_ENV] = root;
});

afterAll(async () => {
  if (originalAgentsRoot === undefined) delete process.env[AGENTS_ROOT_ENV];
  else process.env[AGENTS_ROOT_ENV] = originalAgentsRoot;
  clearAgentRuntimeCache();
  await fs.rm(root, { recursive: true, force: true });
});

async function loadApp() {
  return (await import("../src/http.js")).app;
}

/** 造一个 agent 定义 + 一份 SPEC.md，返回 { agentId, specPath } */
async function makeAgentWithSpec(
  agentId: string,
  members: Record<string, string | null>,
): Promise<{ agentId: string; specPaths: Record<string, string> }> {
  await createAgent({ id: agentId, name: agentId });
  const specPaths: Record<string, string> = {};
  for (const [name, content] of Object.entries(members)) {
    const dir = path.join(root, agentId, AGENT_TEAM_DIR, name);
    const specPath = path.join(dir, AGENT_TEAM_SPEC_FILE);
    specPaths[name] = specPath;
    if (content === null) continue;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(specPath, content, "utf8");
  }
  return { agentId, specPaths };
}

function spec(fields: Record<string, string>, body = "你是训练助手。\n"): string {
  const head = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `---\n${head}\n---\n${body}`;
}

const GOOD = spec(
  {
    name: "trainer",
    description: "训练计划与动作编排",
    tools: "[read_file, todo_list]",
    model: '{"id":"deepseek-chat","providerId":"deepseek"}',
    skills: "[skills/plan]",
  },
  "你是训练助手，只负责训练计划。\n",
);

// —— 纯函数层 ——

describe("团队声明解析（对应 subagent-team 装载）", () => {
  test("合法 SPEC.md → valid=true，正文成为 systemPrompt", () => {
    const member = parseSubAgentSpec(GOOD, "trainer", { dir: "/x/trainer", specPath: "/x/trainer/SPEC.md" });
    expect(member.valid).toBe(true);
    expect(member.issues).toEqual([]);
    expect(member.name).toBe("trainer");
    expect(member.description).toBe("训练计划与动作编排");
    expect(member.tools).toEqual(["read_file", "todo_list"]);
    expect(member.model).toEqual({ id: "deepseek-chat", providerId: "deepseek" });
    expect(member.skills).toEqual(["skills/plan"]);
    expect(member.mode).toBe("isolated");
    // 正文**完全替换**内置提示词：给出去的就是 SPEC.md 正文本身
    expect(member.systemPrompt.trim()).toBe("你是训练助手，只负责训练计划。");
  });

  test("缺 description → valid=false，issue 含「缺少路由描述」+ specPath", () => {
    const member = parseSubAgentSpec(spec({ name: "no-desc" }), "no-desc", {
      dir: "/x/no-desc",
      specPath: "/x/no-desc/SPEC.md",
    });
    expect(member.valid).toBe(false);
    expect(member.issues.map((i) => i.code)).toContain("MISSING_DESCRIPTION");
    expect(member.issues[0]!.message).toContain("缺少路由描述");
    expect(member.issues[0]!.message).toContain("/x/no-desc/SPEC.md");
  });

  test("name 与目录名不一致 → valid=false，issue 同时给出两个值", () => {
    const member = parseSubAgentSpec(
      spec({ name: "trainer", description: "x" }),
      "coach",
      { dir: "/x/coach", specPath: "/x/coach/SPEC.md" },
    );
    expect(member.valid).toBe(false);
    const issue = member.issues.find((i) => i.code === "NAME_MISMATCH");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("trainer");
    expect(issue!.message).toContain("coach");
  });

  test("YAML 非法 → valid=false；同目录下另一个合法成员仍被列出（不拖垮整体）", async () => {
    const yamlBroken = parseSubAgentSpec("name: broken\ndescription: x\n", "broken");
    expect(yamlBroken.valid).toBe(false);
    expect(yamlBroken.issues[0]!.code).toBe("INVALID_FRONTMATTER");
    expect(yamlBroken.issues[0]!.message).toContain("元数据无法解析");

    const badLine = parseSubAgentSpec(
      "---\nname: b\ndescription: x\n::: 这不是键值对\n---\n正文\n",
      "b",
      { dir: "/x/b", specPath: "/x/b/SPEC.md" },
    );
    expect(badLine.valid).toBe(false);
    expect(badLine.issues[0]!.code).toBe("INVALID_FRONTMATTER");

    await makeAgentWithSpec("mixed", {
      trainer: GOOD,
      broken: "这不是 frontmatter\n",
    });
    const view = await listTeam("mixed");
    expect(view.members).toHaveLength(2);
    const byName = Object.fromEntries(view.members.map((m) => [m.name, m]));
    expect(byName["trainer"]!.valid).toBe(true);
    expect(byName["broken"]!.valid).toBe(false);
    expect(byName["broken"]!.issues.length).toBeGreaterThan(0);
  });

  test("目录名含 / 、.. 、空白 → valid=false", async () => {
    for (const bad of ["a/b", "..", "a b"]) {
      const member = parseSubAgentSpec(spec({ name: bad, description: "x" }), bad);
      expect(member.valid).toBe(false);
      expect(member.issues.map((i) => i.code)).toContain("INVALID_ID");
    }
  });

  test("mode 非法（handoff）被拒；fork / isolated 通过", () => {
    const handoff = parseSubAgentSpec(spec({ name: "a", description: "x", mode: "handoff" }), "a");
    expect(handoff.valid).toBe(false);
    expect(handoff.issues.map((i) => i.code)).toContain("INVALID_MODE");

    expect(parseSubAgentSpec(spec({ name: "a", description: "x", mode: "fork" }), "a").mode).toBe("fork");
    expect(parseSubAgentSpec(spec({ name: "a", description: "x" }), "a").mode).toBe("isolated");
  });

  test("与内置 general-purpose 同名 → valid=false（RESERVED_NAME）", async () => {
    const member = parseSubAgentSpec(
      spec({ name: "general-purpose", description: "x" }),
      "general-purpose",
    );
    expect(member.valid).toBe(false);
    expect(member.issues.map((i) => i.code)).toContain("RESERVED_NAME");
    await createAgent({ id: "reserved", name: "reserved" });
    await expect(
      createSubAgent("reserved", { name: "general-purpose", description: "x" }),
    ).rejects.toThrow(/内置/);
  });

  test("tools 缺省 → null；显式 [] → []；未知工具名 → 非法", () => {
    expect(parseSubAgentSpec(spec({ name: "a", description: "x" }), "a").tools).toBeNull();
    expect(parseSubAgentSpec(spec({ name: "a", description: "x", tools: "[]" }), "a").tools).toEqual([]);
    const unknown = parseSubAgentSpec(spec({ name: "a", description: "x", tools: "[read_file, nope]" }), "a");
    expect(unknown.valid).toBe(false);
    expect(unknown.issues.map((i) => i.code)).toContain("INVALID_TOOLS");
  });

  test("工具白名单：缺省继承已开启工具组；委派类工具永不下发；关掉的组拿不到", () => {
    const open = defaultAgentConfig({ id: "a" });
    const inherit = resolveSubAgentToolNames(null, open);
    expect(inherit).toContain("read_file");
    expect(inherit).toContain("todo_list");
    // 结构性防递归：即使声明里写了 task 也不给
    expect(resolveSubAgentToolNames(["task", "read_file"], open)).toEqual(["read_file"]);

    const closed = defaultAgentConfig({ id: "a" });
    closed.tools["files"] = false;
    expect(resolveSubAgentToolNames(null, closed)).not.toContain("read_file");
    // 主 agent 关掉的工具组，SPEC.md 里写了也拿不到
    expect(resolveSubAgentToolNames(["read_file", "todo_list"], closed)).toEqual(["todo_list"]);
  });

  test("loadTeam：非法声明被跳过，合法成员照常装载", async () => {
    await makeAgentWithSpec("loaded", {
      ok1: spec({ name: "ok1", description: "甲" }),
      bad1: spec({ name: "bad1" }),
      bad2: "没有 frontmatter\n",
    });
    const team = await loadTeam("loaded");
    expect(team.members.map((m) => m.name)).toEqual(["ok1"]);
    expect(team.issues.map((i) => i.name).sort()).toEqual(["bad1", "bad2"]);
  });

  test("无 team/ 目录 → exists=false、members=[]（不抛错）", async () => {
    await createAgent({ id: "plain", name: "plain" });
    const team = await loadTeam("plain");
    expect(team.exists).toBe(false);
    expect(team.members).toEqual([]);
    expect(team.issues).toEqual([]);
  });
});

// —— HTTP 层 ——

describe("HTTP：GET /agents/:id/team", () => {
  test("形状 + toolCatalog.enabled 跟随主 agent config.tools", async () => {
    await makeAgentWithSpec("viewer", { trainer: GOOD });
    const app = await loadApp();
    const res = await app.request("/agents/viewer/team");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agentId: string;
      dir: string;
      teamDir: string;
      exists: boolean;
      toolCatalog: { group: string; enabled: boolean; tools: string[] }[];
      members: { name: string; valid: boolean }[];
      builtins: { name: string; builtin: boolean }[];
    };
    expect(body.agentId).toBe("viewer");
    expect(body.dir.endsWith("viewer")).toBe(true);
    expect(body.teamDir).toBe(path.join(body.dir, AGENT_TEAM_DIR));
    expect(body.exists).toBe(true);
    expect(body.members.map((m) => m.name)).toEqual(["trainer"]);
    expect(body.members[0]!.valid).toBe(true);

    const delegation = body.toolCatalog.find((g) => g.group === "delegation");
    expect(delegation?.enabled).toBe(false);
    expect(delegation?.tools).toContain("task");

    // 把 delegation 组打开后再取一次
    await app.request("/agents/viewer", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { tools: { delegation: true } } }),
    });
    const after = (await (await app.request("/agents/viewer/team")).json()) as {
      toolCatalog: { group: string; enabled: boolean }[];
    };
    expect(after.toolCatalog.find((g) => g.group === "delegation")?.enabled).toBe(true);

    // 运行时内置成员被显式列出（不隐式存在）
    expect(body.builtins.map((b) => b.name)).toEqual(["general-purpose"]);
  });

  test("无 team/ 目录 → 200 + exists:false（不是 404）", async () => {
    const app = await loadApp();
    await createAgent({ id: "empty-team", name: "empty" });
    const res = await app.request("/agents/empty-team/team");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exists: boolean; members: unknown[] };
    expect(body.exists).toBe(false);
    expect(body.members).toEqual([]);
  });

  test("agent 不存在 → 404 AGENT_NOT_FOUND；标识非法 → 400 AGENT_INVALID_ID", async () => {
    const app = await loadApp();
    const missing = await app.request("/agents/nobody/team");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("AGENT_NOT_FOUND");

    const invalid = await app.request("/agents/a%20b/team");
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: string }).error).toBe("AGENT_INVALID_ID");
  });
});

describe("HTTP：POST /agents/:id/team", () => {
  test("建目录 + 写骨架，随后列表里 valid=true", async () => {
    const app = await loadApp();
    await createAgent({ id: "creator", name: "creator" });
    const res = await app.request("/agents/creator/team", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "coach", description: "训练节奏与恢复" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("coach");

    const content = await fs.readFile(path.join(root, "creator", AGENT_TEAM_DIR, "coach", AGENT_TEAM_SPEC_FILE), "utf8");
    expect(content).toContain("name: coach");
    expect(content).toContain("description: 训练节奏与恢复");
    // 骨架**不写** tools / model / skills（保持「未声明 = 继承」）
    expect(content).not.toContain("tools:");
    expect(content).not.toContain("model:");
    expect(content).not.toContain("skills:");

    const view = (await (await app.request("/agents/creator/team")).json()) as {
      members: { name: string; valid: boolean; description: string }[];
    };
    expect(view.members).toHaveLength(1);
    expect(view.members[0]!.valid).toBe(true);
    expect(view.members[0]!.description).toBe("训练节奏与恢复");
  });

  test("重名 → 409 SUBAGENT_ALREADY_EXISTS", async () => {
    const app = await loadApp();
    await createAgent({ id: "dup", name: "dup" });
    const body = JSON.stringify({ name: "same", description: "同一个" });
    await app.request("/agents/dup/team", { method: "POST", headers: { "content-type": "application/json" }, body });
    const again = await app.request("/agents/dup/team", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("SUBAGENT_ALREADY_EXISTS");
  });

  test("非法目录名 → 400 SUBAGENT_INVALID_ID", async () => {
    const app = await loadApp();
    await createAgent({ id: "badname", name: "badname" });
    for (const bad of ["a/b", "..", "a b", ".hidden"]) {
      const res = await app.request("/agents/badname/team", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: bad, description: "x" }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("SUBAGENT_INVALID_ID");
    }
  });

  test("description 为空 → 400，且目录未被创建", async () => {
    const app = await loadApp();
    await createAgent({ id: "nodesc", name: "nodesc" });
    const res = await app.request("/agents/nodesc/team", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ghost", description: "   " }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field?: string };
    expect(body.error).toBe("SUBAGENT_INVALID_SPEC");
    expect(body.field).toBe("description");
    await expect(fs.stat(path.join(root, "nodesc", AGENT_TEAM_DIR, "ghost"))).rejects.toThrow();
  });
});

describe("HTTP：PUT /agents/:id/team/:name", () => {
  test("改 description → 落盘；同时改 tools+model → 正文不被改动", async () => {
    const app = await loadApp();
    const { specPaths } = await makeAgentWithSpec("editor", { trainer: GOOD });
    const before = await fs.readFile(specPaths["trainer"]!, "utf8");

    const res = await app.request("/agents/editor/team/trainer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: "新的路由描述",
        tools: ["read_file"],
        model: { id: "qwen-max", providerId: "aliyun" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; member: { description: string; tools: string[]; model: unknown } };
    expect(body.name).toBe("trainer");
    expect(body.member.description).toBe("新的路由描述");
    expect(body.member.tools).toEqual(["read_file"]);
    expect(body.member.model).toEqual({ id: "qwen-max", providerId: "aliyun" });

    const after = await fs.readFile(specPaths["trainer"]!, "utf8");
    expect(after).toContain("description: 新的路由描述");
    expect(after).toContain("model:");
    const bodyOfBefore = before.split("---\n")[2]!;
    const bodyOfAfter = after.split("---\n")[2]!;
    expect(bodyOfAfter).toBe(bodyOfBefore);
  });

  test("清空 description → 400 + field=description，且文件字节完全不变", async () => {
    const app = await loadApp();
    const { specPaths } = await makeAgentWithSpec("guard", { trainer: GOOD });
    const before = await fs.readFile(specPaths["trainer"]!, "utf8");
    const res = await app.request("/agents/guard/team/trainer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field?: string };
    expect(body.error).toBe("SUBAGENT_INVALID_SPEC");
    expect(body.field).toBe("description");
    expect(await fs.readFile(specPaths["trainer"]!, "utf8")).toBe(before);
  });

  test("未知工具名 → 400 且文件不变；mode 非法 → 400", async () => {
    const app = await loadApp();
    const { specPaths } = await makeAgentWithSpec("guard2", { trainer: GOOD });
    const before = await fs.readFile(specPaths["trainer"]!, "utf8");

    const unknown = await app.request("/agents/guard2/team/trainer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools: ["read_file", "nope"] }),
    });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { field?: string }).field).toBe("tools");
    expect(await fs.readFile(specPaths["trainer"]!, "utf8")).toBe(before);

    const mode = await app.request("/agents/guard2/team/trainer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "handoff" }),
    });
    expect(mode.status).toBe(400);
    expect(((await mode.json()) as { field?: string }).field).toBe("mode");
    expect(await fs.readFile(specPaths["trainer"]!, "utf8")).toBe(before);
  });

  test("tools 传 null → frontmatter 里的 tools 键消失；正文保留", async () => {
    const app = await loadApp();
    const { specPaths } = await makeAgentWithSpec("nuller", { trainer: GOOD });
    const res = await app.request("/agents/nuller/team/trainer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools: null, skills: null }),
    });
    expect(res.status).toBe(200);
    const after = await fs.readFile(specPaths["trainer"]!, "utf8");
    expect(after).not.toContain("tools:");
    expect(after).not.toContain("skills:");
    expect(after).toContain("训练助手");
    const member = (await (await app.request("/agents/nuller/team/trainer")).json()) as {
      member: { tools: unknown; skills: unknown };
    };
    expect(member.member.tools).toBeNull();
    expect(member.member.skills).toBeNull();
  });

  test("改正文 → 落盘且 frontmatter 保留", async () => {
    const app = await loadApp();
    const { specPaths } = await makeAgentWithSpec("body", { trainer: GOOD });
    const res = await app.request("/agents/body/team/trainer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ systemPrompt: "你是完全不同的角色。\n" }),
    });
    expect(res.status).toBe(200);
    const after = await fs.readFile(specPaths["trainer"]!, "utf8");
    expect(after).toContain("description: 训练计划与动作编排");
    expect(after.split("---\n")[2]!).toBe("你是完全不同的角色。\n");
  });

  test("不存在的子 agent → 404 SUBAGENT_NOT_FOUND；目录名非法 → 400", async () => {
    const app = await loadApp();
    await createAgent({ id: "miss", name: "miss" });
    const res = await app.request("/agents/miss/team/ghost", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "x" }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("SUBAGENT_NOT_FOUND");

    const bad = await app.request("/agents/miss/team/a%20b", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "x" }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("SUBAGENT_INVALID_ID");
  });

  test("纯函数入口同契约：updateSubAgent 合并不合法时抛且不写", async () => {
    const { specPaths } = await makeAgentWithSpec("pure", { trainer: GOOD });
    const before = await fs.readFile(specPaths["trainer"]!, "utf8");
    await expect(updateSubAgent("pure", "trainer", { mode: "nope" })).rejects.toThrow(/mode/);
    expect(await fs.readFile(specPaths["trainer"]!, "utf8")).toBe(before);
  });
});

// —— 图出口层 ——

/** 从建好的图里取出 tools 节点挂着的工具（name + description） */
function graphTools(graph: unknown): { name: string; description: string }[] {
  const seen = new Set<unknown>();
  const out: { name: string; description: string }[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 8 || value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj["name"] === "string" && typeof obj["description"] === "string") {
      out.push({ name: obj["name"], description: obj["description"] });
    }
    for (const key of Object.keys(obj)) {
      if (key === "builder" || key === "checkpointer" || key === "lc_kwargs") continue;
      walk(obj[key], depth + 1);
    }
  };
  const nested = (graph as { graph?: Record<string, unknown> })?.graph;
  walk(nested?.["nodes"]?.["tools"], 0);
  return out;
}

describe("图出口：声明式团队接到 deepagents 的 subagents", () => {
  test("导出是工厂函数（对象导出会让改 SPEC.md 不生效）", async () => {
    const { agent } = await import("../src/agent.js");
    expect(typeof agent).toBe("function");
  });

  test("合法成员进 task 工具描述（主 agent 的选人依据）；非法声明不进", async () => {
    const { agent } = await import("../src/agent.js");
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-team-ws-")));
    await makeAgentWithSpec("wired", {
      planner: spec({ name: "planner", description: "专门负责训练计划与动作编排" }),
      broken: spec({ name: "broken" }),
    });
    const app = await loadApp();
    await app.request("/workspace/binding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: workspace, agentId: "wired", mode: "keep" }),
    });

    // 图出口是工厂函数：**每次调用**读一次 team/，所以这里改完声明重调就生效
    const graph = await agent({ configurable: { workspace } });
    const task = graphTools(graph).find((tool) => tool.name === "task");
    expect(task).toBeDefined();
    expect(task!.description).toContain("planner");
    expect(task!.description).toContain("专门负责训练计划与动作编排");
    // 非法声明（缺 description）不进运行时
    expect(task!.description).not.toContain("broken");
    // 运行时内置成员也在（deepagents 总是注入，显式可见）
    expect(task!.description).toContain("general-purpose");
    // 子 agent 永远拿不到委派工具：task 工具本身不在主 agent 之外下发
    expect(graphTools(graph).some((tool) => tool.name === "task")).toBe(true);

    await fs.rm(workspace, { recursive: true, force: true });
  });

  test("改 SPEC.md 后重新建图，task 描述跟着变（配置生效 = 工厂函数的意义）", async () => {
    const { agent } = await import("../src/agent.js");
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-team-ws-")));
    await makeAgentWithSpec("wired2", {
      planner: spec({ name: "planner", description: "第一版描述" }),
    });
    const app = await loadApp();
    await app.request("/workspace/binding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: workspace, agentId: "wired2", mode: "keep" }),
    });

    const first = graphTools(await agent({ configurable: { workspace } })).find((t) => t.name === "task");
    expect(first!.description).toContain("第一版描述");

    const put = await app.request("/agents/wired2/team/planner", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "第二版描述" }),
    });
    expect(put.status).toBe(200);

    const second = graphTools(await agent({ configurable: { workspace } })).find((t) => t.name === "task");
    expect(second!.description).toContain("第二版描述");
    expect(second!.description).not.toContain("第一版描述");

    await fs.rm(workspace, { recursive: true, force: true });
  });

  test("没有团队时主 agent 照常建图（task 工具仍在，只有内置 general-purpose）", async () => {
    const { agent } = await import("../src/agent.js");
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-team-ws-")));
    await createAgent({ id: "teamless", name: "teamless" });
    const app = await loadApp();
    await app.request("/workspace/binding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: workspace, agentId: "teamless", mode: "keep" }),
    });
    const graph = await agent({ configurable: { workspace } });
    const task = graphTools(graph).find((t) => t.name === "task");
    expect(task).toBeDefined();
    expect(task!.description).toContain("general-purpose");

    // 没有工作区（例如 langgraph 的静态 schema 抽取）也不能炸
    const plain = await agent({ configurable: {} });
    expect(plain).toBeDefined();

    await fs.rm(workspace, { recursive: true, force: true });
  });
});
