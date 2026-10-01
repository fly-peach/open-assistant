/**
 * 探针：工作区 HTTP 能力（tasks 8.5 / 8.8 / 8.12）+ TODO 乐观并发 409。
 * 工作区一律以绝对路径传参（不再有 :id）。
 * 用法：bun run scripts/probe-http.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ensureWorkspace, getWorkspaceRoot } from "../src/workspace.js";
import { readTodos } from "../src/todos.js";

const API_URL = process.env.LANGGRAPH_API_URL ?? "http://localhost:2024";
const WS = path.resolve(getWorkspaceRoot(), "http-probe");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures += 1;
}

const dir = await ensureWorkspace(WS);
await fs.mkdir(path.join(dir, "notes"), { recursive: true });
await fs.writeFile(path.join(dir, "notes", "a.md"), "# hi", "utf8");
await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
await fs.mkdir(path.join(dir, ".git"), { recursive: true });
await fs.writeFile(path.join(dir, "top.txt"), "top", "utf8");

const q = (p: string) => encodeURIComponent(p);

// 8.5 目录浏览：无参列根、给定路径列子目录
{
  const roots = await fetch(`${API_URL}/fs/list`);
  const rootBody = (await roots.json()) as { roots?: string[] };
  check("8.5 GET /fs/list 返回磁盘/根", roots.status === 200 && (rootBody.roots?.length ?? 0) > 0);

  const listed = await fetch(`${API_URL}/fs/list?path=${q(dir)}`);
  const listedBody = (await listed.json()) as { entries: Array<{ name: string }> };
  const names = listedBody.entries.map((e) => e.name);
  check("8.5 只列目录（跳过文件）", !names.includes("top.txt") && names.includes("notes"));
}

// 8.8 工作区 tree / file（路径参数）
{
  const res = await fetch(`${API_URL}/workspace/tree?path=${q(WS)}&rel=${q("/")}`);
  const body = (await res.json()) as { workspace: string; entries: Array<{ name: string; type: string; path: string }> };
  check("8.8 GET tree 返回 200 且 workspace 为归一化路径", res.status === 200 && body.workspace === (await fs.realpath(WS)));
  const treeNames = body.entries.map((e) => e.name);
  check("8.8 目录优先", body.entries[0]?.type === "directory" && body.entries[0]?.name === "notes");
  check("8.8 跳过隐藏与 node_modules", !treeNames.includes("node_modules") && !treeNames.includes(".git"));
  check("8.8 一层列举（不递归）", treeNames.includes("notes") && treeNames.includes("top.txt"));

  const fileRes = await fetch(`${API_URL}/workspace/file?path=${q(WS)}&rel=${q("/notes/a.md")}`);
  const fileBody = (await fileRes.json()) as { content: string };
  check("8.8 GET file 返回内容", fileRes.status === 200 && fileBody.content === "# hi");

  const escapeRes = await fetch(`${API_URL}/workspace/file?path=${q(WS)}&rel=${q("../AGENTS.md")}`);
  check("8.8 工作区外路径被拒绝", escapeRes.status >= 400, `status=${escapeRes.status}`);
}

// 8.1/8.2/8.3 POST /workspace
{
  const newDir = path.resolve(getWorkspaceRoot(), "http-probe-new");
  await fs.rm(newDir, { recursive: true, force: true });
  const res = await fetch(`${API_URL}/workspace`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: newDir }),
  });
  const body = (await res.json()) as { path?: string; error?: string };
  check("8.1 POST /workspace 创建并返回绝对路径", res.status === 200 && body.path === (await fs.realpath(newDir)), body.error ?? "");

  const rel = await fetch(`${API_URL}/workspace`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "relative/dir" }),
  });
  const relBody = (await rel.json()) as { error?: string };
  check("8.1 相对路径被拒绝", rel.status === 400 && relBody.error === "WORKSPACE_INVALID_PATH");

  const rootPath = path.parse(process.cwd()).root;
  const atRoot = await fetch(`${API_URL}/workspace`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: rootPath }),
  });
  const atRootBody = (await atRoot.json()) as { error?: string };
  check("8.3 文件系统根被拒绝", atRoot.status === 400 && atRootBody.error === "WORKSPACE_FS_ROOT");
}

// 8.8 不存在的工作区
{
  const missing = path.resolve(getWorkspaceRoot(), "nope-xyz");
  const res = await fetch(`${API_URL}/workspace/tree?path=${q(missing)}&rel=${q("/")}`);
  const body = (await res.json()) as { error?: string };
  check("8.8 不存在的工作区 → 404 且报错可读", res.status === 404 && body.error === "WORKSPACE_MISSING");
}

// 8.12 旧 id 工作区：以路径直接打开，文件树正常
{
  const legacy = path.resolve(getWorkspaceRoot(), "default");
  await ensureWorkspace(legacy);
  const browsed = await fetch(`${API_URL}/fs/list?path=${q(getWorkspaceRoot())}`);
  const browsedBody = (await browsed.json()) as { entries: Array<{ name: string }> };
  check(
    "8.12 旧 .workspaces/<id> 可在目录浏览中被选用",
    browsedBody.entries.some((e) => e.name === "default"),
  );
  const tree = await fetch(`${API_URL}/workspace/tree?path=${q(legacy)}&rel=${q("/")}`);
  check("8.12 旧工作区以绝对路径打开、文件树正常", tree.status === 200);
}

// 2.4 乐观并发 409（HTTP 出口）
{
  const getRes = await fetch(`${API_URL}/workspace/todos?path=${q(WS)}`);
  const snap = (await getRes.json()) as { etag: string | null };
  const conflict = await fetch(`${API_URL}/workspace/todos?path=${q(WS)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), todos: [], expectedEtag: "deadbeef" }),
  });
  check("2.4 陈旧 etag → 409", conflict.status === 409);

  const todo = {
    id: "http-1",
    content: "HTTP 写入",
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: "user",
  };
  const okRes = await fetch(`${API_URL}/workspace/todos?path=${q(WS)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), todos: [todo], expectedEtag: snap.etag }),
  });
  check("2.4 正确 etag → 200", okRes.status === 200);
  const after = await readTodos(dir);
  check("2.4 写入生效且未丢失", after.file.todos.some((t) => t.id === "http-1"));

  await fs.writeFile(path.join(dir, "todos.json"), "{ bad", "utf8");
  const badRes = await fetch(`${API_URL}/workspace/todos?path=${q(WS)}`);
  const badBody = (await badRes.json()) as { error?: string };
  check("2.2 HTTP 读取非法 JSON → 报错", badRes.status === 422 && badBody.error === "TODO_INVALID_JSON");
  check("2.2 非法 JSON 未被覆盖", (await fs.readFile(path.join(dir, "todos.json"), "utf8")) === "{ bad");
}

console.log(failures === 0 ? "\nHTTP PROBE PASS" : `\nHTTP PROBE ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);