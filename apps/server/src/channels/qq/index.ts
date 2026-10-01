/**
 * QQ 频道实现（tasks 13.9 / 13.10 / 13.11 / 13.12）。
 *
 * 三个文件分工：
 * - `protocol.ts` 纯协议：op codes / intents / 载荷构造 / 帧解析 / 重连台阶（可完整测试）
 * - `rest.ts`     取 token、取网关地址、调接口发消息（fetch 可注入）
 * - `gateway.ts`  连接状态机：握手 → 心跳 → 收事件（去重）→ 重连 / 会话重置 / 静默看门狗
 *
 * ⚠️ 全程**只有出站连接**：不监听任何入站端口（QQ 是「我们外连 + 平台推事件」）。
 */
export * from "./protocol.js";
export * from "./rest.js";
export * from "./gateway.js";
