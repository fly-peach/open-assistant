import { Client } from "@langchain/langgraph-sdk";
const c = new Client({ apiUrl: "http://localhost:2024" });
const threads = await c.threads.search({ limit: 40 });
const rows: any[] = [];
for (const t of threads) {
  const st: any = await c.threads.getState(t.thread_id).catch(() => null);
  const msgs = st?.values?.messages ?? [];
  const tools = msgs.filter((m: any) => m.type === "tool").length;
  if (msgs.length) rows.push({ id: t.thread_id, msgs: msgs.length, tools, ws: (t.metadata as any)?.workspace });
}
rows.sort((a, b) => b.tools - a.tools || b.msgs - a.msgs);
for (const r of rows.slice(0, 6)) console.log(`${r.id} msgs=${r.msgs} tools=${r.tools} ws=${r.ws}`);
