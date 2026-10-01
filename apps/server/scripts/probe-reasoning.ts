/** 探针：看 ChatOpenAI 把 reasoning_content 放到了哪里 */
import { ChatOpenAI } from "@langchain/openai";

const m = new ChatOpenAI({
  model: process.env.MODEL_ID!,
  apiKey: process.env.MODEL_API_KEY!,
  configuration: { baseURL: process.env.MODEL_BASE_URL! },
});

const stream = await m.stream("计算 17*23，只给结果");
let n = 0;
for await (const c of stream) {
  if (n++ > 6) break;
  console.log(`--- chunk ${n} ---`);
  console.log("  content       :", JSON.stringify(c.content).slice(0, 160));
  console.log("  contentBlocks :", JSON.stringify((c as any).contentBlocks ?? null).slice(0, 300));
  console.log("  addl_kwargs   :", JSON.stringify(c.additional_kwargs).slice(0, 300));
  console.log("  text()        :", JSON.stringify(typeof (c as any).text === "function" ? (c as any).text() : null).slice(0, 160));
}
