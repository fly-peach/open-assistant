import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { ensureWorkspace, isFilesystemRoot } from "../src/workspace.js";
import { readTodos } from "../src/todos.js";

let root: string;
let counter = 0;

// 测试期间不触发历史会话迁移（避免连接真实 dev server）
process.env.OPEN_ASSISTANT_DISABLE_MIGRATION = "1";

async function loadApp() {
  return (await import("../src/http.js")).app;
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-http-")));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function freshDir(name: string): Promise<string> {
  counter += 1;
  return path.join(root, `${name}-${counter}`);
}

describe("HTTP：本机目录浏览（8.5）", () => {
  test("GET /fs/list 无 path → 返回磁盘/根", async () => {
    const app = await loadApp();
    const res = await app.request("/fs/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roots: string[] };
    expect(Array.isArray(body.roots)).toBe(true);
    expect(body.roots.length).toBeGreaterThan(0);
    for (const r of body.roots) expect(isFilesystemRoot(r)).toBe(true);
  });

  test("GET /fs/list?path= 只列目录并返回 parent", async () => {
    const app = await loadApp();
    const dir = await freshDir("browse");
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "a", "utf8");

    const res = await app.request(`/fs/list?path=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      parent: string | null;
      entries: Array<{ name: string; path: string }>;
    };
    expect(body.path).toBe(await fs.realpath(dir));
    expect(body.parent).toBe(path.dirname(await fs.realpath(dir)));
    expect(body.entries.map((e) => e.name)).toEqual(["sub"]);
    expect(path.isAbsolute(body.entries[0]!.path)).toBe(true);

    const missing = await app.request(`/fs/list?path=${encodeURIComponent(path.join(root, "nope-xyz"))}`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("PATH_NOT_FOUND");
  });
});

describe("HTTP：POST /workspace（8.1–8.3）", () => {
  test("创建/初始化工作区返回归一化绝对路径", async () => {
    const app = await loadApp();
    const target = await freshDir("created");
    const res = await app.request("/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe(await fs.realpath(target));
    expect((await fs.stat(body.path)).isDirectory()).toBe(true);
  });

  test("非绝对路径 / 文件系统根 / 缺 path → 400 且错误可读", async () => {
    const app = await loadApp();
    const rel = await app.request("/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "relative/dir" }),
    });
    expect(rel.status).toBe(400);
    expect(((await rel.json()) as { error: string }).error).toBe("WORKSPACE_INVALID_PATH");

    const fsRoot = path.parse(process.cwd()).root;
    const atRoot = await app.request("/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: fsRoot }),
    });
    expect(atRoot.status).toBe(400);
    expect(((await atRoot.json()) as { error: string }).error).toBe("WORKSPACE_FS_ROOT");

    const noPath = await app.request("/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noPath.status).toBe(400);
  });

  test("create:false 且路径不存在 → 404", async () => {
    const app = await loadApp();
    const res = await app.request("/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(root, "does-not-exist"), create: false }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("WORKSPACE_MISSING");
  });

  test("旧 :id 路由已移除", async () => {
    const app = await loadApp();
    const res = await app.request("/workspace/some-id/tree?path=/");
    expect(res.status).toBe(404);
  });
});

describe("HTTP：工作区 tree / file（1.7 / 1.8 / 8.8）", () => {
  test("GET tree 一层列举、目录优先、跳过隐藏与 node_modules", async () => {
    const app = await loadApp();
    const dir = await freshDir("http-tree");
    await ensureWorkspace(dir);
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    await fs.mkdir(path.join(dir, ".hidden"), { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "a", "utf8");

    const res = await app.request(`/workspace/tree?path=${encodeURIComponent(dir)}&rel=${encodeURIComponent("/")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: string; entries: Array<{ name: string; type: string }> };
    expect(body.workspace).toBe(await fs.realpath(dir));
    expect(body.entries[0]!.name).toBe("sub");
    expect(body.entries[0]!.type).toBe("directory");
    const names = body.entries.map((e) => e.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".hidden");
    expect(names).toContain("a.txt");
  });

  test("GET file 读取内容；工作区外被拒绝", async () => {
    const app = await loadApp();
    const dir = await freshDir("http-file");
    await ensureWorkspace(dir);
    await fs.writeFile(path.join(dir, "a.txt"), "hello", "utf8");

    const ok = await app.request(
      `/workspace/file?path=${encodeURIComponent(dir)}&rel=${encodeURIComponent("/a.txt")}`,
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { content: string }).content).toBe("hello");

    const bad = await app.request(
      `/workspace/file?path=${encodeURIComponent(dir)}&rel=${encodeURIComponent("../AGENTS.md")}`,
    );
    expect(bad.status).toBeGreaterThanOrEqual(400);

    const missing = await app.request(
      `/workspace/tree?path=${encodeURIComponent(path.join(root, "no-such-xyz"))}`,
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("WORKSPACE_MISSING");
  });
});

describe("HTTP：TODO 读取 / 写入（2.2 / 2.4）", () => {
  test("文件不存在视为空", async () => {
    const app = await loadApp();
    const dir = await freshDir("http-todos");
    await ensureWorkspace(dir);
    const res = await app.request(`/workspace/todos?path=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exists: boolean; file: { todos: unknown[] } };
    expect(body.exists).toBe(false);
    expect(body.file.todos).toEqual([]);
  });

  test("陈旧 etag → 409；正确 etag → 200", async () => {
    const app = await loadApp();
    const dir = await freshDir("http-todos-etag");
    await ensureWorkspace(dir);
    const snap = (await (
      await app.request(`/workspace/todos?path=${encodeURIComponent(dir)}`)
    ).json()) as { etag: string | null };

    const conflict = await app.request(`/workspace/todos?path=${encodeURIComponent(dir)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), todos: [], expectedEtag: "nope" }),
    });
    expect(conflict.status).toBe(409);

    const todo = {
      id: "t1",
      content: "x",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: "user",
    };
    const ok = await app.request(`/workspace/todos?path=${encodeURIComponent(dir)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), todos: [todo], expectedEtag: snap.etag }),
    });
    expect(ok.status).toBe(200);
    expect((await readTodos(dir)).file.todos.map((t) => t.id)).toEqual(["t1"]);
  });

  test("非法 JSON → 422 且不覆盖", async () => {
    const app = await loadApp();
    const dir = await freshDir("http-todos-bad");
    await ensureWorkspace(dir);
    await fs.writeFile(path.join(dir, "todos.json"), "{ bad", "utf8");
    const res = await app.request(`/workspace/todos?path=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(422);
    expect(await fs.readFile(path.join(dir, "todos.json"), "utf8")).toBe("{ bad");
  });
});

describe("HTTP：会话库路由的参数校验（不触发 SQLite）", () => {
  test("GET /workspace/sessions 缺 path → 400", async () => {
    const app = await loadApp();
    const res = await app.request("/workspace/sessions");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("WORKSPACE_INVALID_PATH");
  });

  test("GET /workspace/sessions/{id} 缺 path → 400", async () => {
    const app = await loadApp();
    const res = await app.request("/workspace/sessions/some-id");
    expect(res.status).toBe(400);
  });

  test("GET /workspace/sessions?path=<不存在> → 404（校验工作区时就拦下，不碰会话库）", async () => {
    const app = await loadApp();
    const dir = await freshDir("http-sessions-missing");
    const res = await app.request(`/workspace/sessions?path=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("WORKSPACE_MISSING");
  });
});

describe("HTTP：跨 agent 通信路由的参数校验（不触发运行）", () => {
  test("GET /agents/contactable 缺 path → 400", async () => {
    const app = await loadApp();
    const res = await app.request("/agents/contactable");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("WORKSPACE_INVALID_PATH");
  });

  test("POST /agents/{id}/ask 缺 path → 400", async () => {
    const app = await loadApp();
    const res = await app.request("/agents/life/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("WORKSPACE_INVALID_PATH");
  });

  test("POST /agents/{id}/ask 有 path 缺 text → 400（在校验阶段就拦下）", async () => {
    const app = await loadApp();
    const res = await app.request("/agents/life/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "C:\\nope" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("AGENT_INVALID_CONFIG");
  });
});