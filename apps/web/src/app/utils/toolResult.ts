/**
 * 工具结果正文的失败特征识别。
 *
 * 为什么需要它：实测（thread 01a0f36e-f91b-74ae-9a12-68f12aec8f60）后端把工具失败
 * 报成 `ToolMessage.status = "success"`，错误原因只写在正文里，形如
 * `Error: Error reading file '/x.md': ENOENT ...`。只看 status 的话，
 * 界面上失败会伪装成成功，而 specs/chat-ui 要求「失败可见且不被内容淹没」。
 *
 * 锚定在正文**开头**，避免把「检索到含 error 字样的行」误判为失败。
 */
export const ERROR_RESULT_PATTERNS: readonly RegExp[] = [
  /^\s*error\b\s*[:\-]/i,
  /^\s*exception\b\s*[:\-]/i,
  /^\s*traceback\b/i,
  /^\s*\[error\]/i,
  /^\s*failed\b\s*[:\-]/i,
];

/** 结果正文是否呈失败特征（只看字符串型结果）。 */
export function looksLikeToolError(result: unknown): boolean {
  const text = typeof result === "string" ? result : "";
  if (text.trim() === "") return false;
  return ERROR_RESULT_PATTERNS.some((pattern) => pattern.test(text));
}