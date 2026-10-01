/**
 * 文件预览分流（对齐 specs/file-workspace-ui「按文件类型渲染」与 design.md Decisions #7）。
 *
 * 纯函数、无 React 依赖，方便单测覆盖每种类型。渲染组件根据这里的结果选择呈现方式：
 * - `json`  → 结构化可读呈现（不是原始字符串堆）
 * - `markdown` → 富文本
 * - `code` → 语法高亮（复用基座已装的 react-syntax-highlighter）
 * - `image` → 图片
 * - `text` → 等宽纯文本
 * - `unsupported` → 明确的中文提示，不崩溃、不展示乱码
 */

export type PreviewType =
  | "json"
  | "markdown"
  | "code"
  | "image"
  | "text"
  | "unsupported";

/** 取小写扩展名（不含点）；无扩展名返回空串。 */
export function getExtension(fileName: string): string {
  const base = baseName(fileName);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 兼容 `/` 与 `\` 的 basename。 */
export function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
  "avif",
]);

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

const TEXT_EXTS = new Set([
  "txt",
  "log",
  "csv",
  "tsv",
  "env",
  "gitignore",
  "editorconfig",
  "cfg",
  "conf",
  "ini",
  "properties",
  "toml",
  "lock",
]);

/** 扩展名 → Prism 语言名（react-syntax-highlighter 用）。 */
export const LANGUAGE_MAP: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  c: "c",
  h: "c",
  cs: "csharp",
  php: "php",
  swift: "swift",
  m: "objectivec",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ps1: "powershell",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  html: "markup",
  htm: "markup",
  vue: "markup",
  xml: "markup",
  svg: "markup",
  yaml: "yaml",
  yml: "yaml",
  dockerfile: "docker",
  makefile: "makefile",
  lua: "lua",
  dart: "dart",
  r: "r",
  pl: "perl",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  clj: "clojure",
};

/** TODO 单文件事实源的文件名（对齐 todo-store：固定路径 `todos.json`）。 */
export const TODOS_FILE_NAME = "todos.json";

/** 是否是 TODO 文件（按 basename 判断，兼容任意目录层级）。 */
export function isTodoFile(filePath: string): boolean {
  return baseName(filePath).toLowerCase() === TODOS_FILE_NAME;
}

/**
 * 依据文件名（优先）与 MIME 类型（兜底）决定预览方式。
 * 已知扩展名即使 MIME 缺失也能正确分流；未知扩展名再退回 `text/*` / `image/*`。
 */
export function getPreviewType(
  fileName: string,
  mimeType?: string
): PreviewType {
  const ext = getExtension(fileName);
  const mime = mimeType?.toLowerCase() ?? "";

  if (ext === "json" || ext === "jsonc" || ext === "json5") return "json";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (IMAGE_EXTS.has(ext) || mime.startsWith("image/")) return "image";
  if (ext in LANGUAGE_MAP) return "code";
  if (TEXT_EXTS.has(ext)) return "text";

  if (ext === "") {
    if (mime.startsWith("text/")) return "text";
    if (mime === "") return "text";
    return "unsupported";
  }

  if (mime.startsWith("text/")) return "text";
  return "unsupported";
}

/** 取语法高亮语言；未知返回 `text`（Prism 会原样展示）。 */
export function getLanguage(fileName: string): string {
  return LANGUAGE_MAP[getExtension(fileName)] ?? "text";
}

/**
 * 把读取结果拼成图片可用的 URL：
 * - 后端对二进制文件返回 base64（见 workspace.ts），直接拼 data URL；
 * - 文本类图片（如 svg）返回 utf8，用 URL 编码嵌入。
 */
export function toImageSrc(
  content: string,
  encoding: "utf8" | "base64",
  mimeType: string
): string {
  const mime = mimeType && mimeType.startsWith("image/") ? mimeType : "image/*";
  if (encoding === "base64") {
    return `data:${mime};base64,${content}`;
  }
  return `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
}

/** 格式化文件大小（纯展示，无副作用）。 */
export function formatSize(size: number | null | undefined): string {
  if (size == null || Number.isNaN(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}