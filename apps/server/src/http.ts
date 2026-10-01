/**
 * 自定义 HTTP 入口（挂载进 langgraph dev server，走 `langgraph.json` 的 `http.app`）。
 *
 * 工作区一律以「绝对路径」传参（不再有 :id）：
 * - GET  /fs/list                          无 path → 列本机磁盘 / 根
 * - GET  /fs/list?path=<abs>               列出该目录下的子目录（只列目录）
 * - POST /workspace                        body { path, create? } → { path }（realpath 归一化，不写任何文件）
 * - GET  /workspace/status?path=<ws>       初始化状态（两件套各自是否存在）
 * - POST /workspace/init                   body { path } → { path, created, skipped }（幂等、不覆盖）
 * - GET  /workspace/tree?path=<ws>&rel=<r> 列举工作区内某目录一层
 * - GET  /workspace/file?path=<ws>&rel=<r> 读取工作区内某文件
 * - GET  /workspace/todos?path=<ws>        读取 todos.json
 * - PUT  /workspace/todos?path=<ws>        原子写入 todos.json（乐观并发，冲突 409）
 */
import { Hono } from "hono";
import {
  WorkspaceError,
  ensureWorkspace,
  initWorkspace,
  listDirectories,
  listDirectory,
  listFilesystemRoots,
  readWorkspaceFile,
  readWorkspaceInitStatus,
  resolveWorkspaceDir,
} from "./workspace.js";
import { TodoStoreError, readTodos, writeTodos, type TodoFile } from "./todos.js";
import { runWorkspaceMigrationOnce } from "./sessions.js";

const log = (msg: string) => console.log(msg);

export const app = new Hono();

// 只在工作区路由上做一次性的历史会话迁移，避免影响 langgraph 自身路由。
// 测试环境可用 OPEN_ASSISTANT_DISABLE_MIGRATION=1 关闭，避免误连真实 server。
const migrationMiddleware = async (_c: unknown, next: () => Promise<void>) => {
  if (process.env.OPEN_ASSISTANT_DISABLE_MIGRATION !== "1") {
    await runWorkspaceMigrationOnce(log);
  }
  await next();
};
app.use("/workspace", migrationMiddleware);
app.use("/workspace/*", migrationMiddleware);

app.onError((err, c) => {
  if (err instanceof WorkspaceError) {
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  }
  if (err instanceof TodoStoreError) {
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  }
  console.error("[http] unhandled error:", err);
  return c.json({ error: "INTERNAL", message: (err as Error).message }, 500);
});

/** 解析工作区路径查询参数（缺失 → 可读错误） */
function requireWorkspaceQuery(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new WorkspaceError("WORKSPACE_INVALID_PATH", "缺少 path 查询参数（工作区绝对路径）");
  }
  return raw;
}

// —— 本机目录浏览 ——

app.get("/fs/list", async (c) => {
  const raw = c.req.query("path");
  if (raw === undefined || raw.trim().length === 0) {
    const roots = await listFilesystemRoots();
    return c.json({ roots });
  }
  const result = await listDirectories(raw);
  return c.json(result);
});

// —— 工作区选择 / 初始化 ——

// 选定目录：只创建目录（或复现已有目录），MUST NOT 写入任何文件。
app.post("/workspace", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; create?: unknown };
  if (typeof body.path !== "string" || body.path.trim().length === 0) {
    return c.json({ error: "WORKSPACE_INVALID_PATH", message: "请求体必须包含 path（工作区绝对路径）" }, 400);
  }
  const dir = await ensureWorkspace(body.path, { create: body.create !== false });
  return c.json({ path: dir });
});

// 初始化状态：两件套各自是否存在（只读）
app.get("/workspace/status", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const status = await readWorkspaceInitStatus(workspace);
  return c.json(status);
});

// 显式初始化：幂等、只补缺失、绝不覆盖（用户点「初始化」才调）
app.post("/workspace/init", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { path?: unknown };
  if (typeof body.path !== "string" || body.path.trim().length === 0) {
    return c.json({ error: "WORKSPACE_INVALID_PATH", message: "请求体必须包含 path（工作区绝对路径）" }, 400);
  }
  const result = await initWorkspace(body.path);
  return c.json(result);
});

// —— 工作区内文件树 / 文件 / TODO ——

app.get("/workspace/tree", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  const rel = c.req.query("rel") ?? "/";
  const entries = await listDirectory(dir, rel);
  return c.json({ workspace: dir, path: rel, rel, entries });
});

app.get("/workspace/file", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  const rel = c.req.query("rel");
  if (!rel) {
    return c.json({ error: "PATH_INVALID", message: "缺少 rel 查询参数" }, 400);
  }
  const file = await readWorkspaceFile(dir, rel);
  return c.json({ workspace: dir, rel, ...file });
});

app.get("/workspace/todos", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  const snapshot = await readTodos(dir);
  return c.json({ workspace: dir, path: dir, exists: snapshot.exists, etag: snapshot.etag, file: snapshot.file });
});

app.put("/workspace/todos", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  const body = (await c.req.json().catch(() => null)) as
    | (TodoFile & { expectedEtag?: string | null })
    | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "TODO_INVALID_INPUT", message: "请求体必须是 JSON 对象" }, 400);
  }
  const { expectedEtag, ...file } = body;
  const { etag } = await writeTodos(dir, file as TodoFile, { expectedEtag });
  return c.json({ ok: true, workspace: dir, etag });
});

// 便于 `bun run scripts/*` / 单测直接调用，而不必起 server。
export default app;