import { Client } from "@langchain/langgraph-sdk";
const client = new Client({ apiUrl: "http://localhost:2024" });
const t = await client.threads.create();
await client.runs.wait(t.thread_id, "assistant", {
  input: { messages: [{ type: "human", content: "帮我把「下午三点给张工回电话」加进待办，然后简短确认。" }] },
});
console.log("THREAD_ID=" + t.thread_id);
