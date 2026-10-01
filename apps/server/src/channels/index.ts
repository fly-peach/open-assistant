/**
 * 频道模块的公开入口（tasks 13.1–13.8）。
 *
 * 分层：
 * - `types.ts`    数据模型 + 字段类型系统 + 公共字段
 * - `catalog.ts`  已知频道目录（QQ / 飞书）+ 目录外频道的兜底
 * - `store.ts`    `<agents 根>/<agent-id>/channels.json` 的读写与校验
 * - `secrets.ts`  凭据库（工作区与 agent 目录之外）+ 掩码
 * - `dedupe.ts`   有界去重（平台会重放事件）
 * - `backoff.ts`  重连退避 + 静默连接看门狗
 * - `session-key.ts` 会话键 / 去抖键（必须同源，否则同会话会并发）
 * - `inbound.ts`  入站内容归一化与「无文本去抖」（纯媒体不能被无限挂起）
 * - `outbound.ts` 出站回复整形（开关与长度上限）
 * - `access-control.ts` 名单与「陌生人挂起待审批」
 * - `service.ts`  把上面几层组合成界面/HTTP 直接可用的视图
 *
 * 归属（design D13）：频道属于 **agent 定义**；agent ↔ 工作区 1:1（照 QwenPaw），
 * 因此消息落点永远唯一，不需要「目标工作区」字段。
 */
export * from "./types.js";
export * from "./catalog.js";
export * from "./store.js";
export * from "./secrets.js";
export * from "./dedupe.js";
export * from "./backoff.js";
export * from "./session-key.js";
export * from "./inbound.js";
export * from "./outbound.js";
export * from "./access-control.js";
export * from "./service.js";