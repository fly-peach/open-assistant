/**
 * 会话库（thread / turn / message 三层）模块入口。
 *
 * 用法见 `store.ts` 顶部注释；这里只做统一再导出，后续 agent 一律
 * `import { createThread, recordTurn, listSessions } from "./conversation/index.js"`。
 */
export * from "./store.js";
export * from "./message-slice.js";
export * from "./compaction.js";
export * from "./recording.js";
export * from "./schema.js";
export * from "./paths.js";
export {
  openConversationDb,
  closeConversationDb,
  closeAllConversationDbs,
  conversationDbExists,
  removeConversationDb,
} from "./db.js";