/**
 * 项目 wiki 层（tasks 11.9–11.17）的公开入口。
 *
 * 两层结构（Karpathy LLM Wiki 模式，design D12）：
 * - **源层 = 工作区里用户自己的文件**（不另设 raw/ 目录）
 * - wiki `wiki/summaries/`、`wiki/entities/<type>/`、`index.md`、`log.md`、`graph.json`
 * - 规范 `wiki/SCHEMA.md`（纪律来源）
 *
 * 三个操作：Ingest（收录）/ Query（先读 index 再进页面）/ Lint（体检）。
 */
export * from "./paths.js";
export * from "./frontmatter.js";
export * from "./schema.js";
export * from "./skeleton.js";
export * from "./index-log.js";
export * from "./pages.js";
export * from "./ingest.js";
export * from "./archive.js";
export * from "./lint.js";
export * from "./graph.js";
