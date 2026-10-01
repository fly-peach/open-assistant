/**
 * 模型层适配：绕开上游一个会**硬失败**的 bug。
 *
 * ## 问题
 *
 * 我们的 provider（阿里云 token-plan + `deepseek-v4.1-flash`）在**带 `tools` 的请求**里，
 * 会**间歇性省略首个流式 delta 的 `role` 字段**（实测约 50%）。OpenAI 规范里
 * chat completion 的默认 role 就是 `assistant`，但它不带。
 *
 * 于是 `@langchain/openai` 的转换器里：
 *
 * ```js
 * const role = delta.role ?? defaultRole;   // 两者都是 undefined
 * ...
 * default: return new ChatMessageChunk({ ..., role });   // ← 落到这里
 * ```
 *
 * 产出的不是 `AIMessageChunk` 而是 `ChatMessageChunk`（`getType() === "generic"`）。
 * 聚合后的 chunk 类型随之变成 `ChatMessageChunk`，而 LangChain 的 `AgentNode` 只接受
 * `AIMessage | Command | ModelResponse`：
 *
 * ```
 * Error: Invalid response from "wrapModelCall" in middleware "<最内层>":
 *        expected AIMessage or Command, got object
 * ```
 *
 * 表现是**整轮 run 直接失败**（约 8%~25% 概率，短回复更易触发），前端只看到报错。
 * 注意报错里 middleware 的名字是**误导性的** —— 那只是最内层做透传的那一个。
 *
 * ## 做法
 *
 * 覆写 `_convertCompletionsDeltaToBaseMessageChunk`，在 delta 缺 role 时补上
 * `"assistant"`。这是**根因修复**：不再产出 `ChatMessageChunk`，流式与非流式两条
 * 路径同时修好。
 *
 * `@langchain/openai` 把该方法标了 `@deprecated`，但注释明确写着
 * *"we'll keep it here as an overridable method"* —— 覆写是受支持的扩展点。
 * 若将来上游移除它，TypeScript 会在编译期直接报错（不会静默退化）。
 */
/**
 * ## 为何继承 `ChatOpenAICompletions` 而不是 `ChatOpenAI`
 *
 * 根导出的 `ChatOpenAI` 是个**门面**（`extends BaseChatOpenAI`），内部持有一个
 * `ChatOpenAICompletions` 实例并把 `_generate` / 流式委托给它。它自己**没有**
 * `_convertCompletionsDeltaToBaseMessageChunk` 这个方法（运行时 `super.` 上是 undefined）。
 * 所以要覆写转换器，必须直接继承真正实现 chat completions 的那个类。
 *
 * 我们用不到 Responses API（我们的端点是 OpenAI 兼容的 chat completions），
 * 直接继承 `ChatOpenAICompletions` 语义等价且少一层转发。
 */
import { ChatOpenAICompletions } from "@langchain/openai";
import type { BaseMessageChunk } from "@langchain/core/messages";

type DeltaConverter = ChatOpenAICompletions["_convertCompletionsDeltaToBaseMessageChunk"];

export class RobustChatOpenAI extends ChatOpenAICompletions {
  protected _convertCompletionsDeltaToBaseMessageChunk(
    ...args: Parameters<DeltaConverter>
  ): BaseMessageChunk {
    const [delta, rawResponse, defaultRole] = args;
    return super._convertCompletionsDeltaToBaseMessageChunk(
      {
        ...delta,
        // 只在缺失时补默认值；delta 自带 role 时保持原样。
        role: delta["role"] ?? defaultRole ?? "assistant",
      },
      rawResponse,
      defaultRole,
    );
  }
}