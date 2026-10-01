import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  TODO_STATUSES,
  TodoStoreError,
  createTodo,
  deleteTodo,
  normalizeTodo,
  readTodos,
  updateTodo,
  writeTodos,
  type TodoFile,
} from "../src/todos.js";
import { ensureWorkspace, workspaceTodosPath } from "../src/workspace.js";
import { todoCreateTool, todoDeleteTool, todoListTool, todoUpdateTool } from "../src/todo-tools.js";

let root: string;
let dir: string;
let wsId: string;
let counter = 0;

async function freshWorkspace(): Promise<{ id: string; dir: string }> {
  counter += 1;
  const id = `todos-${counter}`;
  // 工作区标识就是绝对路径（新模型）
  return { id, dir: await ensureWorkspace(path.join(root, id)) };
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oa-todos-"));
  process.env.WORKSPACE_ROOT = root;
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  const ws = await freshWorkspace();
  dir = ws.dir;
  wsId = ws.id;
});

describe("2.1 todos.json 结构与字段", () => {
  test("创建后字段齐全，状态受限于三态", async () => {
    const { todo, file } = await createTodo(dir, { content: "买牛奶" });
    expect(file.version).toBe(1);
    expect(typeof file.updatedAt).toBe("string");
    expect(todo.id.length).toBeGreaterThan(0);
    expect(todo.content).toBe("买牛奶");
    expect(TODO_STATUSES).toContain(todo.status);
    expect(todo.source).toBe("agent");
    expect(Number.isNaN(Date.parse(todo.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(todo.updatedAt))).toBe(false);

    // 非法状态被拒绝
    expect(() =>
      normalizeTodo(
        { id: "x", content: "c", status: "done", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: "agent" },
        0,
      ),
    ).toThrow(TodoStoreError);
    // 非法来源被拒绝
    expect(() =>
      normalizeTodo(
        { id: "x", content: "c", status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: "system" },
        0,
      ),
    ).toThrow(TodoStoreError);
  });
});

describe("2.2 读取边界", () => {
  test("文件不存在视为空（不报错、不落盘）", async () => {
    const snapshot = await readTodos(dir);
    expect(snapshot.exists).toBe(false);
    expect(snapshot.etag).toBe(null);
    expect(snapshot.file.todos).toEqual([]);
    // 读取不应创建文件
    const exists = await fs
      .access(workspaceTodosPath(dir))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  test("非法 JSON → 报错且不覆盖", async () => {
    const filePath = workspaceTodosPath(dir);
    await fs.writeFile(filePath, "{ 这不是 json", "utf8");
    const err = await readTodos(dir).catch((e) => e);
    expect(err).toBeInstanceOf(TodoStoreError);
    expect((err as TodoStoreError).code).toBe("TODO_INVALID_JSON");
    // 写入同样必须被拒绝，且原文件不被覆盖
    const writeErr = await createTodo(dir, { content: "x" }).catch((e) => e);
    expect(writeErr).toBeInstanceOf(TodoStoreError);
    expect(await fs.readFile(filePath, "utf8")).toBe("{ 这不是 json");
  });
});

describe("2.3 原子写入", () => {
  test("并发读写永远拿不到半截文件", async () => {
    await createTodo(dir, { content: "base", id: "base" });
    const large = "内容".repeat(60_000);

    const writers = Array.from({ length: 8 }, (_, i) => {
      const file: TodoFile = {
        version: 1,
        updatedAt: new Date().toISOString(),
        todos: [{ id: `w${i}`, content: large, status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: "agent" }],
      };
      return writeTodos(dir, file);
    });
    const readers = Array.from({ length: 150 }, () =>
      readTodos(dir).then(
        (s) => ({ ok: true as const, s }),
        (e) => ({ ok: false as const, e }),
      ),
    );

    const results = await Promise.all([...writers, ...readers]);
    const readResults = results.slice(writers.length) as Array<{ ok: boolean; e?: unknown }>;
    const failures = readResults.filter((r) => !r.ok);
    expect(failures).toEqual([]);
  });
});

describe("2.4 乐观并发（不静默覆盖）", () => {
  test("陈旧 etag 写入 → 409，对方内容保留", async () => {
    await createTodo(dir, { content: "first", id: "a" });
    const snap = await readTodos(dir);

    // 第一次写入成功
    await writeTodos(dir, { ...snap.file, updatedAt: new Date().toISOString() }, { expectedEtag: snap.etag });

    // 用同一个（已陈旧的）etag 再写 → 冲突
    const err = await writeTodos(
      dir,
      { version: 1, updatedAt: new Date().toISOString(), todos: [] },
      { expectedEtag: snap.etag },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TodoStoreError);
    expect((err as TodoStoreError).status).toBe(409);
    // 没有被空列表覆盖
    const after = await readTodos(dir);
    expect(after.file.todos.map((t) => t.id)).toContain("a");
  });

  test("人工外部编辑后，用旧 etag 写入被拒绝，人工改动保留", async () => {
    await createTodo(dir, { content: "first", id: "a" });
    const snap = await readTodos(dir);

    const humanEdit: TodoFile = {
      ...snap.file,
      updatedAt: new Date().toISOString(),
      todos: [
        ...snap.file.todos,
        { id: "human", content: "人工加的", status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: "user" },
      ],
    };
    await fs.writeFile(workspaceTodosPath(dir), JSON.stringify(humanEdit, null, 2), "utf8");

    const err = await writeTodos(dir, { ...snap.file, todos: [] }, { expectedEtag: snap.etag }).catch((e) => e);
    expect(err).toBeInstanceOf(TodoStoreError);
    expect((err as TodoStoreError).code).toBe("TODO_CONFLICT");
    const after = await readTodos(dir);
    expect(after.file.todos.map((t) => t.id)).toContain("human");
  });
});

describe("2.5–2.7 agent 工具", () => {
  // 工具从 run config 读取的是「工作区绝对路径」（与 agent backend 一致）
  const cfg = (workspacePath: string) => ({ configurable: { workspace: workspacePath } });

  test("todo_create 落盘、字段完整、来源为 agent", async () => {
    const raw = await todoCreateTool.invoke({ content: "写周报" }, cfg(dir));
    const parsed = JSON.parse(String(raw));
    expect(parsed.ok).toBe(true);
    expect(parsed.todo.source).toBe("agent");
    const snapshot = await readTodos(dir);
    expect(snapshot.file.todos.map((t) => t.content)).toContain("写周报");
  });

  test("todo_list 返回全部条目及状态", async () => {
    await createTodo(dir, { content: "A", status: "pending" });
    await createTodo(dir, { content: "B", status: "completed" });
    const raw = await todoListTool.invoke({}, cfg(dir));
    const parsed = JSON.parse(String(raw));
    expect(parsed.todos.length).toBe(2);
    expect(parsed.todos.map((t: { status: string }) => t.status).sort()).toEqual(["completed", "pending"]);
  });

  test("todo_update 只影响目标条目；不存在的 id 返回明确错误", async () => {
    const a = await createTodo(dir, { content: "A" });
    const b = await createTodo(dir, { content: "B" });
    const raw = await todoUpdateTool.invoke({ id: a.todo.id, status: "completed" }, cfg(dir));
    expect(JSON.parse(String(raw)).ok).toBe(true);
    const snapshot = await readTodos(dir);
    expect(snapshot.file.todos.find((t) => t.id === a.todo.id)!.status).toBe("completed");
    expect(snapshot.file.todos.find((t) => t.id === b.todo.id)!.status).toBe("pending");

    const missing = await todoUpdateTool.invoke({ id: "nope", status: "completed" }, cfg(dir));
    expect(String(missing)).toContain("TODO_NOT_FOUND");
  });

  test("todo_delete 只移除目标条目；不存在的 id 返回明确错误", async () => {
    const a = await createTodo(dir, { content: "A" });
    const b = await createTodo(dir, { content: "B" });
    const raw = await todoDeleteTool.invoke({ id: a.todo.id }, cfg(dir));
    expect(JSON.parse(String(raw)).ok).toBe(true);
    const snapshot = await readTodos(dir);
    expect(snapshot.file.todos.map((t) => t.id)).toEqual([b.todo.id]);

    const missing = await todoDeleteTool.invoke({ id: "nope" }, cfg(dir));
    expect(String(missing)).toContain("TODO_NOT_FOUND");
  });

  test("未指定工作区时工具返回可读错误", async () => {
    const raw = await todoListTool.invoke({}, {});
    expect(String(raw)).toContain("未指定工作区");
  });

  test("工具层：不存在 / 文件系统根 / 相对路径的工作区被拒绝且错误可读", async () => {
    const missing = await todoListTool.invoke({}, cfg(path.join(root, "no-such-ws")));
    expect(String(missing)).toMatch(/不存在|WORKSPACE_MISSING/);

    const rootPath = path.parse(process.cwd()).root;
    const atRoot = await todoListTool.invoke({}, cfg(rootPath));
    expect(String(atRoot)).toMatch(/根|磁盘/);

    const relative = await todoListTool.invoke({}, cfg("relative/ws"));
    expect(String(relative)).toMatch(/绝对路径/);
  });
});

describe("updateTodo/deleteTodo 直接调用", () => {
  test("不存在 id → TODO_NOT_FOUND", async () => {
    const e1 = await updateTodo(dir, "nope", { status: "completed" }).catch((e) => e);
    expect((e1 as TodoStoreError).code).toBe("TODO_NOT_FOUND");
    const e2 = await deleteTodo(dir, "nope").catch((e) => e);
    expect((e2 as TodoStoreError).code).toBe("TODO_NOT_FOUND");
  });
});