import { Client } from "@langchain/langgraph-sdk";
const client = new Client({ apiUrl: "http://localhost:2024" });
const thread = await client.threads.create();
const stream = client.runs.stream(thread.thread_id, "assistant", {
  input: { messages: [{ type: "human", content: "计算 17*23，只给结果" }] },
  streamMode: ["messages", "updates"],
});
let empty = 0, withContent = 0, firstContentAt = -1, i = 0;
let finalMsg: any = null, seenReasoning: string | null = null;
for await (const ev of stream) {
  const e = ev as any; i++;
  if (e.event === "messages/complete") {
    const d = Array.isArray(e.data) ? e.data[0] : e.data;
    console.log(`\n[${i}] messages/complete  type=${d?.type}`);
    console.log("   content         :", JSON.stringify(d?.content).slice(0,140));
    console.log("   addl_kwargs 键  :", Object.keys(d?.additional_kwargs ?? {}));
    console.log("   reasoning 长度  :", (d?.additional_kwargs?.reasoning_content ?? "").length);
    if (d?.type === "ai") finalMsg = d;
  }
  if (e.event === "messages/partial" && Array.isArray(e.data)) {
    const m = e.data[0];
    const c = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content);
    const rc = m?.additional_kwargs?.reasoning_content ?? "";
    if (rc) seenReasoning = rc;
    if (!c) empty++; else { withContent++; if (firstContentAt < 0) { firstContentAt = i; console.log(`\n[${i}] 首个 content 非空 chunk: ${JSON.stringify(c).slice(0,80)}`); } }
  }
}
console.log("\n=== 统计 ===");
console.log(" reasoning 累积最终长度 :", seenReasoning?.length ?? 0);
console.log(" content 仍为空的 partial:", empty);
console.log(" content 非空的 partial  :", withContent);
console.log(" 首个非空 content 出现在第:", firstContentAt, "个事件");
console.log("\n=== 最终 AI 消息 content ===");
const fc = finalMsg?.content;
console.log(JSON.stringify(typeof fc === "string" ? fc : fc).slice(0, 300));
