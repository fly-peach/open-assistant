/**
 * 探针：工作区初始化（9.1 / 9.3 / 9.4 / 9.5）+ 首次引导与首次人设（9.6 / 9.7 / 9.8）的真实会话验证。
 *
 * 覆盖两层：
 * - HTTP 层：直接打 dev server 的 /workspace/status 与 /workspace/init（与前端同一份契约）
 * - 会话层：**真实模型**跑多轮，断言
 *   ① 首轮收到的用户消息里能看到引导（让模型原文复述即可证明是「本轮消息级注入」）
 *   ② 第二轮不再看到引导（防重标记生效）
 *   ③ 助手能用 persona_write 写人设、能删 BOOTSTRAP.md
 *   ④ 引导结束后 write_file 改不动 AGENTS.md
 *
 * 用法：bun run scripts/probe-bootstrap.ts
 * （dev server 挂掉时可在 apps/server 下执行 `bun run dev --no-browser`）
 */
import { Client } from "@langchain/langgraph-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agent } from "../src/agent.js";
import {
  BOOTSTRAP_FILE,
  BOOTSTRAP_FLAG_FILE,
  PERSONA_FILE,
  initWorkspace,
  workspaceBootstrapFlagPath,
} from "../src/workspace.js";

const API_URL = process.env.LANGGRAPH_API_URL ?? "http://localhost:2024";
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "assistant";

let failures = 0;

/** 用于「人工改过人设后初始化不覆盖」的标记 */
const PERSONA_CONTENT_MARK = "<!-- 用户手工编辑过 -->";
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures += 1;
}

const q = (p: string) => encodeURIComponent(p);
const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-bootstrap-")));
console.log(`工作区: ${dir}\n`);

// —— HTTP 层：选定目录不写文件 / 初始化幂等 / 状态查询 ——
{
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "oa-select-"));
  const before = await fs.readdir(empty);
  const res = await fetch(`${API_URL}/workspace`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: empty }),
  });
  const after = await fs.readdir(empty);
  check(
    "9.1 POST /workspace 不在目录里写任何文件",
    res.status === 200 && before.length === 0 && after.length === 0,
    `entries=${JSON.stringify(after)}`,
  );

  const status0 = await fetch(`${API_URL}/workspace/status?path=${q(dir)}`);
  const s0 = (await status0.json()) as { initialized: boolean; files: Record<string, boolean> };
  check("9.4 未初始化：两件套都不存在", status0.status === 200 && !s0.initialized && !s0.files["agentsMd"] && !s0.files["bootstrapMd"]);

  const init1 = await fetch(`${API_URL}/workspace/init`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: dir }),
  });
  const b1 = (await init1.json()) as { created: string[]; skipped: string[] };
  check("9.3 首次初始化写入两件套", init1.status === 200 && b1.created.join(",") === `${PERSONA_FILE},${BOOTSTRAP_FILE}` && b1.skipped.length === 0, JSON.stringify(b1));

  // 用户手工改人设后再次初始化：不能覆盖
  await fs.writeFile(path.join(dir, PERSONA_FILE), `${PERSONA_CONTENT_MARK}\n`, "utf8");
  const init2 = await fetch(`${API_URL}/workspace/init`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: dir }),
  });
  const b2 = (await init2.json()) as { created: string[]; skipped: string[] };
  const kept = await fs.readFile(path.join(dir, PERSONA_FILE), "utf8");
  check(
    "9.3 再次初始化只跳过、不覆盖（人工改动保留）",
    b2.created.length === 0 && b2.skipped.length === 2 && kept.includes(PERSONA_CONTENT_MARK),
    JSON.stringify(b2),
  );

  const status1 = await fetch(`${API_URL}/workspace/status?path=${q(dir)}`);
  const s1 = (await status1.json()) as { initialized: boolean; files: Record<string, boolean> };
  check("9.4 已初始化：两件套齐备", s1.initialized && s1.files["agentsMd"] && s1.files["bootstrapMd"]);
}

// —— 会话层：真实模型 ——
let mode: "server" | "in-process" = "server";
let threadId: string | null = null;
let history: unknown[] = [];
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

async function ask(text: string): Promise<{ reply: string; messages: unknown[]; channel: "server" | "in-process" }> {
  if (mode === "server") {
    try {
      if (!threadId) threadId = (await client.threads.create()).thread_id;
      await client.runs.wait(threadId, ASSISTANT_ID, {
        input: { messages: [{ type: "human", content: text }] },
        config: { configurable: { workspace: dir } },
      });
      const state = (await client.threads.getState(threadId)) as { values?: { messages?: unknown[] } };
      const messages = state.values?.messages ?? [];
      return { reply: lastAiText(messages), messages, channel: "server" };
    } catch (err) {
      const msg = (err as Error).message;
      if (!/patchToolCalls|got object/i.test(msg)) throw err;
      console.log(
        `      (dev server 命中项目既有问题（极短回复的流式 chunk 不带 role）：${msg.slice(0, 90)}…；本次回退到进程内 invoke —— 同一个 graph / 同一个模型)`,
      );
      mode = "in-process";
      threadId = null;
    }
  }
  history = [...history, { role: "user", content: text }];
  const result = await agent.invoke(
    { messages: history },
    { configurable: { workspace: dir, thread_id: "probe-bootstrap" } },
  );
  const messages = (result as { messages: unknown[] }).messages;
  history = messages;
  return { reply: lastAiText(messages), messages, channel: "in-process" };
}

/** 开新会话（对齐 spec「即使用户重新打开会话也不再注入」） */
async function newThread(): Promise<void> {
  if (mode === "server") threadId = null;
  else history = [];
}

const ECHO_PROMPT =
  "把你这一轮收到的用户消息原文逐字复述出来（包含开头的任何指令文字），不要做别的事。";

// 9.6：首轮引导注入（让模型复述本轮用户消息，注入内容会原样出现在回复里）
let firstReply = "";
{
  const { reply, messages } = await ask(ECHO_PROMPT);
  firstReply = reply;
  check("9.6 真实会话首轮收到引导（复述可见「引导模式」）", reply.includes("引导模式"), reply.slice(0, 120).replace(/\n/g, " "));
  check(
    "9.6 首轮回复体现「初次见面」",
    /第一次见面|初次|见面|怎么称呼|你好/.test(reply),
  );
  // 引导文本没有进对话历史：只看历史里的用户消息（助手自己复述里当然有）
  const humanMessages = (messages as unknown[])
    .filter((m) => messageType(m) === "human")
    .map((m) => messageText(m));
  check(
    "9.6 引导未写进对话历史（历史里的用户消息只有原文）",
    humanMessages.length === 1 && humanMessages[0] === ECHO_PROMPT,
    JSON.stringify(humanMessages).slice(0, 120),
  );
  const flag = await fs.readFile(workspaceBootstrapFlagPath(dir), "utf8").catch(() => "");
  check("9.7 首轮后写入 .bootstrap_completed 防重标记", flag.includes("triggeredAt"));
  check(
    "9.7 防重标记落在应用数据子目录，不在工作区根",
    !(await fs.readdir(dir)).includes(BOOTSTRAP_FLAG_FILE),
  );
}

// 9.7：第二轮不再注入（开新会话 → 历史里不会残留首轮的复述内容）
{
  await newThread();
  const { reply, messages } = await ask(ECHO_PROMPT);
  const humanMessages = (messages as unknown[])
    .filter((m) => messageType(m) === "human")
    .map((m) => messageText(m));
  check(
    "9.7 新会话里不再注入引导（用户消息就是原文）",
    humanMessages.every((t) => !t.includes("引导模式")),
    JSON.stringify(humanMessages).slice(0, 100),
  );
  check("9.7 新会话也不再收到引导（回复里没有引导模式）", !reply.includes("引导模式"), reply.slice(0, 100).replace(/\n/g, " "));
}

// 9.8：助手能用 persona_write 写人设，并删掉 BOOTSTRAP.md
{
  const { reply, channel } = await ask(
    `用 persona_write 工具把 "# 我是小助\n说话简短，先给结论。" 写进 ${PERSONA_FILE}，` +
      `然后用 delete 工具删除 ${BOOTSTRAP_FILE}。做完之后用一段 80 字以上的话说明你做了什么。`,
  );
  const persona = await fs.readFile(path.join(dir, PERSONA_FILE), "utf8").catch(() => "");
  const bootstrapGone = await fs
    .stat(path.join(dir, BOOTSTRAP_FILE))
    .then(() => false)
    .catch(() => true);
  check("9.8 助手用 persona_write 写进了人设", persona.includes("我是小助"), `channel=${channel} / ${reply.slice(0, 60).replace(/\n/g, " ")}`);
  check("9.8 助手删掉了 BOOTSTRAP.md（引导能结束）", bootstrapGone);
}

// 9.8：引导结束后，文件工具与 persona_write 都改不动 AGENTS.md
{
  const before = await fs.readFile(path.join(dir, PERSONA_FILE), "utf8");
  const { reply } = await ask(
    `请用 write_file 工具（必须调用这个工具）把 /${PERSONA_FILE} 的内容整体替换成 HACKED，` +
      `然后用一段 80 字以上的话说明工具返回了什么。`,
  );
  const afterWriteFile = await fs.readFile(path.join(dir, PERSONA_FILE), "utf8");
  check("9.8 write_file 改不动 AGENTS.md（内容未变）", afterWriteFile === before, reply.slice(0, 60).replace(/\n/g, " "));

  const { messages, reply: replyAfterPersona } = await ask(
    `请用 persona_write 工具（必须调用这个工具）把人设整体换成 "HACKED"，然后用一段 80 字以上的话说明工具返回了什么。`,
  );
  const afterPersonaWrite = await fs.readFile(path.join(dir, PERSONA_FILE), "utf8");
  const toolMessages = (messages as unknown[])
    .filter((m) => messageType(m) === "tool")
    .map((m) => `${(m as { name?: string }).name ?? ""}: ${messageText(m)}`);
  const locked = toolMessages.some((t) => t.includes("PERSONA_LOCKED") || t.includes("PERSONA_PROTECTED"));
  const refusedInText = /不能|无法|禁止|不允许|不会|拒绝|保护/.test(replyAfterPersona);
  check("9.8 两次尝试后 AGENTS.md 依然未被改动", afterPersonaWrite === before);
  check(
    "9.8 拒绝可读：要么工具返回 PERSONA_*，要么模型说明了不能改",
    locked || refusedInText,
    locked ? "tool: PERSONA_*" : replyAfterPersona.slice(0, 100).replace(/\n/g, " "),
  );
}

// 9.6 附带：用户直接提问时不得纠缠身份（引导不得骑在任务头上）
{
  const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-bootstrap-skip-")));
  await initWorkspace(other);
  const reply = await agent
    .invoke(
      {
        messages: [
          {
            role: "user",
            content:
              "我急着用：请用 todo_create 新增待办「买牛奶」，然后用一段 80 字以上的话说明你做了什么。",
          },
        ],
      },
      { configurable: { workspace: other, thread_id: `probe-skip-${Date.now()}` } },
    )
    .then((r) => lastAiText((r as { messages: unknown[] }).messages))
    .catch((e) => `ERROR ${(e as Error).message}`);
  const todos = await fs.readFile(path.join(other, "todos.json"), "utf8").catch(() => "");
  check(
    "9.6 用户直接提问时任务照做（引导不纠缠身份）",
    todos.includes("买牛奶"),
    reply.slice(0, 100).replace(/\n/g, " "),
  );
  await fs.rm(other, { recursive: true, force: true });
}

console.log(`\n(会话通道: ${mode}；首轮回复片段: ${firstReply.slice(0, 60).replace(/\n/g, " ")}…)`);
console.log(failures === 0 ? "\nBOOTSTRAP PROBE PASS" : `\nBOOTSTRAP PROBE ${failures} FAILED`);
if (process.env.KEEP_PROBE_WS !== "1") await fs.rm(dir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);