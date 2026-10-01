/**
 * 探针：模型配置（供应商 / 远端发现 / 连通性 / 视觉探针）。
 *
 * 用法：
 *   bun run scripts/probe-models.ts             # 只用本地假上游跑全套（不需要真 key）
 *   PROBE_REAL=1 bun run scripts/probe-models.ts deepseek deepseek-chat
 *                                               # 额外拿真凭据测一次（会花钱，谨慎）
 *
 * 为什么默认用假上游：这个探针要能在**任何机器**上验证「界面里的那几个按钮背后
 * 真的能通」，而不是「你有 key 才能跑」。假上游是一个最小的 OpenAI 兼容服务，
 * 只认我们那三张纯色图（答对颜色），因此视觉探针的判定链路被真实地走了一遍。
 *
 * 副作用：会临时创建（结束时删除）一个名为 `probe-fake` 的自定义供应商。
 */
import { decodeFirstPngFromBody, nearestProbeColor } from "../tests/support/png.js";

const API_URL = process.env.LANGGRAPH_API_URL ?? "http://localhost:2024";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures += 1;
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/* ------------------------------------------------------------ 假上游 */

const fake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      return Response.json({ data: [{ id: "probe-vl" }, { id: "probe-text" }, { id: "probe-new" }] });
    }
    const body = await req.text();
    if (body.includes("data:image/png")) {
      // 「看得见」的方式是**真把图解开读像素**（见 tests/support/png.ts 的说明：
      // 比对 base64 在跨进程时会因为 zlib 输出差异而误判）
      const decoded = decodeFirstPngFromBody(body);
      const color = nearestProbeColor(decoded.pixels[0]!);
      return Response.json({ choices: [{ message: { content: `${color.label}色` } }] });
    }
    return Response.json({ choices: [{ message: { content: "pong" } }] });
  },
});
const FAKE_BASE = `http://127.0.0.1:${fake.port}/v1`;
console.log(`假上游：${FAKE_BASE}\n`);

let created = false;

try {
  // 1) 总览：三家内置供应商 + key 掩码 + 不泄漏明文
  {
    const res = await fetch(`${API_URL}/models`);
    const body = await json<{
      providers: Array<{ id: string; apiKeyMasked: string; hasApiKey: boolean }>;
      models: Array<{ providerId: string; id: string; vision: boolean | null; visionSource: string }>;
    }>(res);
    const ids = body.providers.map((p) => p.id).sort();
    check(
      "GET /models 返回三家内置供应商",
      res.status === 200 && ["ali-tokenplan", "aliyun", "deepseek"].every((id) => ids.includes(id)),
      ids.join(","),
    );
    check(
      "apiKey 一律掩码（不含明文片段）",
      body.providers.every((p) => !p.hasApiKey || p.apiKeyMasked.includes("*")),
    );
    const vl = body.models.find((m) => m.id === "qwen-vl-max");
    check("内置清单给出 qwen-vl-max 的视觉先验", vl?.vision === true && vl?.visionSource === "catalog");
    const unknown = body.models.find((m) => m.visionSource === "unknown");
    console.log(`       （清单里 ${body.models.length} 个模型，其中「未知视觉」示例：${unknown?.id ?? "无"}）`);
  }

  // 2) 建一个指向假上游的自定义供应商
  {
    const res = await fetch(`${API_URL}/models/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "probe-fake",
        kind: "custom",
        name: "探针假上游",
        baseUrl: FAKE_BASE,
        apiKey: "sk-probe-fake",
      }),
    });
    created = res.status === 200;
    check("POST /models/providers 创建自定义供应商", created, `HTTP ${res.status}`);
  }

  // 3) 非法 baseUrl 要被拒（不是 500）
  {
    const res = await fetch(`${API_URL}/models/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "probe-fake", baseUrl: "ftp://nope" }),
    });
    const body = await json<{ error?: string; field?: string }>(res);
    check(
      "非法 baseUrl → 400 且指出字段",
      res.status === 400 && body.error === "MODEL_INVALID_CONFIG" && body.field === "baseUrl",
      `${res.status} ${body.error}`,
    );
  }

  // 4) 内置供应商不可删
  {
    const res = await fetch(`${API_URL}/models/providers/deepseek`, { method: "DELETE" });
    check("内置供应商不可删除（409）", res.status === 409, `HTTP ${res.status}`);
  }

  // 5) 远端发现：只读，返回可加入项
  {
    const res = await fetch(`${API_URL}/models/providers/probe-fake/discover`, { method: "POST" });
    const body = await json<{ ok: boolean; models: string[]; added: string[] }>(res);
    check(
      "远端发现拿到 3 个模型且都不在清单里",
      body.ok && body.models.length === 3 && body.added.length === 3,
      body.models.join(","),
    );
  }

  // 6) 加入清单（幂等）
  {
    await fetch(`${API_URL}/models/providers/probe-fake/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: ["probe-vl"] }),
    });
    const res = await fetch(`${API_URL}/models/providers/probe-fake/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: ["probe-vl"] }),
    });
    const body = await json<{ provider: { models: string[] } }>(res);
    check("加入模型清单且不重复", body.provider.models.filter((m) => m === "probe-vl").length === 1);
  }

  // 7) 连通性测试
  {
    const res = await fetch(`${API_URL}/models/providers/probe-fake/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "probe-vl" }),
    });
    const body = await json<{ ok: boolean; latencyMs: number; reply?: string }>(res);
    check("连通性测试拿到回复", body.ok, `${body.latencyMs}ms / ${body.reply ?? ""}`);
  }

  // 8) 视觉探针：假上游能认图 → 支持
  {
    const res = await fetch(`${API_URL}/models/capability/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "probe-fake", modelId: "probe-vl" }),
    });
    const body = await json<{ vision: boolean | null; correct: number; persisted: boolean }>(res);
    check(
      "视觉探针判定支持（答对 3 次）并落盘",
      body.vision === true && body.correct === 3 && body.persisted,
      JSON.stringify(body),
    );
  }

  // 9) 手动指定压过自动结论（先把模型加进清单，否则它不在可选列表里）
  {
    await fetch(`${API_URL}/models/providers/probe-fake/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: ["probe-text"] }),
    });
    await fetch(`${API_URL}/models/capability`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "probe-fake", modelId: "probe-text", vision: false }),
    });
    const res = await fetch(`${API_URL}/models`);
    const body = await json<{ models: Array<{ id: string; vision: boolean | null; visionSource: string }> }>(res);
    const target = body.models.find((m) => m.id === "probe-text");
    check("手动指定后来源为 manual", target?.vision === false && target?.visionSource === "manual");
  }

  // 10) 默认模型 + 工作区选中项：需要真实工作区与绑定，缺绑定要是 409 而不是 500
  {
    const res = await fetch(`${API_URL}/models/selection?path=${encodeURIComponent(process.cwd())}`);
    check(
      "未绑定工作区查询选中项 → 409 AGENT_NOT_BOUND（不崩）",
      res.status === 409 || res.status === 200,
      `HTTP ${res.status}`,
    );
  }

  // 11) 可选：真凭据（PROBE_REAL=1 且给了 providerId / modelId 时）
  if (process.env.PROBE_REAL === "1") {
    const [providerId, modelId] = process.argv.slice(2);
    if (providerId) {
      const res = await fetch(`${API_URL}/models/providers/${providerId}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(modelId ? { modelId } : {}),
      });
      const body = await json<{ ok: boolean; latencyMs: number; error?: string }>(res);
      check(`真实供应商 ${providerId} 连通`, body.ok, body.error ?? `${body.latencyMs}ms`);
    }
    if (providerId && modelId) {
      const res = await fetch(`${API_URL}/models/capability/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, modelId }),
      });
      const body = await json<{ vision: boolean | null; reason: string }>(res);
      console.log(`       ${providerId}/${modelId} 视觉探测：${String(body.vision)} — ${body.reason}`);
    }
  }
} finally {
  fake.stop(true);
  if (created) {
    await fetch(`${API_URL}/models/providers/probe-fake`, { method: "DELETE" }).catch(() => undefined);
  }
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
