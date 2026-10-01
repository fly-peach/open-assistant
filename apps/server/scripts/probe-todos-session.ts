/**
 * 探针：真实会话中 agent 通过工具增 / 改 / 删 TODO（task 2.8）。
 * 进程内 invoke 同一 graph（langgraph dev 的 patchToolCalls 既有问题不影响本探针）。
 * 用法：bun run scripts/probe-todos-session.ts
 */
import { agent } from "../src/agent.js";
import { ensureWorkspaceBinding } from "../src/binding.js";
import { ensureWorkspace, getWorkspaceRoot } from "../src/workspace.js";
import { readTodos } from "../src/todos.js";
import path from "node:path";

const WS = path.resolve(getWorkspaceRoot(), "todos-session");
const dir = await ensureWorkspace(WS);
// agent 身份以工作区绑定为准（未绑定不得对话）
await ensureWorkspaceBinding(dir);
const marker = `session-${Date.now()}`;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures += 1;
}

async function session(content: string) {
  // 图出口是工厂函数：先按当次 config 建图，再 invoke（见 src/agent.ts 文件头）
  const graph = await agent({ configurable: { workspace: WS } });
  const result: any = await graph.invoke(
    { messages: [{ role: "user", content }] },
    { configurable: { workspace: WS } },
  );
  const last = [...(result.messages ?? [])].reverse().find((m: any) => m.type === "ai");
  return JSON.stringify(last?.content ?? "");
}

// 1) 新建
await session(`请用 todo_create 新建待办：${marker}。完成后只回复 done。`);
let snap = await readTodos(dir);
const created = snap.file.todos.find((t) => t.content.includes(marker));
check("2.8 todo_create 经真实会话落盘", !!created, JSON.stringify(snap.file.todos.map((t) => t.content)));
check("2.8 来源标记为 agent", created?.source === "agent");

// 2) 更新为 completed
if (created) {
  await session(`请用 todo_update 把 id 为 ${created.id} 的待办状态改为 completed。完成后只回复 done。`);
  snap = await readTodos(dir);
  const updated = snap.file.todos.find((t) => t.id === created.id);
  check("2.8 todo_update 经真实会话生效", updated?.status === "completed", `status=${updated?.status}`);

  // 3) 删除
  await session(`请用 todo_delete 删除 id 为 ${created.id} 的待办。完成后只回复 done。`);
  snap = await readTodos(dir);
  check("2.8 todo_delete 经真实会话生效", !snap.file.todos.some((t) => t.id === created.id));
}

console.log(failures === 0 ? "\nTODOS SESSION PROBE PASS" : `\nTODOS SESSION PROBE ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);