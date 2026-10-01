/**
 * 会话库文件位置约定。
 *
 * 对齐 design D4：`<工作区>/.open-assistant/sessions.sqlite`
 * （工作区即会话边界；一个工作区一个库，范围天然按 agent 隔离，见 D2）。
 */
import path from "node:path";

import { workspaceAppDataDir } from "../workspace.js";

/** 会话库文件名（在工作区应用数据子目录里） */
export const CONVERSATION_DB_FILE = "sessions.sqlite";

/** `<工作区>/.open-assistant/sessions.sqlite` 的绝对路径 */
export function conversationDbPath(workspaceDir: string): string {
  return path.join(workspaceAppDataDir(workspaceDir), CONVERSATION_DB_FILE);
}

/** `<工作区>/.open-assistant/` 的绝对路径（建库时按需创建） */
export function conversationDataDir(workspaceDir: string): string {
  return workspaceAppDataDir(workspaceDir);
}