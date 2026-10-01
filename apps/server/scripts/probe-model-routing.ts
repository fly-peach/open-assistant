/**
 * 探针：**模型路由真的生效了吗**（对话链路端到端）。
 *
 * 这是本项目里唯一能证明「选了模型 = 这一轮真的用它」的检查，所以不用 mock：
 *
 * 1. 起一个假上游，它只会说一个特征串（`pong-<随机数>`）；
 * 2. 建工作区 → 建 agent → 绑定 → 把该 agent 的模型选中为「假上游的模型」；
 * 3. 真跑一次对话（走 langgraph 的 threads/runs/stream，与前端完全同一条路）；
 * 4. 断言回复里出现那个特征串 —— 出现了，就说明 `modelMiddleware` 真的
 *    用配置解析出来的模型替换了建图时的占位模型；没出现就说明路由没生效。
 *
 * 用法：`bun run probe:routing`（需要 dev server 在跑；不需要任何真实 API Key）
 * 副作用：临时创建 `probe-routing` agent 与同名供应商，结束时删除。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const API_URL = process.env.LANGGRAPH_API_URL ?? "http://localhost:2024";
/** 图 id 来自 `langgraph.json` 的 `graphs`（本仓库是 `assistant`） */
const ASSISTANT_ID = process.env.PROBE_ASSISTANT_ID ?? "assistant";
const AGENT_ID = "probe-routing";
const PROVIDER_ID = "probe-routing";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures += 1;
}

const TOKEN = `pong-${Math.floor(Math.random() * 1e6)}`;
/** 假上游被调了几次：用来区分「没走路由」和「走了但响应格式不对」 */
let hits = 0;

/** 非流式响应体 */
function completionBody(): unknown {
  return {
    id: "chatcmpl-probe",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "probe-routing-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: TOKEN },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/**
 * 流式响应：LangChain 的 chat model 在流模式下要的是 SSE 分片。
 * 只给一个「整包 JSON」会让它解析出空内容（`Received empty response from chat model call.`），
 * 所以两种模式都得会 —— 不然探针会误报成「路由没生效」。
 */
function completionStream(): Response {
  const base = {
    id: "chatcmpl-probe",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "probe-routing-model",
  };
  const frames = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: TOKEN }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

const fake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      return Response.json({ data: [{ id: "probe-routing-model" }] });
    }
    const raw = await req.text();
    hits += 1;
    // 只回特征串：任何「真模型」（token-plan / deepseek / dashscope）都不可能说出它
    if (raw.includes('"stream":true')) return completionStream();
    return Response.json(completionBody());
  },
});
const FAKE_BASE = `http://127.0.0.1:${fake.port}/v1`;

const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-routing-")));
let agentCreated = false;
let providerCreated = false;

async function send(pathname: string, body: unknown, method = "POST") {
  return fetch(`${API_URL}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

try {
  console.log(`工作区：${workspace}\n假上游：${FAKE_BASE}（只会说 ${TOKEN}）\n`);

  const agent = await send("/agents", { id: AGENT_ID, name: "路由探针 agent" });
  const agentBody = (await agent.json()) as { id?: string };
  agentCreated = agent.status === 200;
  check("创建探针 agent", agentCreated && agentBody.id === AGENT_ID, `HTTP ${agent.status} → ${agentBody.id}`);

  const binding = await send(
    "/workspace/binding",
    { path: workspace, agentId: AGENT_ID, mode: "keep" },
    "PUT",
  );
  check("把工作区绑定到该 agent", binding.status === 200, `HTTP ${binding.status} ${await binding.text()}`);

  const provider = await send("/models/providers", {
    id: PROVIDER_ID,
    kind: "custom",
    name: "路由探针供应商",
    baseUrl: FAKE_BASE,
    apiKey: "sk-probe-routing",
    models: ["probe-routing-model"],
  });
  providerCreated = provider.status === 200;
  check("注册指向假上游的供应商", providerCreated, `HTTP ${provider.status}`);

  const selection = await send(
    "/models/selection",
    { path: workspace, providerId: PROVIDER_ID, modelId: "probe-routing-model" },
    "PUT",
  );
  const selectionBody = (await selection.json()) as {
    effective?: { modelId?: string; origin?: string; vision?: boolean | null };
  };
  check(
    "选中模型写进绑定 agent 的配置（origin=agent）",
    selection.status === 200 && selectionBody.effective?.origin === "agent",
    JSON.stringify(selectionBody.effective ?? {}),
  );

  // 真跑一次对话：和前端用同一条链路（assistant_id + configurable.workspace）
  const threadRes = await send("/threads", {});
  const thread = (await threadRes.json()) as { thread_id?: string };
  if (!thread.thread_id) throw new Error(`创建线程失败：HTTP ${threadRes.status}`);

  const runRes = await fetch(`${API_URL}/threads/${thread.thread_id}/runs/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      assistant_id: ASSISTANT_ID,
      input: { messages: [{ role: "user", content: "随便说一句，验证一下模型路由。" }] },
      config: { configurable: { workspace } },
      stream_mode: ["values"],
    }),
  });
  const stream = await runRes.text();
  check(
    "对话跑到结尾（SSE 有 values 事件）",
    runRes.status === 200 && stream.includes("event: values"),
    `HTTP ${runRes.status}`,
  );
  check(
    "回复里出现假上游的特征串 → 这一轮真的用了选中的模型",
    stream.includes(TOKEN),
    stream.includes(TOKEN)
      ? `找到 ${TOKEN}（假上游被调用 ${hits} 次）`
      : `假上游被调用 ${hits} 次；结尾片段：${stream.slice(-400).replace(/\s+/g, " ")}`,
  );
} finally {
  fake.stop(true);
  if (providerCreated) {
    await fetch(`${API_URL}/models/providers/${PROVIDER_ID}`, { method: "DELETE" }).catch(() => undefined);
  }
  if (agentCreated) {
    await fetch(`${API_URL}/agents/${AGENT_ID}`, { method: "DELETE" }).catch(() => undefined);
  }
  await fs.rm(workspace, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
