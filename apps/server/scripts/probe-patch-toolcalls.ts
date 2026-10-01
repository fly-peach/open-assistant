/**
 * 回归探针：provider 省略首个 delta 的 `role` 时，`wrapModelCall` 不得失败。
 *
 * 背景见 `src/model.ts`：带 `tools` 的请求里 provider 会间歇性省略首个流式 delta 的
 * `role`，`@langchain/openai` 于是把它转成 `ChatMessageChunk`（`type: "generic"`），
 * 而 LangChain 的 `AgentNode` 只接受 `AIMessage | Command` → 整轮 run 硬失败，
 * 报 `Invalid response from "wrapModelCall" ... expected AIMessage or Command, got object`。
 *
 * 修复前实测约 25% 失败（短回复更易触发）；修复后应为 0。
 *
 * 跑法（需要 dev server 在 2024）：`bun run probe:patch`
 */
import { Client } from "@langchain/langgraph-sdk";

const WS = String.raw`E:\open-assistant\.scratch\init-ui`;
const c = new Client({ apiUrl: "http://localhost:2024" });

/** 全部是会被模型「一个 token 答完」的短回复 —— 这正是最容易触发该 bug 的形态 */
const prompts = ["say ok", "reply with just: hi", "1+1=?", "say done", "ok?", "yes or no"];
const ROUNDS = 30;

let ok = 0;
let fail = 0;
for (let i = 0; i < ROUNDS; i++) {
  const thread = await c.threads.create({ metadata: { workspace: WS } as never });
  const prompt = prompts[i % prompts.length];
  try {
    await c.runs.wait(thread.thread_id, "assistant", {
      input: { messages: [{ type: "human", content: prompt }] },
      config: { configurable: { workspace: WS } },
    });
    ok++;
  } catch (e) {
    fail++;
    console.log(`#${i} FAIL "${prompt}": ${(e as Error).message.slice(0, 90)}`);
  }
}

console.log(`\nresult: ok=${ok} fail=${fail}`);
if (fail > 0) process.exit(1);