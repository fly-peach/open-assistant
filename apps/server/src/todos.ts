/**
 * TODO 存储：`<workspace>/todos.json` 单文件事实源。
 *
 * 对齐 spec：
 * - todo-store / TODO 以 JSON 文件持久化：文件不存在视为空；非法 JSON 报错且不覆盖
 * - todo-store / TODO 条目的字段：id 稳定唯一、三态状态、创建/更新时间、来源
 * - todo-store / 并发写入不互相覆盖：乐观并发（etag），冲突 409；原子替换（临时文件 + rename）
 */
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { workspaceTodosPath } from "./workspace.js";

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TODO_SOURCES = ["user", "agent"] as const;
export type TodoSource = (typeof TODO_SOURCES)[number];

export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
  source: TodoSource;
}

export interface TodoFile {
  version: 1;
  updatedAt: string;
  todos: Todo[];
}

export type TodoErrorCode =
  | "TODO_INVALID_JSON"
  | "TODO_INVALID_CONTENT"
  | "TODO_NOT_FOUND"
  | "TODO_CONFLICT"
  | "TODO_INVALID_INPUT";

export class TodoStoreError extends Error {
  readonly code: TodoErrorCode;
  readonly status: number;
  constructor(code: TodoErrorCode, message: string, status = 400) {
    super(message);
    this.name = "TodoStoreError";
    this.code = code;
    this.status = status;
  }
}

export function emptyTodoFile(now: string = new Date().toISOString()): TodoFile {
  return { version: 1, updatedAt: now, todos: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/** 校验并归一化单条 TODO；缺失/非法字段直接报错（不静默丢弃） */
export function normalizeTodo(raw: unknown, index: number): Todo {
  if (!isRecord(raw)) {
    throw new TodoStoreError("TODO_INVALID_CONTENT", `todos[${index}] 不是对象`);
  }
  const { id, content, status, createdAt, updatedAt, source } = raw;
  if (typeof id !== "string" || id.length === 0) {
    throw new TodoStoreError("TODO_INVALID_CONTENT", `todos[${index}].id 缺失或非法`);
  }
  if (typeof content !== "string") {
    throw new TodoStoreError("TODO_INVALID_CONTENT", `todos[${index}].content 缺失或非法`);
  }
  if (typeof status !== "string" || !(TODO_STATUSES as readonly string[]).includes(status)) {
    throw new TodoStoreError(
      "TODO_INVALID_CONTENT",
      `todos[${index}].status 非法: ${JSON.stringify(status)}（仅允许 pending / in_progress / completed）`,
    );
  }
  if (!isIsoDateString(createdAt) || !isIsoDateString(updatedAt)) {
    throw new TodoStoreError("TODO_INVALID_CONTENT", `todos[${index}] 的 createdAt/updatedAt 缺失或不是时间`);
  }
  if (typeof source !== "string" || !(TODO_SOURCES as readonly string[]).includes(source)) {
    throw new TodoStoreError(
      "TODO_INVALID_CONTENT",
      `todos[${index}].source 非法: ${JSON.stringify(source)}（仅允许 user / agent）`,
    );
  }
  return {
    id,
    content,
    status: status as TodoStatus,
    createdAt,
    updatedAt,
    source: source as TodoSource,
  };
}

/** 校验并归一化整个文件内容 */
export function normalizeTodoFile(raw: unknown): TodoFile {
  if (!isRecord(raw)) {
    throw new TodoStoreError("TODO_INVALID_CONTENT", "todos 文件根必须是对象");
  }
  if (raw.version !== 1) {
    throw new TodoStoreError("TODO_INVALID_CONTENT", `不支持的 todos 版本: ${JSON.stringify(raw.version)}`);
  }
  if (!isIsoDateString(raw.updatedAt)) {
    throw new TodoStoreError("TODO_INVALID_CONTENT", "todos 文件 updatedAt 缺失或非法");
  }
  if (!Array.isArray(raw.todos)) {
    throw new TodoStoreError("TODO_INVALID_CONTENT", "todos 文件 todos 必须是数组");
  }
  const todos = raw.todos.map((t, i) => normalizeTodo(t, i));
  const seen = new Set<string>();
  for (const t of todos) {
    if (seen.has(t.id)) {
      throw new TodoStoreError("TODO_INVALID_CONTENT", `重复的 TODO id: ${t.id}`);
    }
    seen.add(t.id);
  }
  return { version: 1, updatedAt: raw.updatedAt, todos };
}

export interface TodoSnapshot {
  file: TodoFile;
  /** null 表示文件不存在 */
  etag: string | null;
  exists: boolean;
}

function etagOf(raw: string): string {
  return crypto.createHash("sha1").update(raw, "utf8").digest("hex");
}

/** 读取原始字节，文件不存在返回 null */
async function readRaw(workspaceDir: string): Promise<string | null> {
  try {
    return await fs.readFile(workspaceTodosPath(workspaceDir), "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * 读取 TODO。文件不存在 → 视为空（不报错、不落盘）。
 * 非法 JSON / 结构非法 → 抛错（调用方不得以空列表覆盖）。
 */
export async function readTodos(workspaceDir: string): Promise<TodoSnapshot> {
  const raw = await readRaw(workspaceDir);
  if (raw === null) {
    return { file: emptyTodoFile(), etag: null, exists: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TodoStoreError(
      "TODO_INVALID_JSON",
      `todos.json 不是合法 JSON，已拒绝读取/写入以免覆盖：${(err as Error).message}`,
      422,
    );
  }
  return { file: normalizeTodoFile(parsed), etag: etagOf(raw), exists: true };
}

// —— 进程内串行化：避免同一进程的并发写互相踩（跨进程/人工编辑仍由 etag 发现） ——
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export interface WriteTodosOptions {
  /** 传入上次读取的 etag；不一致 → 409，绝不覆盖。传 undefined 表示不校验（内部 mutation 用） */
  expectedEtag?: string | null;
}

/**
 * 原子写入（假定已持有锁）：临时文件 + rename。
 * 返回新的 etag。并发冲突抛 TODO_CONFLICT（status 409）。
 */
async function atomicWriteLocked(
  workspaceDir: string,
  file: TodoFile,
  options: WriteTodosOptions = {},
): Promise<{ etag: string }> {
  const filePath = workspaceTodosPath(workspaceDir);
  const currentRaw = await readRaw(workspaceDir);
  const currentEtag = currentRaw === null ? null : etagOf(currentRaw);

  if (options.expectedEtag !== undefined) {
    if (currentEtag !== options.expectedEtag) {
      throw new TodoStoreError(
        "TODO_CONFLICT",
        "todos.json 已被其他写入修改（乐观并发冲突），未覆盖对方内容，请重新读取后再试",
        409,
      );
    }
  }

  // 校验传入内容，非法内容不得落盘
  const normalized = normalizeTodoFile({
    ...file,
    version: 1,
    updatedAt: file.updatedAt ?? new Date().toISOString(),
  });
  const payload: TodoFile = { version: 1, updatedAt: normalized.updatedAt, todos: normalized.todos };
  const serialized = JSON.stringify(payload, null, 2) + "\n";

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await fs.open(tmpPath, "w");
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
  return { etag: etagOf(serialized) };
}

/**
 * 原子写入 TODO（临时文件 + rename，进程内串行化）。
 * 返回新的 etag。并发冲突抛 TODO_CONFLICT（status 409）。
 */
export async function writeTodos(
  workspaceDir: string,
  file: TodoFile,
  options: WriteTodosOptions = {},
): Promise<{ etag: string }> {
  return withLock(workspaceTodosPath(workspaceDir), () => atomicWriteLocked(workspaceDir, file, options));
}

function assertContent(content: unknown): asserts content is string {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new TodoStoreError("TODO_INVALID_INPUT", "TODO 内容不能为空");
  }
}

function assertStatus(status: unknown): asserts status is TodoStatus {
  if (typeof status !== "string" || !(TODO_STATUSES as readonly string[]).includes(status)) {
    throw new TodoStoreError(
      "TODO_INVALID_INPUT",
      `TODO 状态非法: ${JSON.stringify(status)}（仅允许 pending / in_progress / completed）`,
    );
  }
}

/**
 * 新增一条 TODO。以「读取当前 etag → 写入时校验」实现乐观并发。
 * 文件结构非法时抛 TODO_INVALID_JSON，绝不覆盖。
 */
export async function createTodo(
  workspaceDir: string,
  input: { content: string; status?: TodoStatus; source?: TodoSource; id?: string },
): Promise<{ todo: Todo; file: TodoFile; etag: string }> {
  assertContent(input.content);
  const status = input.status ?? "pending";
  assertStatus(status);
  const source = input.source ?? "agent";
  if (!(TODO_SOURCES as readonly string[]).includes(source)) {
    throw new TodoStoreError("TODO_INVALID_INPUT", `TODO 来源非法: ${JSON.stringify(source)}`);
  }
  const filePath = workspaceTodosPath(workspaceDir);
  return withLock(filePath, async () => {
    const snapshot = await readTodos(workspaceDir);
    const now = new Date().toISOString();
    const todo: Todo = {
      id: input.id ?? crypto.randomUUID(),
      content: input.content,
      status,
      createdAt: now,
      updatedAt: now,
      source,
    };
    if (snapshot.file.todos.some((t) => t.id === todo.id)) {
      throw new TodoStoreError("TODO_INVALID_INPUT", `TODO id 已存在: ${todo.id}`);
    }
    const next: TodoFile = {
      version: 1,
      updatedAt: now,
      todos: [...snapshot.file.todos, todo],
    };
    const { etag } = await atomicWriteLocked(workspaceDir, next, { expectedEtag: snapshot.etag });
    return { todo, file: next, etag };
  });
}

/**
 * 更新一条 TODO 的状态或内容；只影响目标条目。
 * 目标 id 不存在 → TODO_NOT_FOUND（不静默成功）。
 */
export async function updateTodo(
  workspaceDir: string,
  id: string,
  patch: { content?: string; status?: TodoStatus },
): Promise<{ todo: Todo; file: TodoFile; etag: string }> {
  if (typeof id !== "string" || id.length === 0) {
    throw new TodoStoreError("TODO_INVALID_INPUT", "缺少 TODO id");
  }
  if (patch.content === undefined && patch.status === undefined) {
    throw new TodoStoreError("TODO_INVALID_INPUT", "updateTodo 至少需要 content 或 status 之一");
  }
  if (patch.content !== undefined) assertContent(patch.content);
  if (patch.status !== undefined) assertStatus(patch.status);

  const filePath = workspaceTodosPath(workspaceDir);
  return withLock(filePath, async () => {
    const snapshot = await readTodos(workspaceDir);
    const index = snapshot.file.todos.findIndex((t) => t.id === id);
    if (index < 0) {
      throw new TodoStoreError("TODO_NOT_FOUND", `TODO 不存在: ${id}`, 404);
    }
    const now = new Date().toISOString();
    const existing = snapshot.file.todos[index]!;
    const updated: Todo = {
      ...existing,
      content: patch.content ?? existing.content,
      status: patch.status ?? existing.status,
      updatedAt: now,
    };
    const todos = snapshot.file.todos.slice();
    todos[index] = updated;
    const next: TodoFile = { version: 1, updatedAt: now, todos };
    const { etag } = await atomicWriteLocked(workspaceDir, next, { expectedEtag: snapshot.etag });
    return { todo: updated, file: next, etag };
  });
}

/** 删除一条 TODO；只影响目标条目。目标 id 不存在 → TODO_NOT_FOUND。 */
export async function deleteTodo(
  workspaceDir: string,
  id: string,
): Promise<{ file: TodoFile; etag: string }> {
  if (typeof id !== "string" || id.length === 0) {
    throw new TodoStoreError("TODO_INVALID_INPUT", "缺少 TODO id");
  }
  const filePath = workspaceTodosPath(workspaceDir);
  return withLock(filePath, async () => {
    const snapshot = await readTodos(workspaceDir);
    const index = snapshot.file.todos.findIndex((t) => t.id === id);
    if (index < 0) {
      throw new TodoStoreError("TODO_NOT_FOUND", `TODO 不存在: ${id}`, 404);
    }
    const now = new Date().toISOString();
    const todos = snapshot.file.todos.filter((t) => t.id !== id);
    const next: TodoFile = { version: 1, updatedAt: now, todos };
    const { etag } = await atomicWriteLocked(workspaceDir, next, { expectedEtag: snapshot.etag });
    return { file: next, etag };
  });
}