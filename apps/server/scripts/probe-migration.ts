/**
 * 探针：历史会话补写工作区归属（task 1.6，对齐 session-store / 会话可按工作区归属与检索）。
 * 工作区归属现在记录的是「工作区绝对路径」。
 * 用法：bun run scripts/probe-migration.ts
 */
import path from "node:path";
import { Client } from "@langchain/langgraph-sdk";
import { createAgentClient, migrateThreadsWithoutWorkspace, searchThreadsByWorkspace } from "../src/sessions.js";
import { ensureWorkspace, getDefaultWorkspacePath, getWorkspaceRoot } from "../src/workspace.js";

const client = new Client({ apiUrl: process.env.LANGGRAPH_API_URL ?? "http://localhost:2024" });

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures += 1;
}

const defaultPath = getDefaultWorkspacePath();
const otherPath = path.resolve(getWorkspaceRoot(), "other-ws");
await Promise.all([ensureWorkspace(defaultPath), ensureWorkspace(otherPath)]);

// 造一个「无归属」的历史 thread：先跑一轮真实会话产出历史（run 的 configurable.workspace
// 不会写入 thread metadata，所以该 thread 仍然无归属）。
const thread = await client.threads.create();
const marker = `历史消息-${Date.now()}`;
let historyOk = false;
for (let attempt = 1; attempt <= 3 && !historyOk; attempt++) {
  try {
    await client.runs.wait(thread.thread_id, "assistant", {
      input: { messages: [{ type: "human", content: `请记住这个标记：${marker}，只回复 ok` }] },
      config: { configurable: { workspace: defaultPath } },
    });
    historyOk = true;
  } catch (err) {
    console.log(`      (建历史 attempt ${attempt} 失败: ${(err as Error).message.slice(0, 100)})`);
  }
}

const before = await client.threads.getState(thread.thread_id);
const beforeMsgs = (before.values as { messages?: unknown[] }).messages ?? [];
const beforeCount = beforeMsgs.length;
check("1.6 迁移前该 thread 无 workspace 归属", (thread.metadata as Record<string, unknown>)?.workspace === undefined);
check("1.6 迁移前已有历史数据", beforeCount >= 1, `messages=${beforeCount}`);

const result = await migrateThreadsWithoutWorkspace(client, { defaultWorkspacePath: defaultPath });
console.log("      migration result:", JSON.stringify(result));
check("1.6 迁移执行且至少补写 1 条", result.migrated >= 1);

const updated = await client.threads.get(thread.thread_id);
check(
  "1.6 thread 获得默认工作区（绝对路径）归属",
  (updated.metadata as Record<string, unknown> | undefined)?.workspace === defaultPath,
);

const after = await client.threads.getState(thread.thread_id);
const afterCount = (after.values as { messages?: unknown[] }).messages?.length ?? 0;
check("1.6 历史数据未丢失（消息数不变）", afterCount === beforeCount, `before=${beforeCount} after=${afterCount}`);

// 按工作区检索：默认命中、其他不命中
const inDefault = await searchThreadsByWorkspace(client, defaultPath, { limit: 200 });
check("1.6 按默认工作区可检索到该会话", inDefault.some((t) => t.thread_id === thread.thread_id));

const inOther = await searchThreadsByWorkspace(client, otherPath, { limit: 200 });
check("1.6 按其他工作区检索不到该会话（不串台）", !inOther.some((t) => t.thread_id === thread.thread_id));

// 迁移幂等：再次执行不会重复补写该 thread
const again = await migrateThreadsWithoutWorkspace(client, { defaultWorkspacePath: defaultPath });
const stillDefault = await client.threads.get(thread.thread_id);
check(
  "1.6 迁移幂等（再次运行不改变归属）",
  (stillDefault.metadata as Record<string, unknown> | undefined)?.workspace === defaultPath &&
    again.failures.length === 0,
);

console.log(failures === 0 ? "\nMIGRATION PROBE PASS" : `\nMIGRATION PROBE ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);