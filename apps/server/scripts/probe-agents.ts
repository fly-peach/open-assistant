/**
 * 探针：Agent 注册表与绑定（tasks 1.1–1.12）的真实运行验证。
 *
 * 覆盖两层：
 * - HTTP 层：直接打 dev server 的 `/agents*` 与 `/workspace/binding`（与前端同一份契约）
 * - 会话层：**真实模型**跑多轮，断言
 *   ① 1.6 两个 agent 先后运行，各自只体现自己的人设（互不污染）
 *   ② 1.7 人设三档（agent / 工作区 / 内置）自我介绍不同
 *   ③ 1.8 在 A 工作区写入的长期记忆，在 B 工作区能答出来
 *   ④ 1.10 未绑定的工作区 run 被拒且错误可读
 *   ⑤ 1.12 客户端传入与绑定不一致的 agent_id → 仍走绑定 agent，工具白名单不被绕过
 *
 * 用法：bun run scripts/probe-agents.ts
 * （dev server 挂掉时可在 apps/server 下执行 `bun run dev --no-browser`）
 */
import { Client } from "@langchain/langgraph-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agent } from "../src/agent.js";
import { getAgentsRoot } from "../src/agents/root.js";

const API_URL = process.env.LANGGRAPH_API_URL ?? "http://localhost:2024";
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "assistant";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures += 1;
}

const q = (p: string) => encodeURIComponent(p);
const createdAgents: string[] = [];
const createdWorkspaces: string[] = [];

async function api<T>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}${url}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function makeAgent(id: string, name: string, persona?: string, config?: Record<string, unknown>): Promise<string> {
  const created = await api<{ id?: string; error?: string }>("POST", "/agents", { id, name });
  if (created.status === 200) createdAgents.push(id);
  else if (created.status !== 409) {
    throw new Error(`创建 agent ${id} 失败: ${JSON.stringify(created.body)}`);
  }
  if (persona !== undefined) {
    await api("PATCH", `/agents/${id}`, { persona });
  }
  if (config !== undefined) {
    await api("PATCH", `/agents/${id}`, { config });
  }
  return id;
}

async function makeWorkspace(name: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `oa-${name}-`)));
  createdWorkspaces.push(dir);
  return dir;
}

async function bind(workspace: string, agentId: string, mode: "keep" | "archive" = "keep") {
  const res = await api<{ agentId?: string; error?: string; message?: string }>(
    "PUT",
    "/workspace/binding",
    { path: workspace, agentId, mode },
  );
  if (res.status !== 200) throw new Error(`绑定失败: ${JSON.stringify(res.body)}`);
  return res.body;
}

// —— 会话通道：优先 dev server，命中项目既有流式问题时回退进程内 invoke ——

let mode: "server" | "in-process" = "server";
const client = new Client({ apiUrl: API_URL });

function messageType(m: unknown): string {
  const o = m as { getType?: () => string; type?: string };
  return typeof o?.getType === "function" ? o.getType() : String(o?.type ?? "");
}

function messageText(m: unknown): string {
  const content = (m as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : String((b as { text?: string })?.text ?? "")))
      .join("");
  }
  return "";
}

function lastAiText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messageType(messages[i]) !== "ai") continue;
    return messageText(messages[i]);
  }
  return "";
}

const histories = new Map<string, unknown[]>();

async function ask(workspace: string, text: string, agentId?: string): Promise<{ reply: string; channel: string }> {
  const configurable: Record<string, unknown> = { workspace };
  if (agentId) configurable["agent_id"] = agentId;
  if (mode === "server") {
    try {
      const thread = await client.threads.create();
      await client.runs.wait(thread.thread_id, ASSISTANT_ID, {
        input: { messages: [{ type: "human", content: text }] },
        config: { configurable },
      });
      const state = (await client.threads.getState(thread.thread_id)) as {
        values?: { messages?: unknown[] };
      };
      return { reply: lastAiText(state.values?.messages ?? []), channel: "server" };
    } catch (err) {
      const msg = (err as Error).message;
      if (!/patchToolCalls|got object/i.test(msg)) throw err;
      console.log(`      (dev server 命中既有流式问题，本轮回退进程内 invoke：${msg.slice(0, 70)}…)`);
      mode = "in-process";
    }
  }
  const key = `${workspace}::${agentId ?? ""}`;
  const history = [...(histories.get(key) ?? []), { role: "user", content: text }];
  const runConfig = { configurable: { ...configurable, thread_id: `probe-agents-${Buffer.from(key).toString("hex").slice(0, 12)}` } };
  // 图出口是工厂函数：先按当次 config 建图，再 invoke（见 src/agent.ts 文件头）
  const graph = await agent(runConfig);
  const result = await graph.invoke(
    { messages: history },
    { configurable: { ...configurable, thread_id: `probe-agents-${Buffer.from(key).toString("hex").slice(0, 12)}` } },
  );
  const messages = (result as { messages: unknown[] }).messages;
  histories.set(key, messages);
  return { reply: lastAiText(messages), channel: "in-process" };
}

const INTRO = "请用一句话介绍你自己：你是谁、你的定位是什么。不要调用任何工具，不要解释。";

// —— HTTP 层：注册表契约 ——

console.log(`agents 根（server 侧）: ${getAgentsRoot()}\n`);

{
  const listed = await api<{ root: string; agents: Array<{ id: string; name: string; valid: boolean }> }>(
    "GET",
    "/agents",
  );
  check("GET /agents 返回 root 与 agents 列表", listed.status === 200 && typeof listed.body.root === "string");
}

// 1.2 / 1.3：创建 + 标识校验
{
  await makeAgent("probe-alpha", "阿尔法");
  const bad = await api<{ error?: string }>("POST", "/agents", { id: "probe/evil" });
  check("1.3 非法标识被拒（AGENT_INVALID_ID）", bad.status === 400 && bad.body.error === "AGENT_INVALID_ID", JSON.stringify(bad.body));
  const dup = await api<{ error?: string }>("POST", "/agents", { id: "probe-alpha" });
  check("1.3 重名被拒（AGENT_ALREADY_EXISTS）", dup.status === 409 && dup.body.error === "AGENT_ALREADY_EXISTS");
  const dir = path.join(getAgentsRoot(), "probe-alpha");
  const entries = (await fs.readdir(dir)).sort();
  check(
    "1.2 目录骨架含 AGENTS.md / config.json / memory.md / skills/",
    ["AGENTS.md", "config.json", "memory.md", "skills"].every((n) => entries.includes(n)),
    JSON.stringify(entries),
  );
}

// 1.4：残缺 agent 被标注
{
  const brokenDir = path.join(getAgentsRoot(), "probe-broken");
  await fs.mkdir(brokenDir, { recursive: true });
  await fs.writeFile(path.join(brokenDir, "config.json"), "{ not json", "utf8");
  createdAgents.push("probe-broken");
  const listed = await api<{ agents: Array<{ id: string; valid: boolean; issues?: string[] }> }>("GET", "/agents");
  const broken = listed.body.agents.find((a) => a.id === "probe-broken");
  check(
    "1.4 残缺 agent 被标注而非整体失败",
    listed.status === 200 && broken?.valid === false && (broken.issues?.length ?? 0) > 0,
    JSON.stringify(broken?.issues),
  );
}

// 1.5：配置合法/非法
{
  const ok = await api<{ id?: string }>("PATCH", "/agents/probe-alpha", { config: { approval: "strict" } });
  const bad = await api<{ error?: string; field?: string }>("PATCH", "/agents/probe-alpha", {
    config: { approval: "sometimes" },
  });
  check("1.5 合法配置被接受", ok.status === 200 && ok.body.id === "probe-alpha");
  check("1.5 非法审批级别被拒且指出字段", bad.status === 400 && bad.body.error === "AGENT_INVALID_CONFIG", JSON.stringify(bad.body));
}

// —— 真实运行：1.6 / 1.7 / 1.8 / 1.12 ——

const AGENT_A = await makeAgent(
  "probe-alpha",
  "阿尔法",
  "# 你是谁\n你是阿尔法（Alpha），一个专门负责甲项目的助手。说到自己时只说阿尔法。",
);
const AGENT_B = await makeAgent(
  "probe-beta",
  "贝塔",
  "# 你是谁\n你是贝塔（Beta），一个专门负责乙项目的助手。说到自己时只说贝塔。",
);
const AGENT_EMPTY = await makeAgent("probe-empty", "空白");
await fs.rm(path.join(getAgentsRoot(), "probe-empty", "AGENTS.md"), { force: true });

// —— 1.6 两个 agent 互不污染 ——
{
  const wsA = await makeWorkspace("alpha-ws");
  const wsB = await makeWorkspace("beta-ws");
  await bind(wsA, AGENT_A);
  await bind(wsB, AGENT_B);

  const a = await ask(wsA, INTRO);
  const b = await ask(wsB, INTRO);
  check(
    "1.6 agent A 只体现自己的人设",
    a.reply.includes("阿尔法") && !a.reply.includes("贝塔"),
    `${a.channel} / ${a.reply.slice(0, 90).replace(/\n/g, " ")}`,
  );
  check(
    "1.6 agent B 只体现自己的人设（与 A 不互相污染）",
    b.reply.includes("贝塔") && !b.reply.includes("阿尔法"),
    `${b.channel} / ${b.reply.slice(0, 90).replace(/\n/g, " ")}`,
  );
}

// —— 1.7 人设三档 ——
{
  const wsTier1 = await makeWorkspace("tier1-ws");
  await bind(wsTier1, AGENT_A);
  const tier1 = await ask(wsTier1, INTRO);

  const wsTier2 = await makeWorkspace("tier2-ws");
  await fs.writeFile(
    path.join(wsTier2, "AGENTS.md"),
    "# 你是谁\n你是伽玛（Gamma），一个专门负责丙项目的助手。说到自己时只说伽玛。\n",
    "utf8",
  );
  await bind(wsTier2, AGENT_EMPTY);
  const tier2 = await ask(wsTier2, INTRO);

  const wsTier3 = await makeWorkspace("tier3-ws");
  await bind(wsTier3, AGENT_EMPTY);
  const tier3 = await ask(wsTier3, INTRO);

  check("1.7 第一档 agent 人设生效", tier1.reply.includes("阿尔法"), tier1.reply.slice(0, 80).replace(/\n/g, " "));
  check("1.7 第二档工作区人设生效（过渡回退）", tier2.reply.includes("伽玛"), tier2.reply.slice(0, 80).replace(/\n/g, " "));
  check(
    "1.7 第三档回退内置默认人设",
    !tier3.reply.includes("阿尔法") && !tier3.reply.includes("伽玛") && /助手/.test(tier3.reply),
    tier3.reply.slice(0, 80).replace(/\n/g, " "),
  );
  check(
    "1.7 三档自我介绍互不相同",
    new Set([tier1.reply, tier2.reply, tier3.reply]).size === 3,
  );
}

// —— 1.8 记忆跨工作区共享 ——
{
  await api("PUT", `/agents/${AGENT_A}/memory`, { content: "- 用户的名字叫阿明，喜欢先看结论。" });
  const wsMemoB = await makeWorkspace("memo-ws");
  await bind(wsMemoB, AGENT_A);
  const reply = await ask(wsMemoB, "我叫什么名字？只回答名字。不要调用工具。");
  check(
    "1.8 在 agent 记忆里写下的偏好，在另一个工作区被读到",
    reply.reply.includes("阿明"),
    reply.reply.slice(0, 100).replace(/\n/g, " "),
  );
}

// —— 1.9 / 1.11 绑定与换绑（HTTP 层）——
{
  const ws = await makeWorkspace("bind-ws");
  await bind(ws, AGENT_A, "keep");
  const projectFile = path.join(ws, ".open-assistant", "project.json");
  const raw = JSON.parse(await fs.readFile(projectFile, "utf8")) as { agentId: string };
  check("1.9 绑定写在 <ws>/.open-assistant/project.json", raw.agentId === AGENT_A, projectFile);

  // 造一条历史会话索引，验证换绑处置
  const indexFile = path.join(ws, ".open-assistant", "sessions.json");
  await fs.writeFile(
    indexFile,
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), sessions: [{ id: "probe-old" }] }),
    "utf8",
  );
  await bind(ws, AGENT_B, "keep");
  const owners = JSON.parse(await fs.readFile(path.join(ws, ".open-assistant", "sessions-agents.json"), "utf8")) as {
    owners: Record<string, string>;
  };
  const binding = JSON.parse(await fs.readFile(projectFile, "utf8")) as {
    agentId: string;
    lastAgentSwitch?: { from: string; mode: string };
  };
  check(
    "1.11 keep：历史保留 + 标注创建时所属 agent",
    owners.owners["probe-old"] === AGENT_A && binding.lastAgentSwitch?.from === AGENT_A,
    JSON.stringify(binding.lastAgentSwitch),
  );

  const wsArchive = await makeWorkspace("archive-ws");
  await bind(wsArchive, AGENT_A, "keep");
  await fs.writeFile(
    path.join(wsArchive, ".open-assistant", "sessions.json"),
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), sessions: [{ id: "probe-arch" }] }),
    "utf8",
  );
  await bind(wsArchive, AGENT_B, "archive");
  const archived = await fs
    .readFile(path.join(wsArchive, ".open-assistant", "archive", AGENT_A, "sessions.json"), "utf8")
    .catch(() => "");
  check("1.11 archive：历史整体转入归档区且仍可查看", archived.includes("probe-arch"));
  const view = await api<{ agentId: string | null }>(
    "GET",
    `/workspace/binding?path=${q(wsArchive)}`,
  );
  check("1.11 换绑后可读回新绑定", view.body.agentId === AGENT_B, JSON.stringify(view.body));
}

// —— 1.12 运行身份以绑定为准（工具白名单不被绕过）——
{
  await api("PATCH", `/agents/${AGENT_A}`, { config: { tools: { todos: false } } });
  await api("PATCH", `/agents/${AGENT_B}`, { config: { tools: { todos: true } } });
  const PROMPT = "请用 todo_create 工具新建待办「绕过白名单」，然后只回复 done。";

  const wsBoundA = await makeWorkspace("identity-a-ws");
  await bind(wsBoundA, AGENT_A);
  const spoofed = await ask(wsBoundA, PROMPT, AGENT_B); // 冒充 B（todos 开着）
  const todosA = await fs.stat(path.join(wsBoundA, "todos.json")).catch(() => null);
  check(
    "1.12 传入与绑定不一致的 agent_id → 仍走绑定 agent，todos.json 未被创建",
    todosA === null,
    `channel=${spoofed.channel} / ${spoofed.reply.slice(0, 110).replace(/\n/g, " ")}`,
  );

  const wsBoundB = await makeWorkspace("identity-b-ws");
  await bind(wsBoundB, AGENT_B);
  const legit = await ask(wsBoundB, PROMPT, AGENT_A); // 绑定 B，传 A（同样不采信）
  const todosB = await fs.readFile(path.join(wsBoundB, "todos.json"), "utf8").catch(() => "");
  check(
    "1.12 对照组：绑定 B（todos 开着）时同一请求确实建出了待办",
    todosB.includes("绕过白名单"),
    `channel=${legit.channel} / ${legit.reply.slice(0, 80).replace(/\n/g, " ")}`,
  );
}

// —— 1.10 未绑定不得对话 ——
{
  const ws = await makeWorkspace("unbound-ws");
  const err = await ask(ws, "你好")
    .then(() => null)
    .catch((e) => e as Error);
  check(
    "1.10 未绑定工作区 run 被拒且错误可读",
    err !== null && /未绑定/.test(err.message),
    (err?.message ?? "没有报错（不该发生）").slice(0, 140).replace(/\n/g, " "),
  );
}

console.log(failures === 0 ? "\nAGENTS PROBE PASS" : `\nAGENTS PROBE ${failures} FAILED`);
if (process.env.KEEP_PROBE_WS !== "1") {
  for (const ws of createdWorkspaces) await fs.rm(ws, { recursive: true, force: true });
  for (const id of createdAgents) await api("DELETE", `/agents/${id}`);
}
process.exit(failures === 0 ? 0 : 1);