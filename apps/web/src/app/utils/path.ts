/**
 * 路径处理的纯函数集合（对齐 specs/workspace「本机目录浏览与选择」与 tasks 8.9~8.11）。
 *
 * 工作区一律是**本机绝对路径**，因此这里同时要兼容 POSIX（`/home/x`）与
 * Windows（`C:\Users\x`、`C:/Users/x`、UNC `\\host\share`）两种写法。
 * 全部为纯函数、无 React 依赖，方便单测覆盖边界。
 */
import { baseName } from "@/app/utils/preview";

/** 是否是绝对路径（POSIX `/` 开头、Windows 盘符 `C:\` / `C:/`、UNC `\\host`）。 */
export function isAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "") return false;
  if (v.startsWith("/")) return true;
  if (v.startsWith("\\\\") || v.startsWith("//")) return true;
  return /^[A-Za-z]:[\\/]/.test(v);
}

/** 路径的最后一个非空片段（兼容 `/` 与 `\`）；根路径返回自身。 */
export function basename(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, "");
  if (trimmed === "") return filePath;
  const name = baseName(trimmed);
  return name === "" ? trimmed : name;
}

/** 在当前目录下拼一个子目录名（保留原始分隔符风格）。 */
export function joinPath(base: string, name: string): string {
  const child = name.trim().replace(/^[\\/]+/, "");
  if (!child) return base;
  const useBackslash = /\\/.test(base) && !base.startsWith("/");
  const sep = useBackslash ? "\\" : "/";
  const sepRe = useBackslash ? /[\\/]+$/ : /\/*$/;
  const trimmedBase = base.replace(sepRe, "");
  if (trimmedBase === "") return `${sep}${child}`;
  return `${trimmedBase}${sep}${child}`;
}

export interface PathCrumb {
  /** 面包屑显示名。 */
  label: string;
  /** 该段对应的绝对路径，可直接用于导航。 */
  path: string;
}

/**
 * 把绝对路径拆成面包屑（从根到当前目录）。
 *
 * - `/home/me/notes` → `/`、`home`、`me`、`notes`
 * - `C:\Users\me` → `C:\`、`Users`、`me`
 * - 相对路径（旧 id 之类）返回空数组，调用方据此走「提示重选」。
 */
export function pathBreadcrumbs(value: string): PathCrumb[] {
  const raw = value.trim();
  if (!isAbsolutePath(raw)) return [];

  const normalized = raw.replace(/\\/g, "/");
  const crumbs: PathCrumb[] = [];
  let rest = normalized;

  // Windows 盘符：C:/... → 第一段是 `C:\`
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (drive) {
    const root = `${drive[1].toUpperCase()}:\\`;
    crumbs.push({ label: root, path: root });
    rest = drive[2];
  } else if (normalized.startsWith("//")) {
    // UNC：\\host\share\...
    const parts = normalized.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length === 0) return crumbs;
    const host = `\\\\${parts[0]}`;
    crumbs.push({ label: host, path: `${host}\\` });
    rest = parts.slice(1).join("/");
  } else {
    crumbs.push({ label: "/", path: "/" });
    rest = normalized.replace(/^\/+/, "");
  }

  const segments = rest.split("/").filter(Boolean);
  const prefix = crumbs[0].path;
  const sep = prefix.startsWith("/") ? "/" : "\\";
  let acc = prefix;
  for (const segment of segments) {
    acc = acc.endsWith(sep) ? `${acc}${segment}` : `${acc}${sep}${segment}`;
    crumbs.push({ label: segment, path: acc });
  }
  return crumbs;
}

export interface MiddleEllipsisOptions {
  /** 允许显示的最大字符数（超过则省略中间）。 */
  max?: number;
  /** 尾部保留的字符数（尾部通常更能区分不同目录）。 */
  tail?: number;
}

/**
 * 路径过长时的「中间省略」（tasks 8.11）。
 *
 * 保留头部与尾部、省略中间，配合 `title` 展示全文；这样即使路径很长也
 * 不会把侧边栏/工具条撑破。返回不代表真实路径，只用于展示。
 */
export function middleEllipsis(
  value: string,
  options: MiddleEllipsisOptions = {}
): string {
  const max = options.max ?? 42;
  const tail = Math.min(options.tail ?? Math.floor(max / 2), max - 4);
  if (value.length <= max) return value;
  const head = max - tail - 1; // 1 为省略号
  if (head <= 0) return `…${value.slice(value.length - (max - 1))}`;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}