/**
 * 工作区基础：绝对路径解析与校验、本机目录浏览、目录初始化、路径约束。
 *
 * 对齐 spec：
 * - workspace / 工作区目录：工作区 = 用户在本机文件系统中选择的一个真实目录（绝对路径）
 * - workspace / 本机目录浏览与选择：listFilesystemRoots / listDirectories
 * - workspace / 选择目录时不写入任何文件：ensureWorkspace 只创建目录，MUST NOT 写任何文件
 * - workspace / 工作区初始化是显式动作：initWorkspace / readWorkspaceInitStatus（幂等、不覆盖）
 * - workspace / 拒绝文件系统根：normalizeWorkspacePath
 * - workspace / 同一目录同一身份：realpath 归一化
 * - workspace / 文件操作路径约束：resolveWorkspacePath / realpathWithin
 * - session-store / 会话数据落在所属工作区内：workspaceAppDataDir（`.open-assistant/`）
 * - workspace / 敏感信息与工作区分离：工作区只收人设 / TODO，凭据在 .env
 */
import path from "node:path";
import fs from "node:fs/promises";

import { WORKSPACE_MATERIALS } from "./workspace-materials.js";

/** 默认工作区名（历史 id 模型遗留，用于历史会话迁移与默认选中） */
export const DEFAULT_WORKSPACE_NAME = "default";

/** 应用数据子目录（会话索引 / 配置等系统数据落在这里，不散落到工作区根） */
export const APP_DATA_DIR = ".open-assistant";

/** 人设文件（agent 常规任务不得覆盖；见 agent.ts 的 wrapToolCall 保护） */
export const PERSONA_FILE = "AGENTS.md";

/** 首次引导剧本文件：助手完成身份确认后自己删掉它 */
export const BOOTSTRAP_FILE = "BOOTSTRAP.md";

/** 首次引导防重标记文件名（放在应用数据子目录里，不散落到工作区根） */
export const BOOTSTRAP_FLAG_FILE = ".bootstrap_completed";

/** TODO 单文件事实源 */
export const TODOS_FILE = "todos.json";

/** 列举工作区目录时被跳过的名字 */
const SKIPPED_NAMES = new Set(["node_modules"]);

export type WorkspaceErrorCode =
  | "WORKSPACE_INVALID_PATH"
  | "WORKSPACE_FS_ROOT"
  | "WORKSPACE_MISSING"
  | "WORKSPACE_NOT_DIR"
  | "WORKSPACE_NOT_CREATABLE"
  | "WORKSPACE_UNREADABLE"
  | "WORKSPACE_NOT_WRITABLE"
  | "WORKSPACE_INIT_FAILED"
  | "FS_LIST_FAILED"
  | "PATH_INVALID"
  | "PATH_OUT_OF_WORKSPACE"
  | "PATH_NOT_FOUND"
  | "PATH_NOT_FILE"
  | "PATH_NOT_DIR";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly status: number;

  constructor(code: WorkspaceErrorCode, message: string, status = 400) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.status = status;
  }
}

/** 工作区根路径：`WORKSPACE_ROOT` 可配置，未配置时落在 server 目录下的 .workspaces。
 *  仅用于「默认工作区」与历史会话迁移，不再作为工作区身份。 */
export function getWorkspaceRoot(): string {
  const raw = process.env.WORKSPACE_ROOT?.trim();
  return path.resolve(raw && raw.length > 0 ? raw : ".workspaces");
}

/** 默认工作区的绝对路径（历史 id 工作区 `default` 天然就是它） */
export function getDefaultWorkspacePath(): string {
  return path.resolve(getWorkspaceRoot(), DEFAULT_WORKSPACE_NAME);
}

function stripTrailingSep(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

/** 是否文件系统根（`/`、`C:\`、UNC 共享根等） */
export function isFilesystemRoot(input: string): boolean {
  if (typeof input !== "string" || input.trim().length === 0) return false;
  const resolved = path.resolve(input);
  const root = path.parse(resolved).root;
  return stripTrailingSep(resolved).toLowerCase() === stripTrailingSep(root).toLowerCase();
}

/**
 * 纯词法校验并归一化工作区路径：必须是绝对路径、非空、不是文件系统根。
 * 不做存在性检查（那由 resolveWorkspaceDir / ensureWorkspace 负责）。
 */
export function normalizeWorkspacePath(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new WorkspaceError("WORKSPACE_INVALID_PATH", "未指定工作区路径");
  }
  const trimmed = input.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new WorkspaceError(
      "WORKSPACE_INVALID_PATH",
      `工作区必须是绝对路径: ${JSON.stringify(input)}`,
    );
  }
  const resolved = path.resolve(trimmed);
  if (isFilesystemRoot(resolved)) {
    throw new WorkspaceError(
      "WORKSPACE_FS_ROOT",
      `不允许把文件系统根作为工作区（会获得整个磁盘的访问范围）: ${resolved}`,
    );
  }
  return resolved;
}

async function statOrNull(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function assertReadWrite(dir: string): Promise<void> {
  try {
    await fs.access(dir, fs.constants.R_OK);
  } catch {
    throw new WorkspaceError("WORKSPACE_UNREADABLE", `工作区不可读: ${dir}`, 403);
  }
  try {
    await fs.access(dir, fs.constants.W_OK);
  } catch {
    throw new WorkspaceError("WORKSPACE_NOT_WRITABLE", `工作区不可写: ${dir}`, 403);
  }
}

/**
 * 校验并解析可用的工作区：绝对路径 / 存在 / 是目录 / 可读写 / 非文件系统根。
 * 用 realpath 归一化（消除大小写、尾斜杠、`..`、符号链接差异），同一目录只有同一身份。
 * 不存在 / 不可访问 → 抛错，绝不回退到其他目录。
 */
export async function resolveWorkspaceDir(input: unknown): Promise<string> {
  const resolved = normalizeWorkspacePath(input);
  const st = await statOrNull(resolved);
  if (st === null) {
    throw new WorkspaceError("WORKSPACE_MISSING", `工作区不存在: ${resolved}`, 404);
  }
  if (!st.isDirectory()) {
    throw new WorkspaceError("WORKSPACE_NOT_DIR", `工作区不是一个目录: ${resolved}`, 400);
  }
  let real: string;
  try {
    real = await fs.realpath(resolved);
  } catch {
    real = resolved;
  }
  await assertReadWrite(real);
  return real;
}

export interface EnsureWorkspaceOptions {
  /** 路径不存在时是否创建（默认 true，对齐「可新建目录」） */
  create?: boolean;
}

/**
 * 确保工作区可用：存在（或按需创建）、是目录、可读写。
 *
 * 对齐 workspace / 「选择目录时不写入任何文件」：这里**只创建目录**，
 * MUST NOT 生成任何骨架 / 人设 / README —— 初始物料只能由用户显式触发
 * `initWorkspace` 写入（见 design.md Decision #9）。因此同一目录内容一个字节不变。
 */
export async function ensureWorkspace(
  input: unknown,
  options: EnsureWorkspaceOptions = {},
): Promise<string> {
  const create = options.create !== false;
  const resolved = normalizeWorkspacePath(input);
  const st = await statOrNull(resolved);
  if (st === null) {
    if (!create) {
      throw new WorkspaceError("WORKSPACE_MISSING", `工作区不存在: ${resolved}`, 404);
    }
    try {
      await fs.mkdir(resolved, { recursive: true });
    } catch (err) {
      throw new WorkspaceError(
        "WORKSPACE_NOT_CREATABLE",
        `无法创建工作区目录: ${resolved}（${(err as Error).message}）`,
        400,
      );
    }
  } else if (!st.isDirectory()) {
    throw new WorkspaceError("WORKSPACE_NOT_DIR", `工作区不是一个目录: ${resolved}`, 400);
  }

  let real: string;
  try {
    real = await fs.realpath(resolved);
  } catch {
    real = resolved;
  }
  await assertReadWrite(real);
  return real;
}

// —— 工作区初始化（显式动作，幂等，不覆盖） ——

/** 两件套在工作区根下的绝对路径 */
export function workspaceMaterialPath(workspaceDir: string, name: string): string {
  return path.join(path.resolve(workspaceDir), name);
}

/** 首次引导防重标记的绝对路径：`<工作区>/.open-assistant/.bootstrap_completed` */
export function workspaceBootstrapFlagPath(workspaceDir: string): string {
  return path.join(workspaceAppDataDir(workspaceDir), BOOTSTRAP_FLAG_FILE);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

export interface WorkspaceInitStatus {
  /**
   * 人设文件（`AGENTS.md`）已就位时 true（界面据此不再展示初始化入口）。
   *
   * 刻意**不**把 `BOOTSTRAP.md` 算进来：它是「一次性剧本」，引导完成后会被助手
   * 自己删掉。若把它的存在当作初始化条件，引导一结束初始化入口就会重新冒出来，
   * 点下去还会把 `BOOTSTRAP.md` 写回去 —— 形成永远结束不了的循环。
   */
  initialized: boolean;
  files: {
    /** `AGENTS.md`（人设）是否存在 */
    agentsMd: boolean;
    /** `BOOTSTRAP.md`（首次引导）是否存在 */
    bootstrapMd: boolean;
    /** 首次引导是否已经触发过（防重标记存在） */
    bootstrapCompleted: boolean;
  };
}

/**
 * 查询工作区初始化状态（tasks 9.4）：能分别看出两件套各自是否存在。
 * 本函数只读，不创建目录、不写文件。
 */
export async function readWorkspaceInitStatus(input: unknown): Promise<WorkspaceInitStatus> {
  const dir = await resolveWorkspaceDir(input);
  const [agentsMd, bootstrapMd, bootstrapCompleted] = await Promise.all([
    fileExists(workspaceMaterialPath(dir, PERSONA_FILE)),
    fileExists(workspaceMaterialPath(dir, BOOTSTRAP_FILE)),
    fileExists(path.join(workspaceAppDataDir(dir), BOOTSTRAP_FLAG_FILE)),
  ]);
  return {
    initialized: agentsMd,
    files: { agentsMd, bootstrapMd, bootstrapCompleted },
  };
}

export interface WorkspaceInitResult {
  path: string;
  /** 本次新写入的文件名 */
  created: string[];
  /** 已存在因而跳过的文件名（内容一个字节未动） */
  skipped: string[];
}

/**
 * 显式初始化工作区（tasks 9.3）：只补缺失的两件套，绝不覆盖已存在的同名文件。
 *
 * 用 `wx` 旗标写入（内核级“不存在才创建”），所以并发调用也只有一个能写成，
 * 已存在的文件即使内容完全不同也原样保留。
 * 任一文件写失败（权限 / 磁盘 / 同名目录等）→ 可读错误，已写入的不回滚，
 * 工作区本身仍可用（对齐 workspace「初始化失败可理解」）。
 */
export async function initWorkspace(input: unknown): Promise<WorkspaceInitResult> {
  const dir = await resolveWorkspaceDir(input);
  const created: string[] = [];
  const skipped: string[] = [];

  for (const material of WORKSPACE_MATERIALS) {
    const full = workspaceMaterialPath(dir, material.name);
    try {
      await fs.writeFile(full, material.content, { encoding: "utf8", flag: "wx" });
      created.push(material.name);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "EEXIST") {
        // 路径已被占住：只有确实是普通文件才叫「已存在、跳过」，
        // 同名目录 / 符号链接等无法当文件用的情况算失败（否则状态查询会与你说的不一致）。
        const st = await fs.stat(full).catch(() => null);
        if (st?.isFile()) {
          skipped.push(material.name);
          continue;
        }
        const done0 = created.length > 0 ? `；已写入 ${created.join("、")}` : "";
        throw new WorkspaceError(
          "WORKSPACE_INIT_FAILED",
          `初始化失败：${material.name} 已存在但不是普通文件（无法写入）${done0}`,
          500,
        );
      }
      const done = created.length > 0 ? `；已写入 ${created.join("、")}` : "";
      throw new WorkspaceError(
        "WORKSPACE_INIT_FAILED",
        `初始化失败：无法写入 ${material.name}（${e?.code ?? "UNKNOWN"}: ${e?.message ?? String(err)}）${done}`,
        e?.code === "EACCES" || e?.code === "EPERM" ? 403 : 500,
      );
    }
  }

  return { path: dir, created, skipped };
}

// —— 本机目录浏览（对齐 workspace / 本机目录浏览与选择） ——

/** 列出本机可用的磁盘 / 文件系统根 */
export async function listFilesystemRoots(): Promise<string[]> {
  if (process.platform === "win32") {
    const roots: string[] = [];
    for (let i = 0; i < 26; i += 1) {
      const root = `${String.fromCharCode(65 + i)}:\\`;
      try {
        await fs.access(root, fs.constants.R_OK);
        roots.push(root);
      } catch {
        // 盘符不存在 / 不可访问 → 跳过
      }
    }
    return roots;
  }

  const roots: string[] = ["/"];
  // Linux：补充 /proc/mounts 中的真实挂载点（失败则忽略，不影响浏览）
  try {
    const mounts = await fs.readFile("/proc/mounts", "utf8");
    for (const line of mounts.split("\n")) {
      const mount = line.split(" ")[1]?.replace(/\\040/g, " ");
      if (!mount || !mount.startsWith("/")) continue;
      if (["/proc", "/sys", "/dev", "/run"].some((p) => mount === p || mount.startsWith(`${p}/`))) continue;
      if (roots.includes(mount)) continue;
      const st = await statOrNull(mount);
      if (st?.isDirectory()) roots.push(mount);
    }
  } catch {
    // 非 Linux 或无法读取 /proc
  }
  roots.sort();
  return roots;
}

export interface FsEntry {
  name: string;
  /** 子目录的绝对路径 */
  path: string;
}

export interface FsListResult {
  /** 当前目录的绝对路径（realpath 归一化） */
  path: string;
  /** 上一级目录；已在根时 null */
  parent: string | null;
  entries: FsEntry[];
}

/**
 * 列举某绝对路径下的子目录（只列目录，供工作区选择器逐层进入）。
 * 无权限 / 读取失败 → FS_LIST_FAILED（可读提示），调用方可留在上一级。
 */
export async function listDirectories(input: unknown): Promise<FsListResult> {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new WorkspaceError("PATH_INVALID", "必须指定绝对路径");
  }
  const trimmed = input.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new WorkspaceError("PATH_INVALID", `目录浏览要求绝对路径: ${JSON.stringify(input)}`);
  }
  const resolved = path.resolve(trimmed);
  const st = await statOrNull(resolved);
  if (st === null) {
    throw new WorkspaceError("PATH_NOT_FOUND", `目录不存在: ${resolved}`, 404);
  }
  if (!st.isDirectory()) {
    throw new WorkspaceError("PATH_NOT_DIR", `不是目录: ${resolved}`, 400);
  }

  let real: string;
  try {
    real = await fs.realpath(resolved);
  } catch {
    real = resolved;
  }

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(real, { withFileTypes: true });
  } catch (err) {
    throw new WorkspaceError(
      "FS_LIST_FAILED",
      `无法读取目录（权限或不可访问）：${real}（${(err as Error).message}）`,
      403,
    );
  }

  const entries: FsEntry[] = [];
  for (const entry of dirents) {
    const child = path.join(real, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      const cst = await statOrNull(child);
      isDir = cst?.isDirectory() ?? false;
    }
    if (!isDir) continue;
    entries.push({ name: entry.name, path: child });
  }
  // 隐藏目录也保留（用户需要能进入 `.workspaces` 之类）；按名称排序
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parentRaw = path.dirname(real);
  const parent = parentRaw === real ? null : parentRaw;
  return { path: real, parent, entries };
}

// —— 应用数据目录（会话索引 / 配置，对齐 session-store / 会话数据落工作区内） ——

/** `<工作区>/.open-assistant` 的绝对路径 */
export function workspaceAppDataDir(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), APP_DATA_DIR);
}

/** 按需创建应用数据目录（仅系统数据写在这里，不散落到工作区根） */
export async function ensureAppDataDir(workspaceDir: string): Promise<string> {
  const dir = workspaceAppDataDir(workspaceDir);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 工作区会话索引文件：`<工作区>/.open-assistant/sessions.json` */
export function workspaceSessionIndexPath(workspaceDir: string): string {
  return path.join(workspaceAppDataDir(workspaceDir), "sessions.json");
}

/** 工作区配置文件：`<工作区>/.open-assistant/config.json` */
export function workspaceConfigPath(workspaceDir: string): string {
  return path.join(workspaceAppDataDir(workspaceDir), "config.json");
}

/** `todos.json` 的绝对路径 */
export function workspaceTodosPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), TODOS_FILE);
}

// —— 工作区内的虚拟相对路径约束（对齐 workspace / 文件操作路径约束） ——

/** 把虚拟路径（`/foo/bar` 或 `foo/bar`）规范成 POSIX 段数组，拒绝 `..` / `~` / 空段 */
function toPosixSegments(relPath: string): string[] {
  if (typeof relPath !== "string") {
    throw new WorkspaceError("PATH_INVALID", "路径必须是字符串");
  }
  let raw = relPath.trim();
  if (raw === "" || raw === "/" || raw === ".") return [];
  if (raw.startsWith("~")) {
    throw new WorkspaceError("PATH_INVALID", `不允许以 ~ 开头的路径: ${relPath}`);
  }
  if (path.isAbsolute(raw) && !raw.startsWith("/")) {
    // Windows 盘符绝对路径
    throw new WorkspaceError("PATH_INVALID", `不允许绝对路径: ${relPath}`);
  }
  raw = raw.replace(/^\/+/, "");
  const segments = raw.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === ".." || seg.includes("\\") || seg.includes("\0")) {
      throw new WorkspaceError("PATH_INVALID", `非法路径段 ${JSON.stringify(seg)}: ${relPath}`);
    }
  }
  return segments;
}

/** 纯词法解析：工作区相对虚拟路径 → 绝对路径，并做词法包含性校验 */
export function resolveWorkspacePath(workspaceDir: string, relPath: string): string {
  const root = path.resolve(workspaceDir);
  const segments = toPosixSegments(relPath);
  const full = path.resolve(root, ...segments);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new WorkspaceError("PATH_OUT_OF_WORKSPACE", `路径逃出工作区: ${relPath}`);
  }
  return full;
}

/** 在路径存在时解析真实路径（跟随符号链接），并再次校验包含性 */
async function realpathWithin(workspaceDir: string, full: string, relPath: string): Promise<string> {
  const rootReal = await fs.realpath(path.resolve(workspaceDir));
  let real: string;
  try {
    real = await fs.realpath(full);
  } catch {
    return full;
  }
  const rel = path.relative(rootReal, real);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new WorkspaceError(
      "PATH_OUT_OF_WORKSPACE",
      `路径经符号链接解析后逃出工作区: ${relPath}`,
    );
  }
  return real;
}

export interface WorkspaceEntry {
  /** 工作区内的虚拟路径，始终以 / 开头 */
  path: string;
  name: string;
  type: "file" | "directory";
  size: number | null;
  modifiedAt: string | null;
}

/**
 * 列举工作区内某目录「一层」。
 * - 目录优先排序，再按名称排序
 * - 跳过 `.` 开头与 `node_modules`
 * - 只读当前层，不递归，因此大目录下响应时间不随子目录内容增长
 */
export async function listDirectory(
  workspaceDir: string,
  relPath = "/",
): Promise<WorkspaceEntry[]> {
  const root = path.resolve(workspaceDir);
  const full = resolveWorkspacePath(root, relPath);
  const real = await realpathWithin(root, full, relPath);
  const st = await statOrNull(real);
  if (st === null) {
    throw new WorkspaceError("PATH_NOT_FOUND", `目录不存在: ${relPath}`, 404);
  }
  if (!st.isDirectory()) {
    throw new WorkspaceError("PATH_NOT_DIR", `不是目录: ${relPath}`, 400);
  }

  const baseSegments = toPosixSegments(relPath);
  const dirs: WorkspaceEntry[] = [];
  const files: WorkspaceEntry[] = [];

  const dirents = await fs.readdir(real, { withFileTypes: true });
  for (const entry of dirents) {
    if (entry.name.startsWith(".")) continue;
    if (SKIPPED_NAMES.has(entry.name)) continue;
    const entryFull = path.join(real, entry.name);
    let entryStat: import("node:fs").Stats | null = null;
    try {
      entryStat = await fs.stat(entryFull);
    } catch {
      entryStat = null;
    }
    const isDir = entry.isDirectory() || (entryStat?.isDirectory() ?? false);
    const virtualPath = "/" + [...baseSegments, entry.name].join("/");
    const record: WorkspaceEntry = {
      path: virtualPath,
      name: entry.name,
      type: isDir ? "directory" : "file",
      size: isDir ? null : entryStat?.size ?? null,
      modifiedAt: entryStat ? entryStat.mtime.toISOString() : null,
    };
    (isDir ? dirs : files).push(record);
  }

  const byName = (a: WorkspaceEntry, b: WorkspaceEntry) => a.name.localeCompare(b.name);
  dirs.sort(byName);
  files.sort(byName);
  return [...dirs, ...files];
}

export interface ReadFileResult {
  path: string;
  name: string;
  encoding: "utf8" | "base64";
  content: string;
  mimeType: string;
  size: number;
  truncated: boolean;
  modifiedAt: string | null;
}

const MIME_BY_EXT: Record<string, string> = {
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".yml": "text/yaml",
  ".yaml": "text/yaml",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

export function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

const DEFAULT_MAX_READ_BYTES = 1024 * 1024;

/**
 * 读取工作区内某文件。工作区外路径 → 抛 PATH_OUT_OF_WORKSPACE。
 * 文本按 utf8 返回；二进制（含 NUL 字节）按 base64 返回。
 */
export async function readWorkspaceFile(
  workspaceDir: string,
  relPath: string,
  options: { maxBytes?: number } = {},
): Promise<ReadFileResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_READ_BYTES;
  const root = path.resolve(workspaceDir);
  const full = resolveWorkspacePath(root, relPath);
  const real = await realpathWithin(root, full, relPath);
  const st = await statOrNull(real);
  if (st === null) {
    throw new WorkspaceError("PATH_NOT_FOUND", `文件不存在: ${relPath}`, 404);
  }
  if (st.isDirectory()) {
    throw new WorkspaceError("PATH_NOT_FILE", `不是文件: ${relPath}`, 400);
  }

  const handle = await fs.open(real, "r");
  try {
    const size = st.size;
    const toRead = Math.min(size, maxBytes);
    const buf = Buffer.alloc(toRead);
    await handle.read(buf, 0, toRead, 0);
    const truncated = size > maxBytes;
    const isBinary = buf.includes(0);
    const fileName = path.basename(real);
    const baseSegments = toPosixSegments(relPath);
    return {
      path: "/" + baseSegments.join("/"),
      name: fileName,
      encoding: isBinary ? "base64" : "utf8",
      content: isBinary ? buf.toString("base64") : buf.toString("utf8"),
      mimeType: guessMimeType(fileName),
      size,
      truncated,
      modifiedAt: st.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

/** 从 run config 中读取工作区绝对路径（`config.configurable.workspace`） */
export function readWorkspacePathFromConfig(config: unknown): string | undefined {
  const cfg = config as { configurable?: Record<string, unknown> } | undefined;
  const raw = cfg?.configurable?.["workspace"];
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return undefined;
}