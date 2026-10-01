/**
 * 工作区 HTTP 客户端：对齐后端 `apps/server/src/http.ts` 暴露的自定义路由。
 *
 * 工作区 = 用户在本机文件系统中选中的一个**绝对路径**（design.md Decision #3），
 * 因此所有路由都以 `path`（绝对路径）传参，不再有 `:id`。
 *
 * - GET  /fs/list                    列举磁盘 / 文件系统根
 * - GET  /fs/list?path=<abs>         列举某目录一层的子目录（只列目录）
 * - POST /workspace                  归一化 / 创建目录 → `{ path }`
 * - GET  /workspace/tree?path=<ws>&rel=<rel>
 * - GET  /workspace/file?path=<ws>&rel=<rel>
 * - GET  /workspace/todos?path=<ws>
 * - PUT  /workspace/todos?path=<ws>  （乐观并发：带 expectedEtag，冲突 409）
 * - GET  /workspace/status?path=<ws> 初始化状态（两件套各自是否存在）
 * - POST /workspace/init             显式初始化（幂等，只补缺失、不覆盖）
 *
 * 这些路由挂在 langgraph dev server 根路径下，因此 base 与 `deploymentUrl` 相同。
 */
import { getConfig } from "@/lib/config";
import zh, { t } from "@/i18n/zh";

export interface WorkspaceEntry {
  /** 工作区内的相对路径，始终以 / 开头。 */
  path: string;
  name: string;
  type: "file" | "directory";
  size: number | null;
  modifiedAt: string | null;
}

/** 目录选择器里的一个可进入条目（只列目录，对齐 specs/workspace「只列目录」）。 */
export interface FsEntry {
  name: string;
  /** 绝对路径。 */
  path: string;
}

export interface FsListResult {
  /** 当前目录绝对路径。 */
  path: string;
  /** 上一级绝对路径；已是根时为 null。 */
  parent: string | null;
  entries: FsEntry[];
}

export interface FsRootsResult {
  roots: string[];
}

export interface WorkspaceFileResult {
  workspace: string;
  path: string;
  name: string;
  encoding: "utf8" | "base64";
  content: string;
  mimeType: string;
  size: number;
  truncated: boolean;
  modifiedAt: string | null;
}

/**
 * 初始化状态（对齐 specs/workspace「工作区初始化是显式动作」）。
 *
 * `files` 分别给出两件套是否存在，因此「只缺 `BOOTSTRAP.md`」与「两件套全缺」
 * 在界面上能看出不同文案。
 */
export interface WorkspaceStatus {
  /**
   * true 表示人设文件（`AGENTS.md`）已就位 —— 不会再展示初始化入口。
   *
   * 注意：不要把 `initialized` 理解成「两件套齐备」。`BOOTSTRAP.md` 是一次性剧本，
   * 引导完成后会被助手删掉，那时 `bootstrapMd` 为 false 但 `initialized` 仍为 true。
   */
  initialized: boolean;
  files: {
    /** `AGENTS.md`（人设）是否存在。 */
    agentsMd: boolean;
    /** `BOOTSTRAP.md`（首次引导）是否存在。 */
    bootstrapMd: boolean;
    /** 首次引导是否已经触发过。 */
    bootstrapCompleted: boolean;
  };
}

/** 初始化结果：新增了哪些、跳过了哪些（跳过的即已存在、未覆盖）。 */
export interface WorkspaceInitResult {
  path: string;
  created: string[];
  skipped: string[];
}

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoSource = "user" | "agent";

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

export interface TodoSnapshot {
  exists: boolean;
  etag: string | null;
  file: TodoFile;
}

/** 后端统一错误结构 `{ error, message }`；网络/解析失败也归一成这个类型。 */
export class WorkspaceApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "WorkspaceApiError";
    this.code = code;
    this.status = status;
  }

  /** 乐观并发冲突（TODO 已被其他写入修改）。 */
  get isConflict(): boolean {
    return this.code === "TODO_CONFLICT" || this.status === 409;
  }

  /** 路径不存在（如工作区里还没有 `wiki/`）：界面据此展示可读空状态而不是报错。 */
  get isNotFound(): boolean {
    return this.status === 404 || this.code === "PATH_NOT_FOUND";
  }
}

/** 判断任意错误是否「路径不存在」（SWR 把错误原样给出，界面需要区分空状态与失败）。 */
export function isPathNotFound(error: unknown): boolean {
  if (error instanceof WorkspaceApiError) return error.isNotFound;
  if (error && typeof error === "object") {
    const record = error as { status?: unknown; code?: unknown };
    return record.status === 404 || record.code === "PATH_NOT_FOUND";
  }
  return false;
}

export function getBaseUrl(): string {
  return getConfig()?.deploymentUrl || "http://localhost:2024";
}

/**
 * 统一的业务 API 请求（同源 base = 部署地址）。
 * 导出给其他业务客户端（agents / jobs / memory）复用同一套错误归一化。
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${getBaseUrl()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new WorkspaceApiError(
      "NETWORK_ERROR",
      t(zh.workspace.networkError, { error: (err as Error).message }),
      0
    );
  }

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const record = (body ?? {}) as { error?: unknown; message?: unknown };
    const code = typeof record.error === "string" ? record.error : "HTTP_ERROR";
    const message =
      typeof record.message === "string"
        ? record.message
        : typeof body === "string"
          ? body
          : t(zh.workspace.httpError, { status: res.status });
    throw new WorkspaceApiError(code, message, res.status);
  }

  return body as T;
}

/** 列举磁盘 / 文件系统根（选择器未指定起始路径时，对齐「列出磁盘或根」）。 */
export function listFsRoots(): Promise<FsRootsResult> {
  return request<FsRootsResult>("/fs/list");
}

/** 列举某绝对路径下的子目录（只列目录；无权限时抛可读错误，不整体失败）。 */
export function listFsDir(path: string): Promise<FsListResult> {
  return request<FsListResult>(`/fs/list?path=${encodeURIComponent(path)}`);
}

export interface PickFolderResult {
  path: string | null;
  cancelled: boolean;
  unsupported?: boolean;
  error?: string;
}

/**
 * 在**后端所在机器**上弹系统「选择文件夹」对话框，返回选中的绝对路径。
 * 无图形界面 / 取消时返回 `{ path: null, cancelled | error }`，调用方退回逐层浏览。
 */
export function pickNativeFolder(): Promise<PickFolderResult> {
  return request<PickFolderResult>("/fs/pick-folder", { method: "POST" });
}

/**
 * 归一化 / 创建目录，返回归一化后的绝对路径（同一目录对应同一工作区）。
 * `create = true` 时允许路径不存在（由后端创建）。
 */
export function openWorkspace(
  path: string,
  create = false
): Promise<{ path: string }> {
  return request<{ path: string }>("/workspace", {
    method: "POST",
    body: JSON.stringify({ path, create }),
  });
}

function workspaceQuery(workspacePath: string, rel?: string): string {
  const params = new URLSearchParams({ path: workspacePath });
  if (rel !== undefined) params.set("rel", rel);
  return params.toString();
}

export function listTree(
  workspacePath: string,
  rel = "/"
): Promise<{ workspace: string; path: string; entries: WorkspaceEntry[] }> {
  return request(`/workspace/tree?${workspaceQuery(workspacePath, rel)}`);
}

export function readWorkspaceFile(
  workspacePath: string,
  rel: string
): Promise<WorkspaceFileResult> {
  return request(`/workspace/file?${workspaceQuery(workspacePath, rel)}`);
}

/**
 * 查询工作区是否已初始化（两件套各自是否存在）。
 * 失败时抛 `WorkspaceApiError`（调用方决定是否展示可读错误）。
 */
export function getWorkspaceStatus(
  workspacePath: string
): Promise<WorkspaceStatus> {
  return request(`/workspace/status?${workspaceQuery(workspacePath)}`);
}

/**
 * 显式初始化（用户点「初始化」才调用）：向工作区写入两件套。
 * 幂等：只补缺失、绝不覆盖已存在的同名文件。
 */
export function initWorkspace(
  workspacePath: string
): Promise<WorkspaceInitResult> {
  return request<WorkspaceInitResult>("/workspace/init", {
    method: "POST",
    body: JSON.stringify({ path: workspacePath }),
  });
}

export function readTodos(
  workspacePath: string
): Promise<TodoSnapshot & { path: string }> {
  return request(`/workspace/todos?${workspaceQuery(workspacePath)}`);
}

export function writeTodos(
  workspacePath: string,
  file: TodoFile,
  expectedEtag: string | null
): Promise<{ ok: boolean; etag: string }> {
  return request(`/workspace/todos?${workspaceQuery(workspacePath)}`, {
    method: "PUT",
    body: JSON.stringify({ ...file, expectedEtag }),
  });
}