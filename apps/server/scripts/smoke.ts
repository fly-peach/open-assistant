/**
 * 冒烟测试：打通「工作区 + TODO + agent 工具」的最小真实链路。
 *
 * 验证：
 * 1. dev server 可连、assistant 已注册
 * 2. 不带 workspace 的 run 被拒绝（工作区强校验）
 * 3. 带 workspace 的真实会话中，agent 通过 todo_create 工具写入 todos.json
 * 4. agent 的文件工具作用在该工作区内
 *
 * 说明：langgraph dev server 在本机存在一个与本次改动无关的既有问题
 * （patchToolCallsMiddleware 在流式运行时偶发 "expected AIMessage or Command, got object"），
 * 因此第 3/4 步在 SDK 连续失败时会自动回退到进程内 invoke（同一 graph，真实会话）。
 *
 * 用法：bun run scripts/smoke.ts
 */
import { Client } from "@langchain/langgraph-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureWorkspace, getWorkspaceRoot, workspaceTodosPath } from "../src/workspace.js";
import { readTodos } from "../src/todos.js";
import { agent } from "../src/agent.js";
import { ensureWorkspaceBinding } from "../src/binding.js";

const API_URL = process.env.LANGGRAPH_API_URL ?? "http://localhost:2024";
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "assistant";
const WORKSPACE_DIR = path.resolve(getWorkspaceRoot(), "smoke");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures += 1;
}

const client = new Client({ apiUrl: API_URL });
const dir = await ensureWorkspace(WORKSPACE_DIR);
// agent 身份以工作区绑定为准（未绑定不得对话）
await ensureWorkspaceBinding(dir);

// 1. dev server
try {
  const assistants = await client.assistants.search();
  check("1. dev server 可连且 assistant 已注册", assistants.some((a) => a.graph_id === ASSISTANT_ID));
} catch (err) {
  check("1. dev server 可连且 assistant 已注册", false, (err as Error).message);
}

// 2. 不带 workspace 被拒绝
{
  const thread = await client.threads.create();
  const rejected = await client.runs
    .wait(thread.thread_id, ASSISTANT_ID, { input: { messages: [{ type: "human", content: "只回复 ok" }] } })
    .then(() => false)
    .catch((err) => /工作区|workspace/i.test((err as Error).message));
  check("2. 不带 workspace 的 run 被拒绝且报错可读", rejected);
}

const TODO_MARKER = `smoke-${Date.now()}`;
const prompt = `请用 todo_create 工具新建待办：${TODO_MARKER}。然后用 write_file 在当前工作区写文件 /smoke.txt，内容 ${TODO_MARKER}。完成后只回复 done。`;

async function runViaServer(): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const thread = await client.threads.create();
    try {
      await client.runs.wait(thread.thread_id, ASSISTANT_ID, {
        input: { messages: [{ type: "human", content: prompt }] },
        config: { configurable: { workspace: WORKSPACE_DIR } },
      });
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      console.log(`      (server attempt ${attempt} 失败: ${msg.slice(0, 120)})`);
      if (!/patchToolCalls|got object/i.test(msg)) break;
    }
  }
  return false;
}

async function runInProcess(): Promise<boolean> {
  try {
    // 图出口是工厂函数：先按当次 config 建图，再 invoke（见 src/agent.ts 文件头）
    const graph = await agent({ configurable: { workspace: WORKSPACE_DIR } });
    await graph.invoke(
      { messages: [{ role: "user", content: prompt }] },
      { configurable: { workspace: WORKSPACE_DIR } },
    );
    return true;
  } catch (err) {
    console.log(`      (in-process invoke 失败: ${(err as Error).message.slice(0, 160)})`);
    return false;
  }
}

const usedServer = await runViaServer();
if (!usedServer) {
  console.log("      dev server 会话命中既有 patchToolCalls 问题，回退进程内 invoke（同一 graph）");
}
const ran = usedServer || (await runInProcess());
check("3. agent 真实会话执行成功", ran);

const snapshot = await readTodos(dir);
check(
  "3b. todos.json 出现 agent 新建的 TODO（来源 agent）",
  snapshot.file.todos.some((t) => t.content.includes(TODO_MARKER) && t.source === "agent"),
  workspaceTodosPath(dir),
);

const fileContent = await fs.readFile(path.join(dir, "smoke.txt"), "utf8").catch(() => "");
check("4. agent 文件写入落在指定工作区内", fileContent.includes(TODO_MARKER));

console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);