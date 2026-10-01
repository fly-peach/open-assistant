/**
 * tasks 1.1–1.12：Agent 注册表与工作区绑定。
 *
 * 分层验证：
 * - 纯函数 / 文件系统层：agents 根解析、标识校验、配置默认与非法拒绝、人设三档、记忆读写、绑定记录；
 * - HTTP 层：`/agents*` 与 `/workspace/binding` 契约（与前端同一份出口）；
 * - 图运行层：用**生产用的中间件组合**（agentBindingMiddleware + workspaceMiddleware）
 *   + 脚本化假模型跑真实 graph，断言「未绑定被拒」「两个 agent 人设不互相污染」「工具白名单不被绕过」。
 *   真实模型 + dev server 的验证见 scripts/probe-agents.ts。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { createDeepAgent, FilesystemBackend } from "deepagents";

import {
  AGENT_CONFIG_FILE,
  AGENT_CORE_MEMORY_FILE,
  AGENT_MEMORY_DIR,
  AGENT_DIGEST_DIR,
  AGENT_HEARTBEAT_FILE,
  AGENT_PERSONA_FILE,
  AGENT_SKILLS_DIR,
  AGENTS_ROOT_ENV,
  DEFAULT_AGENT_ID,
} from "../src/agents/root.js";
import {
  clearAgentRuntimeCache,
  createAgent,
  isValidAgentId,
  listAgents,
  readAgent,
  resolveAgentRuntime,
  updateAgent,
} from "../src/agents/registry.js";
import { defaultAgentConfig, gateTool, normalizeAgentConfig } from "../src/agents/config.js";
import { AgentError } from "../src/agents/errors.js";
import { loadPersona } from "../src/persona.js";
import {
  readBinding,
  readSessionOwners,
  workspaceProjectPath,
  writeBinding,
} from "../src/binding.js";
import { workspaceAppDataDir, workspaceSessionIndexPath } from "../src/workspace.js";
import { agentBindingMiddleware, workspaceMiddleware } from "../src/workspace-middleware.js";
import { todoTools } from "../src/todo-tools.js";
import { personaTools } from "../src/persona-tools.js";

process.env.OPEN_ASSISTANT_DISABLE_MIGRATION = "1";

let root: string;
let workspaceRoot: string;
let counter = 0;

const originalAgentsRoot = process.env[AGENTS_ROOT_ENV];

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-agents-")));
  workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-agents-ws-")));
  process.env[AGENTS_ROOT_ENV] = root;
});

afterAll(async () => {
  if (originalAgentsRoot === undefined) delete process.env[AGENTS_ROOT_ENV];
  else process.env[AGENTS_ROOT_ENV] = originalAgentsRoot;
  clearAgentRuntimeCache();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

async function freshWorkspace(name: string): Promise<string> {
  counter += 1;
  const p = path.join(workspaceRoot, `${name}-${counter}`);
  await fs.mkdir(p, { recursive: true });
  return fs.realpath(p);
}

async function loadApp() {
  return (await import("../src/http.js")).app;
}

// —— 脚本化假模型（与 init-bootstrap.test.ts 同构）——

class ScriptedChatModel extends BaseChatModel {
  readonly calls: BaseMessage[][] = [];
  private readonly script: AIMessage[];

  constructor(script: AIMessage[]) {
    super({});
    this.script = [...script];
  }

  _llmType(): string {
    return "scripted";
  }

  bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const next = this.script.length > 1 ? (this.script.shift() as AIMessage) : this.script[0]!;
    return {
      generations: [{ text: typeof next.content === "string" ? next.content : "", message: next }],
    };
  }
}

/** 用生产中间件组合 + 假模型建同构 graph（只差模型） */
function makeAgentGraph(workspace: string, script: AIMessage[]) {
  const model = new ScriptedChatModel(script);
  const graph = createDeepAgent({
    model,
    systemPrompt: "内置默认人设",
    tools: [...todoTools, ...personaTools],
    backend: () => new FilesystemBackend({ rootDir: workspace, virtualMode: true }),
    middleware: [agentBindingMiddleware, workspaceMiddleware],
  });
  return { graph, model };
}

function toolCall(name: string, args: Record<string, unknown>, id = "call-1") {
  return new AIMessage({ content: "", tool_calls: [{ name, args, id }] });
}

function userMessage(content: string) {
  return { type: "human" as const, content };
}

async function writeConfig(id: string, config: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(root, id, AGENT_CONFIG_FILE),
    JSON.stringify({ version: 1, ...config }, null, 2),
    "utf8",
  );
}

describe("1.1 agents 根解析：默认路径与人设/配置/记忆/技能布局", () => {
  test("未配置 → 默认 ~/open-assistant-agents；配置后生效", async () => {
    const { resolveAgentsRoot } = await import("../src/agents/root.js");
    expect(resolveAgentsRoot({})).toBe(path.resolve(os.homedir(), "open-assistant-agents"));
    expect(resolveAgentsRoot({ [AGENTS_ROOT_ENV]: "" })).toBe(
      path.resolve(os.homedir(), "open-assistant-agents"),
    );
    const custom = path.join(root, "custom-root");
    expect(resolveAgentsRoot({ [AGENTS_ROOT_ENV]: custom })).toBe(path.resolve(custom));
  });

  test("列出时为当前生效的根目录（只读）", async () => {
    const app = await loadApp();
    const res = await app.request("/agents");
    const body = (await res.json()) as { root: string; agents: unknown[] };
    expect(res.status).toBe(200);
    expect(body.root).toBe(path.resolve(root));
  });
});

describe("1.2 创建 agent 目录骨架", () => {
  test("POST /agents 生成 AGENTS.md / config.json / memory.md / skills/", async () => {
    const app = await loadApp();
    const res = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "writer", name: "写手", description: "负责写作" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("writer");

    const dir = path.join(root, "writer");
    const entries = (await fs.readdir(dir)).sort();
    // 分层记忆（tasks 11.1）：核心 MEMORY.md + memory/ + digest/ + imports/，不再是单文件 memory.md
    // 心跳（tasks 11.7）：新建 agent 时一并播种 HEARTBEAT.md
    expect(entries).toEqual(
      [
        AGENT_CONFIG_FILE,
        AGENT_CORE_MEMORY_FILE,
        AGENT_DIGEST_DIR,
        AGENT_HEARTBEAT_FILE,
        AGENT_MEMORY_DIR,
        AGENT_PERSONA_FILE,
        AGENT_SKILLS_DIR,
      ].sort(),
    );
    expect((await fs.stat(path.join(dir, AGENT_SKILLS_DIR))).isDirectory()).toBe(true);
    expect((await fs.readFile(path.join(dir, AGENT_PERSONA_FILE), "utf8")).length).toBeGreaterThan(50);

    const config = JSON.parse(await fs.readFile(path.join(dir, AGENT_CONFIG_FILE), "utf8")) as {
      name: string;
      allowSiblingInteraction: boolean;
      approval: string;
    };
    expect(config.name).toBe("写手");
    expect(config.allowSiblingInteraction).toBe(false);
    expect(config.approval).toBe("auto");
  });
});

describe("1.3 agent 标识校验", () => {
  test("纯函数：分隔符 / .. / 空白 / 空 / 特殊字符被拒", () => {
    expect(isValidAgentId("writer")).toBe(true);
    expect(isValidAgentId("writer-2")).toBe(true);
    expect(isValidAgentId("小助")).toBe(true);
    expect(isValidAgentId("")).toBe(false);
    expect(isValidAgentId("  ")).toBe(false);
    expect(isValidAgentId("a/b")).toBe(false);
    expect(isValidAgentId("a\\b")).toBe(false);
    expect(isValidAgentId("..")).toBe(false);
    expect(isValidAgentId("../evil")).toBe(false);
    expect(isValidAgentId("a..b")).toBe(false);
    expect(isValidAgentId("a b")).toBe(false);
    expect(isValidAgentId("a:b")).toBe(false);
    expect(isValidAgentId(".hidden")).toBe(false);
    expect(isValidAgentId(undefined)).toBe(false);
  });

  test("POST /agents 逐种非法输入被拒且报错可读", async () => {
    const app = await loadApp();
    for (const bad of ["a/b", "..\\..", "a b", ".hidden"]) {
      const res = await app.request("/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: bad }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("AGENT_INVALID_ID");
      expect(body.message.length).toBeGreaterThan(0);
    }
  });

  test("重名 → 409", async () => {
    const app = await loadApp();
    const res = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "writer" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("AGENT_ALREADY_EXISTS");
  });
});

describe("1.4 agent 列表与异常标注", () => {
  test("残缺 agent 被标注而不是整体失败", async () => {
    // 造一个残缺 agent：没有 AGENTS.md、config.json 非法
    await fs.mkdir(path.join(root, "broken"), { recursive: true });
    await fs.writeFile(path.join(root, "broken", AGENT_CONFIG_FILE), "{ not json", "utf8");
    // 合法 agent 也要在列表里
    const listed = await listAgents();
    const ids = listed.agents.map((a) => a.id);
    expect(ids).toContain("writer");
    expect(ids).toContain("broken");

    const broken = listed.agents.find((a) => a.id === "broken")!;
    expect(broken.valid).toBe(false);
    expect((broken.issues ?? []).join("\n")).toContain(AGENT_PERSONA_FILE);
    expect((broken.issues ?? []).join("\n")).toContain(AGENT_CONFIG_FILE);

    const writer = listed.agents.find((a) => a.id === "writer")!;
    expect(writer.valid).toBe(true);
    expect(writer.name).toBe("写手");
  });

  test("列表带出每个 agent 的模型（不同 agent 可以各配各的）", async () => {
    // writer：显式指定了模型
    const writerConfigPath = path.join(root, "writer", AGENT_CONFIG_FILE);
    const writerConfig = JSON.parse(await fs.readFile(writerConfigPath, "utf8")) as Record<
      string,
      unknown
    >;
    writerConfig["model"] = { id: "deepseek-chat", providerId: "deepseek" };
    await fs.writeFile(writerConfigPath, JSON.stringify(writerConfig, null, 2), "utf8");

    // bare：新建的 agent，model 为 null（没说用哪个 → 跟随全局默认）
    await createAgent({ id: "bare", name: "跟随默认" });

    const listed = await listAgents();
    const writer = listed.agents.find((a) => a.id === "writer")!;
    const bare = listed.agents.find((a) => a.id === "bare")!;
    const broken = listed.agents.find((a) => a.id === "broken")!;

    expect(writer.model).toEqual({ id: "deepseek-chat", providerId: "deepseek" });
    // null 与 undefined 是两回事：null = 跟随全局默认，undefined = 配置读不出来
    expect(bare.model).toBe(null);
    expect(broken.model).toBeUndefined();
    // 老配置只有 baseUrl、没有 providerId 时也不要编一个供应商出来
    const oldConfigPath = path.join(root, "writer", AGENT_CONFIG_FILE);
    const oldConfig = JSON.parse(await fs.readFile(oldConfigPath, "utf8")) as Record<string, unknown>;
    oldConfig["model"] = { id: "legacy-model" };
    await fs.writeFile(oldConfigPath, JSON.stringify(oldConfig, null, 2), "utf8");
    clearAgentRuntimeCache();
    const again = await listAgents();
    expect(again.agents.find((a) => a.id === "writer")!.model).toEqual({ id: "legacy-model" });
  });
});

describe("1.5 配置结构与默认值", () => {
  test("缺字段用默认；非法值被拒并指出字段", () => {
    const config = normalizeAgentConfig({}, "agent x", { id: "x" });
    expect(config.approval).toBe("auto");
    expect(config.allowSiblingInteraction).toBe(false);
    expect(config.contactableAgents).toEqual([]);
    expect(config.tools.todos).toBe(true);
    expect(config.tools.peers).toBe(false);
    expect(config.model).toBe(null);

    expect(() => normalizeAgentConfig({ approval: "sometimes" }, "agent x", { id: "x" })).toThrow(
      /approval/,
    );
    expect(() => normalizeAgentConfig({ tools: { nope: true } }, "agent x", { id: "x" })).toThrow(
      /未知工具组/,
    );
    expect(() =>
      normalizeAgentConfig({ allowSiblingInteraction: "yes" }, "agent x", { id: "x" }),
    ).toThrow(/allowSiblingInteraction/);
    expect(() => normalizeAgentConfig({ unknownKey: 1 }, "agent x", { id: "x" })).toThrow(
      /unknownKey/,
    );
  });

  test("工具白名单：关掉的组被 gateTool 拦下；同侪开关默认关", () => {
    const config = defaultAgentConfig({ id: "x" });
    expect(gateTool(config, "todo_create").allowed).toBe(true);
    const limited = normalizeAgentConfig({ tools: { todos: false } }, "agent x", { id: "x" });
    expect(gateTool(limited, "todo_create").allowed).toBe(false);
    expect(gateTool(limited, "todo_create").reason).toContain("todos");
    expect(gateTool(limited, "read_file").allowed).toBe(true);
    expect(gateTool(config, "ask_peer").allowed).toBe(false);
    const social = normalizeAgentConfig(
      { tools: { peers: true }, allowSiblingInteraction: true },
      "agent x",
      { id: "x" },
    );
    expect(gateTool(social, "ask_peer").allowed).toBe(true);
    // 未知工具（结构性）默认放行
    expect(gateTool(limited, "write_todos").allowed).toBe(true);
  });

  test("运行时读取非法配置 → AGENT_INVALID_CONFIG", async () => {
    const err = await resolveAgentRuntime("broken").catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe("AGENT_INVALID_CONFIG");
  });
});

describe("1.6 按 agent_id 解析并缓存运行实例", () => {
  test("首次解析构建、再次解析复用、定义变更后失效重建", async () => {
    await createAgent({ id: "cached", name: "缓存" });
    clearAgentRuntimeCache();
    const first = await resolveAgentRuntime("cached");
    expect(first.persona).toContain("# 我是谁"); // 内置默认人设被写进 AGENTS.md

    const second = await resolveAgentRuntime("cached");
    expect(second).toBe(first); // 同一实例（缓存命中）

    await new Promise((r) => setTimeout(r, 10));
    await updateAgent("cached", { persona: "# 我是缓存 agent\n" });
    const third = await resolveAgentRuntime("cached");
    expect(third).not.toBe(first);
    expect(third.persona).toBe("# 我是缓存 agent");
  });

  test("两个 agent 各自解析出自己的人设与配置，互不污染", async () => {
    await createAgent({ id: "alpha", name: "Alpha" });
    await createAgent({ id: "beta", name: "Beta" });
    await updateAgent("alpha", { persona: "# 我是 Alpha\n只做 Alpha 的事。" });
    await updateAgent("beta", { persona: "# 我是 Beta\n只做 Beta 的事。", config: { tools: { todos: false } } });

    const a = await resolveAgentRuntime("alpha");
    const b = await resolveAgentRuntime("beta");
    expect(a.persona).toContain("Alpha");
    expect(a.persona).not.toContain("Beta");
    expect(b.persona).toContain("Beta");
    expect(b.persona).not.toContain("Alpha");
    expect(a.config.tools.todos).toBe(true);
    expect(b.config.tools.todos).toBe(false);
  });

  test("真实图运行：两个 agent 先后跑，各自系统提示词只含自己的人设", async () => {
    const wsA = await freshWorkspace("run-a");
    const wsB = await freshWorkspace("run-b");
    await writeBinding(wsA, "alpha");
    await writeBinding(wsB, "beta");

    const runA = makeAgentGraph(wsA, [new AIMessage("ok")]);
    await runA.graph.invoke({ messages: [userMessage("你是谁")] }, { configurable: { workspace: wsA } });
    const sysA = (runA.model.calls[0]![0] as SystemMessage).text;
    expect(sysA).toContain("我是 Alpha");
    expect(sysA).not.toContain("Beta");

    const runB = makeAgentGraph(wsB, [new AIMessage("ok")]);
    await runB.graph.invoke({ messages: [userMessage("你是谁")] }, { configurable: { workspace: wsB } });
    const sysB = (runB.model.calls[0]![0] as SystemMessage).text;
    expect(sysB).toContain("我是 Beta");
    expect(sysB).not.toContain("Alpha");
  });
});

describe("1.7 人设三档优先级", () => {
  test("agent → workspace → 内置默认", async () => {
    await createAgent({ id: "tier-agent" });
    await updateAgent("tier-agent", { persona: "# 第一档：agent 人设\n" });
    const agentDir = path.join(root, "tier-agent");
    const ws = await freshWorkspace("tier");
    await fs.writeFile(path.join(ws, AGENT_PERSONA_FILE), "# 第二档：工作区人设\n", "utf8");

    const tier1 = await loadPersona({ agentDir, workspaceDir: ws });
    expect(tier1).toEqual({ content: "# 第一档：agent 人设", tier: "agent" });

    const noPersonaAgent = await createAgent({ id: "tier-empty" });
    await fs.rm(path.join(root, noPersonaAgent, AGENT_PERSONA_FILE));
    const tier2 = await loadPersona({ agentDir: path.join(root, noPersonaAgent), workspaceDir: ws });
    expect(tier2.tier).toBe("workspace");
    expect(tier2.content).toContain("第二档");

    const bare = await freshWorkspace("tier-bare");
    const tier3 = await loadPersona({ agentDir: path.join(root, noPersonaAgent), workspaceDir: bare });
    expect(tier3).toEqual({ content: null, tier: "builtin" });
  });

  test("图运行：三档各跑一次，系统提示词可区分", async () => {
    const withAgent = await freshWorkspace("tier-run-agent");
    await writeBinding(withAgent, "tier-agent");
    const a = makeAgentGraph(withAgent, [new AIMessage("ok")]);
    await a.graph.invoke({ messages: [userMessage("hi")] }, { configurable: { workspace: withAgent } });
    expect((a.model.calls[0]![0] as SystemMessage).text).toContain("第一档：agent 人设");

    const withWorkspace = await freshWorkspace("tier-run-ws");
    await writeBinding(withWorkspace, "tier-empty");
    await fs.writeFile(path.join(withWorkspace, AGENT_PERSONA_FILE), "# 第二档：工作区人设\n", "utf8");
    const b = makeAgentGraph(withWorkspace, [new AIMessage("ok")]);
    await b.graph.invoke({ messages: [userMessage("hi")] }, { configurable: { workspace: withWorkspace } });
    expect((b.model.calls[0]![0] as SystemMessage).text).toContain("第二档：工作区人设");

    const builtin = await freshWorkspace("tier-run-builtin");
    await writeBinding(builtin, "tier-empty");
    const c = makeAgentGraph(builtin, [new AIMessage("ok")]);
    await c.graph.invoke({ messages: [userMessage("hi")] }, { configurable: { workspace: builtin } });
    const sysC = (c.model.calls[0]![0] as SystemMessage).text;
    expect(sysC).toBe("内置默认人设");
    expect(sysC).not.toContain("<persona>");
  });
});

describe("1.8 agent 长期记忆跨工作区共享", () => {
  test("PUT /agents/{id}/memory → 在另一个工作区运行时被注入", async () => {
    const app = await loadApp();
    await createAgent({ id: "memo", name: "记忆" });
    const put = await app.request("/agents/memo/memory", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "- 用户偏好：回复先给结论" }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { ok: boolean }).ok).toBe(true);

    const got = await app.request("/agents/memo/memory");
    expect(((await got.json()) as { content: string }).content).toContain("先给结论");

    // 在 A 工作区写入 → 在 B 工作区可读（记忆属于 agent，不属于工作区）
    const wsA = await freshWorkspace("memo-a");
    const wsB = await freshWorkspace("memo-b");
    await writeBinding(wsA, "memo");
    await writeBinding(wsB, "memo");
    const runB = makeAgentGraph(wsB, [new AIMessage("ok")]);
    await runB.graph.invoke({ messages: [userMessage("hi")] }, { configurable: { workspace: wsB } });
    const sysB = (runB.model.calls[0]![0] as SystemMessage).text;
    expect(sysB).toContain("<agent_memory>");
    expect(sysB).toContain("先给结论");
  });
});

describe("1.9 工作区绑定记录", () => {
  test("PUT /workspace/binding 写 <ws>/.open-assistant/project.json，可读回", async () => {
    const app = await loadApp();
    const ws = await freshWorkspace("bind-file");
    const res = await app.request("/workspace/binding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ws, agentId: "writer", mode: "keep" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agentId: string }).agentId).toBe("writer");

    const file = workspaceProjectPath(ws);
    expect(file).toBe(path.join(workspaceAppDataDir(ws), "project.json"));
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as { agentId: string; createdAt: string };
    expect(raw.agentId).toBe("writer");
    expect(typeof raw.createdAt).toBe("string");

    const view = await app.request(`/workspace/binding?path=${encodeURIComponent(ws)}`);
    const body = (await view.json()) as { agentId: string | null; agentName?: string };
    expect(body.agentId).toBe("writer");
    expect(body.agentName).toBe("写手");
  });

  test("未绑定 → agentId: null；绑定不存在的 agent → 404", async () => {
    const app = await loadApp();
    const ws = await freshWorkspace("bind-none");
    const res = await app.request(`/workspace/binding?path=${encodeURIComponent(ws)}`);
    expect(((await res.json()) as { agentId: string | null }).agentId).toBe(null);

    const bad = await app.request("/workspace/binding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ws, agentId: "ghost", mode: "keep" }),
    });
    expect(bad.status).toBe(404);
    expect(((await bad.json()) as { error: string }).error).toBe("AGENT_NOT_FOUND");
  });
});

describe("1.10 未绑定的工作区不得对话", () => {
  test("生产中间件组合：未绑定 → run 被拒且错误可读", async () => {
    const ws = await freshWorkspace("unbound");
    const { graph } = makeAgentGraph(ws, [new AIMessage("不应该跑起来")]);
    const err = await graph
      .invoke({ messages: [userMessage("你好")] }, { configurable: { workspace: ws } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("未绑定");
  });

  test("绑定后即可对话", async () => {
    const ws = await freshWorkspace("bound-ok");
    await writeBinding(ws, "writer");
    const { graph, model } = makeAgentGraph(ws, [new AIMessage("绑定后可以对话")]);
    const result = await graph.invoke(
      { messages: [userMessage("你好")] },
      { configurable: { workspace: ws } },
    );
    expect(model.calls.length).toBe(1);
    expect((result as { messages: unknown[] }).messages.length).toBeGreaterThanOrEqual(2);
  });

  test("绑定指向不存在的 agent → 拒绝且明确指出标识", async () => {
    const ws = await freshWorkspace("bound-ghost");
    // 绕过 writeBinding 的存在性校验，手工造一条坏绑定
    await fs.mkdir(workspaceAppDataDir(ws), { recursive: true });
    await fs.writeFile(
      workspaceProjectPath(ws),
      JSON.stringify({ version: 1, agentId: "ghost", createdAt: new Date().toISOString() }),
      "utf8",
    );
    const { graph } = makeAgentGraph(ws, [new AIMessage("不应执行")]);
    const err = await graph
      .invoke({ messages: [userMessage("你好")] }, { configurable: { workspace: ws } })
      .catch((e) => e);
    expect((err as Error).message).toContain("ghost");
    expect((err as Error).message).toContain("不存在");
  });
});

describe("1.11 换绑：keep / archive 与换绑痕迹", () => {
  test("keep（默认）：历史保留并标注创建时所属 agent", async () => {
    const ws = await freshWorkspace("switch-keep");
    await fs.mkdir(workspaceAppDataDir(ws), { recursive: true });
    await fs.writeFile(
      workspaceSessionIndexPath(ws),
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), sessions: [{ id: "t-1" }, { id: "t-2" }] }),
      "utf8",
    );
    await writeBinding(ws, "writer");
    const result = await writeBinding(ws, "memo", { mode: "keep" });
    expect(result.switched).toBe(true);
    expect(result.keptSessions?.sort()).toEqual(["t-1", "t-2"]);

    // 会话索引原样保留
    const index = JSON.parse(await fs.readFile(workspaceSessionIndexPath(ws), "utf8")) as {
      sessions: Array<{ id: string }>;
    };
    expect(index.sessions.map((s) => s.id).sort()).toEqual(["t-1", "t-2"]);

    // 标注了创建时所属 agent
    const owners = await readSessionOwners(ws);
    expect(owners["t-1"]).toBe("writer");
    expect(owners["t-2"]).toBe("writer");

    const binding = await readBinding(ws);
    expect(binding?.agentId).toBe("memo");
    expect(binding?.lastAgentSwitch?.from).toBe("writer");
    expect(binding?.lastAgentSwitch?.mode).toBe("keep");
  });

  test("archive：历史整体转入归档区且仍可查看", async () => {
    const ws = await freshWorkspace("switch-archive");
    await fs.mkdir(workspaceAppDataDir(ws), { recursive: true });
    await fs.writeFile(
      workspaceSessionIndexPath(ws),
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), sessions: [{ id: "old-1" }] }),
      "utf8",
    );
    await writeBinding(ws, "writer");
    const result = await writeBinding(ws, "memo", { mode: "archive" });
    expect(result.archivedSessions).toEqual(["old-1"]);

    const archiveDir = path.join(workspaceAppDataDir(ws), "archive", "writer");
    const archived = JSON.parse(await fs.readFile(path.join(archiveDir, "sessions.json"), "utf8")) as {
      sessions: Array<{ id: string }>;
    };
    expect(archived.sessions.map((s) => s.id)).toEqual(["old-1"]);
    const manifest = JSON.parse(await fs.readFile(path.join(archiveDir, "manifest.json"), "utf8")) as {
      agentId: string;
      threadIds: string[];
    };
    expect(manifest.agentId).toBe("writer");
    expect(manifest.threadIds).toEqual(["old-1"]);

    // 工作区当前列表已清空
    const current = JSON.parse(await fs.readFile(workspaceSessionIndexPath(ws), "utf8")) as {
      sessions: unknown[];
    };
    expect(current.sessions).toEqual([]);
  });

  test("换绑后新会话归属新 agent（运行期自动标注）", async () => {
    const ws = await freshWorkspace("switch-new");
    await writeBinding(ws, "writer");
    const first = makeAgentGraph(ws, [new AIMessage("ok")]);
    await first.graph.invoke(
      { messages: [userMessage("hi")] },
      { configurable: { workspace: ws, thread_id: "thread-before" } },
    );
    let owners = await readSessionOwners(ws);
    expect(owners["thread-before"]).toBe("writer");

    await writeBinding(ws, "memo", { mode: "keep" });
    const second = makeAgentGraph(ws, [new AIMessage("ok")]);
    await second.graph.invoke(
      { messages: [userMessage("hi")] },
      { configurable: { workspace: ws, thread_id: "thread-after" } },
    );
    owners = await readSessionOwners(ws);
    expect(owners["thread-before"]).toBe("writer");
    expect(owners["thread-after"]).toBe("memo");
  });
});

describe("1.12 运行身份以绑定为准（工具白名单不被绕过）", () => {
  test("客户端传入不一致的 agent_id → 仍走绑定 agent 的白名单", async () => {
    // writer：todos 关掉；memo：todos 开着
    await updateAgent("writer", { config: { tools: { todos: false } } });
    await updateAgent("memo", { config: { tools: { todos: true } } });

    const ws = await freshWorkspace("identity");
    await writeBinding(ws, "writer");

    const { graph, model } = makeAgentGraph(ws, [
      toolCall("todo_create", { content: "绕过白名单", status: "pending" }),
      new AIMessage("done"),
    ]);
    const result = await graph.invoke(
      { messages: [userMessage("建个待办")] },
      // 前端试图冒充 memo（todos 开着）
      { configurable: { workspace: ws, agent_id: "memo" } },
    );
    const toolMessages = (result as { messages: unknown[] }).messages.filter((m) =>
      ToolMessage.isInstance(m),
    ) as ToolMessage[];
    expect(String(toolMessages[0]!.content)).toContain("TOOL_NOT_ALLOWED");
    // 工具确实没执行：todos.json 没有被创建
    expect(await fs.stat(path.join(ws, "todos.json")).catch(() => null)).toBe(null);
    // 系统提示词里也是 writer 的人设（默认内置内容），不是 memo 的
    const sys = (model.calls[0]![0] as SystemMessage).text;
    expect(sys).toContain("我是谁");
    expect(sys).not.toContain("Beta");
  });
});

describe("1.4 默认 agent 播种", () => {
  test("根目录为空时自动播种 xiaozhu（小助）", async () => {
    const emptyRoot = path.join(root, "seed-root");
    const prev = process.env[AGENTS_ROOT_ENV];
    process.env[AGENTS_ROOT_ENV] = emptyRoot;
    try {
      const listed = await listAgents();
      expect(listed.agents.map((a) => a.id)).toContain(DEFAULT_AGENT_ID);
      expect(listed.agents.find((a) => a.id === DEFAULT_AGENT_ID)?.name).toBe("小助");
      const def = await readAgent(DEFAULT_AGENT_ID);
      expect(def.persona.length).toBeGreaterThan(50);
    } finally {
      process.env[AGENTS_ROOT_ENV] = prev;
    }
  });
});