/**
 * run 失败 → 可读文案。
 *
 * 模型网关（本项目的阿里云 token-plan MaaS）在「短时间请求过快」时返回 429
 * `Request rate increased too quickly`；这类限流要单独提示，而不是把原始报错糊给用户。
 */
import zh, { t } from "@/i18n/zh";

export function chatErrorText(error: unknown): string | null {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  if (/429|rate\s*limit|too quickly|rate increased|MODEL_RATE_LIMIT|RateLimit/i.test(message)) {
    return zh.chat.errorRateLimit;
  }
  return t(zh.chat.errorGeneric, { error: message.slice(0, 200) });
}