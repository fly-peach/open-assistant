/**
 * 会话存储探针：列出 thread 数、有消息的 thread 数，用于观察
 * 「重启后端后会话是否还在」（checkpoint 落在 `.langgraph_api/`）。
 *
 * 跑法（需要 dev server 在 2024）：`bun run scripts/probe-session-storage.ts`
 */
import { Client } from "@langchain/langgraph-sdk";

const c = new Client({ apiUrl: process.env.LANGGRAPH_API_URL ?? "http://localhost:2024" });
const threads = await c.threads.search({ limit: 200 });
let withMsgs = 0;
const samples: string[] = [];
for (const t of threads) {
  const st = (await c.threads.getState(t.thread_id).catch(() => null)) as
    | { values?: { messages?: unknown[] } }
    | null;
  const n = st?.values?.messages?.length ?? 0;
  if (n > 0) {
    withMsgs++;
    if (samples.length < 3) samples.push(`${t.thread_id} msgs=${n}`);
  }
}
console.log(`threads 总数: ${threads.length}`);
console.log(`有消息的:     ${withMsgs}`);
console.log(samples.join("\n"));
