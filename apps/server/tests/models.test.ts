/**
 * 模型配置层（provider / 模型清单 / 能力位 / 每轮解析）。
 *
 * 分层验证：
 * - 纯函数：PNG 生成、判分、掩码、标识校验；
 * - 存储：首次播种（把老环境变量认成默认模型）、读写、内置不可删；
 * - 能力位优先级：manual > probe > catalog > unknown；
 * - 解析链：agent 配置 > 全局默认 > 环境变量；
 * - HTTP 契约：`/models*`；
 * - **视觉探针端到端**：起一个假上游（只认我们那三张纯色图，答对颜色），
 *   验证「支持 / 不支持 / 测不出来」三种结论各自落盘的样子。
 *   真实供应商上的验证见 `scripts/probe-models.ts`。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { AGENTS_ROOT_ENV } from "../src/agents/root.js";
import { clearAgentRuntimeCache, createAgent, updateAgent } from "../src/agents/registry.js";
import { writeBinding } from "../src/binding.js";
import { ModelError } from "../src/models/errors.js";
import { isCorrectAnswer, solidPng, solidPngDataUrl } from "../src/models/probe.js";
import { decodeFirstPngFromBody, decodePng, nearestProbeColor } from "./support/png.js";
import { invalidateModelResolution } from "../src/models/middleware.js";
import {
  clearModelCapability,
  getOverview,
  getSelection,
  probeModelCapability,
  setDefaultModel,
  setModelCapability,
  setSelection,
  upsertProvider,
} from "../src/models/index.js";
import { capabilityFor, clearModelCache, listModelViews, resolveEffectiveModel } from "../src/models/resolve.js";
import {
  MODELS_FILE_ENV,
  isValidProviderId,
  maskApiKey,
  readModelsFile,
  seedModelsFile,
  writeModelsFile,
} from "../src/models/store.js";
import { capabilityKey } from "../src/models/types.js";

process.env.OPEN_ASSISTANT_DISABLE_MIGRATION = "1";

let root: string;
let modelsFile: string;
let counter = 0;

const originalAgentsRoot = process.env[AGENTS_ROOT_ENV];
const originalModelsFile = process.env[MODELS_FILE_ENV];
const originalEnv = {
  MODEL_ID: process.env["MODEL_ID"],
  MODEL_BASE_URL: process.env["MODEL_BASE_URL"],
  MODEL_API_KEY: process.env["MODEL_API_KEY"],
  DEEPSEEK_API_KEY: process.env["DEEPSEEK_API_KEY"],
};

async function freshDir(name: string): Promise<string> {
  counter += 1;
  const dir = path.join(root, `${name}-${counter}`);
  await fs.mkdir(dir, { recursive: true });
  return fs.realpath(dir);
}

async function loadApp() {
  return (await import("../src/http.js")).app;
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-models-")));
  process.env[AGENTS_ROOT_ENV] = path.join(root, "agents");
  modelsFile = path.join(root, "models.json");
  process.env[MODELS_FILE_ENV] = modelsFile;
  process.env["MODEL_ID"] = "deepseek-v4.1-flash";
  process.env["MODEL_BASE_URL"] = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
  process.env["MODEL_API_KEY"] = "sk-test-tokenplan-1234567890";
  delete process.env["DEEPSEEK_API_KEY"];
});

afterAll(async () => {
  if (originalAgentsRoot === undefined) delete process.env[AGENTS_ROOT_ENV];
  else process.env[AGENTS_ROOT_ENV] = originalAgentsRoot;
  if (originalModelsFile === undefined) delete process.env[MODELS_FILE_ENV];
  else process.env[MODELS_FILE_ENV] = originalModelsFile;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function resetStore(): Promise<void> {
  await fs.rm(modelsFile, { force: true });
  await writeModelsFile(seedModelsFile(process.env));
  clearAgentRuntimeCache();
  clearModelCache();
  invalidateModelResolution();
}

/* ------------------------------------------------------------------ 纯函数 */

describe("视觉探针：PNG 生成与判分", () => {
  test("生成的是合法 PNG（签名 + IHDR 尺寸）", () => {
    const png = solidPng([220, 30, 30], 32);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR 紧跟在签名之后：4 字节长度 + "IHDR"
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(32);
    expect(png.readUInt32BE(20)).toBe(32);
    expect(png.subarray(-8, -4).toString("ascii")).toBe("IEND");
  });

  test("data URL 前缀正确，且不同颜色产出不同图片", () => {
    expect(solidPngDataUrl([220, 30, 30])).toStartWith("data:image/png;base64,");
    expect(solidPngDataUrl([220, 30, 30])).not.toBe(solidPngDataUrl([30, 80, 220]));
  });

  test("按 PNG 规范解回来是同一个纯色（编码器写对了）", () => {
    const decoded = decodePng(solidPng([30, 160, 70], 4));
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(4);
    expect(decoded.pixels.length).toBe(16);
    expect(decoded.pixels.every((pixel) => pixel.join(",") === "30,160,70")).toBe(true);
    expect(nearestProbeColor(decoded.pixels[0]!).key).toBe("green");
  });

  test("判分认得中文、英文与十六进制；不认得别的颜色", () => {
    const red = { key: "red", label: "红", rgb: [220, 30, 30] as const, aliases: ["红色", "red", "#dc1e1e"] };
    expect(isCorrectAnswer(red, "红色")).toBe(true);
    expect(isCorrectAnswer(red, "Red")).toBe(true);
    expect(isCorrectAnswer(red, " #DC1E1E ")).toBe(true);
    expect(isCorrectAnswer(red, "蓝色")).toBe(false);
    // 「我无法查看图片」这类拒答不能被算成答对
    expect(isCorrectAnswer(red, "抱歉，我无法查看图片")).toBe(false);
    expect(isCorrectAnswer(red, "")).toBe(false);
  });
});

describe("工具函数：掩码与标识", () => {
  test("掩码只留头尾，短 key 整段打码", () => {
    expect(maskApiKey("sk-abcdefghijklmnop")).toBe("sk-a********mnop");
    expect(maskApiKey("sk-1")).toBe("****");
    expect(maskApiKey("")).toBe("");
  });

  test("供应商标识拒绝路径分隔符 / 空白 / 过长", () => {
    expect(isValidProviderId("deepseek")).toBe(true);
    expect(isValidProviderId("custom-1")).toBe(true);
    expect(isValidProviderId("a/b")).toBe(false);
    expect(isValidProviderId("a b")).toBe(false);
    expect(isValidProviderId("../x")).toBe(false);
    expect(isValidProviderId("")).toBe(false);
    expect(isValidProviderId("x".repeat(49))).toBe(false);
  });
});

/* ---------------------------------------------------------------- 播种 */

describe("models.json：首次播种认可老环境变量", () => {
  test("三家内置供应商都在，且 ali-tokenplan 认到 MODEL_* 三个变量", () => {
    const seeded = seedModelsFile(process.env);
    const ids = seeded.providers.map((p) => p.id).sort();
    expect(ids).toEqual(["ali-tokenplan", "aliyun", "deepseek"]);

    const tokenPlan = seeded.providers.find((p) => p.id === "ali-tokenplan")!;
    expect(tokenPlan.baseUrl).toBe(process.env["MODEL_BASE_URL"]!);
    expect(tokenPlan.apiKey).toBe(process.env["MODEL_API_KEY"]!);

    // 默认模型 = 老配置里的 MODEL_ID，且它自动进了该供应商的手工清单
    expect(seeded.defaultProviderId).toBe("ali-tokenplan");
    expect(seeded.defaultModelId).toBe("deepseek-v4.1-flash");
    expect(tokenPlan.models).toContain("deepseek-v4.1-flash");

    // 没配 key 的供应商就是空串（而不是伪造一个）
    expect(seeded.providers.find((p) => p.id === "deepseek")!.apiKey).toBe("");
  });

  test("文件不存在时读一次就落盘（幂等）", async () => {
    await resetStore();
    await fs.rm(modelsFile, { force: true });
    const first = await readModelsFile(process.env);
    expect(first.providers.length).toBe(3);
    const stat = await fs.stat(modelsFile);
    expect(stat.isFile()).toBe(true);
    const second = await readModelsFile(process.env);
    expect(second.providers.length).toBe(3);
  });
});

/* ------------------------------------------------------------ 能力位 */

describe("能力位：manual > probe > catalog > unknown", () => {
  test("内置清单提供先验（qwen-vl 支持、deepseek-chat 不支持）", async () => {
    const file = await readModelsFile(process.env);
    expect(capabilityFor(file, "aliyun", "qwen-vl-max")).toEqual({ vision: true, source: "catalog" });
    expect(capabilityFor(file, "deepseek", "deepseek-chat")).toEqual({ vision: false, source: "catalog" });
  });

  test("拿不准的就是 null（unknown），不假装知道", async () => {
    const file = await readModelsFile(process.env);
    // token-plan 上的模型清单里写的是 null → 未知
    expect(capabilityFor(file, "ali-tokenplan", "deepseek-v4.1-flash")).toMatchObject({
      vision: null,
      source: "unknown",
    });
    // 清单外的模型也一律未知
    expect(capabilityFor(file, "aliyun", "some-new-model")).toMatchObject({ vision: null, source: "unknown" });
  });

  test("手动指定压过内置清单；清掉后回到先验", async () => {
    await resetStore();
    await setModelCapability("deepseek", "deepseek-chat", true);
    let file = await readModelsFile(process.env);
    expect(capabilityFor(file, "deepseek", "deepseek-chat")).toMatchObject({ vision: true, source: "manual" });

    await clearModelCapability("deepseek", "deepseek-chat");
    file = await readModelsFile(process.env);
    expect(capabilityFor(file, "deepseek", "deepseek-chat")).toMatchObject({ vision: false, source: "catalog" });
  });

  test("探测结论压过内置清单", async () => {
    await resetStore();
    const file = await readModelsFile(process.env);
    file.capabilities[capabilityKey("aliyun", "qwen-vl-max")] = {
      vision: false,
      source: "probe",
      failures: 1,
      updatedAt: new Date().toISOString(),
    };
    await writeModelsFile(file);
    const reread = await readModelsFile(process.env);
    expect(capabilityFor(reread, "aliyun", "qwen-vl-max")).toMatchObject({ vision: false, source: "probe" });
  });
});

/* ---------------------------------------------------------------- 清单 */

describe("可选模型清单", () => {
  test("内置清单 ∪ 手工补充，且按 id 去重", async () => {
    await resetStore();
    const file = await readModelsFile(process.env);
    const provider = file.providers.find((p) => p.id === "aliyun")!;
    provider.models = ["qwen-vl-max", "my-private-model"];
    await writeModelsFile(file);

    const views = listModelViews(await readModelsFile(process.env));
    const ali = views.filter((v) => v.providerId === "aliyun");
    // qwen-vl-max 同时在参考清单与手工清单里，只能出现一次
    expect(ali.filter((v) => v.id === "qwen-vl-max").length).toBe(1);
    expect(ali.find((v) => v.id === "qwen-vl-max")!.source).toBe("catalog");
    expect(ali.find((v) => v.id === "my-private-model")!.source).toBe("manual");
  });

  test("停用的供应商不进清单", async () => {
    await resetStore();
    const file = await readModelsFile(process.env);
    file.providers.find((p) => p.id === "deepseek")!.enabled = false;
    await writeModelsFile(file);
    const views = listModelViews(await readModelsFile(process.env));
    expect(views.some((v) => v.providerId === "deepseek")).toBe(false);
  });

  test("远端清单只覆盖它那一家的模型", async () => {
    await resetStore();
    const remote = new Map([["deepseek", ["deepseek-chat", "brand-new-from-api"]]]);
    const views = listModelViews(await readModelsFile(process.env), remote);
    const ds = views.filter((v) => v.providerId === "deepseek");
    expect(ds.find((v) => v.id === "brand-new-from-api")!.source).toBe("remote");
    expect(ds.find((v) => v.id === "brand-new-from-api")!.vision).toBeNull();
  });
});

/* -------------------------------------------------------- 供应商增改删 */

describe("供应商增改删", () => {
  test("改 baseUrl 会校验形状；改 key 会 trim", async () => {
    await resetStore();
    const view = await upsertProvider({ id: "deepseek", baseUrl: "https://api.deepseek.com/v1/", apiKey: "  sk-new  " });
    expect(view.baseUrl).toBe("https://api.deepseek.com/v1");
    const file = await readModelsFile(process.env);
    expect(file.providers.find((p) => p.id === "deepseek")!.apiKey).toBe("sk-new");
  });

  test("非法 baseUrl 被拒绝（不静默存下）", async () => {
    await resetStore();
    await expect(upsertProvider({ id: "deepseek", baseUrl: "ftp://x" })).rejects.toThrow(ModelError);
    await expect(upsertProvider({ id: "deepseek", baseUrl: "not a url" })).rejects.toThrow(ModelError);
  });

  test("前端把掩码回传时不覆盖真 key", async () => {
    await resetStore();
    await upsertProvider({ id: "deepseek", apiKey: "sk-real-key-123456" });
    await upsertProvider({ id: "deepseek", apiKey: "sk-r********3456" });
    const file = await readModelsFile(process.env);
    expect(file.providers.find((p) => p.id === "deepseek")!.apiKey).toBe("sk-real-key-123456");
  });

  test("空串可以显式清空 key", async () => {
    await resetStore();
    await upsertProvider({ id: "deepseek", apiKey: "sk-real-key-123456" });
    await upsertProvider({ id: "deepseek", apiKey: "" });
    const file = await readModelsFile(process.env);
    expect(file.providers.find((p) => p.id === "deepseek")!.apiKey).toBe("");
  });

  test("不带 id 时分配 custom-N", async () => {
    await resetStore();
    const first = await upsertProvider({ kind: "custom", name: "自建网关", baseUrl: "http://127.0.0.1:8080/v1" });
    expect(first.id).toBe("custom-1");
    expect(first.removable).toBe(true);
    const second = await upsertProvider({ kind: "custom" });
    expect(second.id).toBe("custom-2");
  });

  test("内置供应商不可删，自定义可以删", async () => {
    await resetStore();
    await expect(
      import("../src/models/index.js").then((m) => m.deleteProvider("deepseek")),
    ).rejects.toThrow(ModelError);
    const custom = await upsertProvider({ kind: "custom", name: "临时", baseUrl: "http://127.0.0.1:9/v1" });
    const { deleteProvider } = await import("../src/models/index.js");
    await deleteProvider(custom.id);
    const file = await readModelsFile(process.env);
    expect(file.providers.some((p) => p.id === custom.id)).toBe(false);
  });

  test("总览里的 key 一律掩码（明文不出后端）", async () => {
    await resetStore();
    const overview = await getOverview();
    const tokenPlan = overview.providers.find((p) => p.id === "ali-tokenplan")!;
    expect(tokenPlan.hasApiKey).toBe(true);
    expect(tokenPlan.apiKeyMasked).toContain("*");
    expect(JSON.stringify(overview)).not.toContain(process.env["MODEL_API_KEY"]!);
  });
});

/* ------------------------------------------------------------ 解析链 */

describe("每轮模型解析：agent 配置 > 全局默认 > 环境变量", () => {
  test("没有绑定、没有全局默认时回落到环境变量", async () => {
    await resetStore();
    const file = await readModelsFile(process.env);
    delete file.defaultProviderId;
    delete file.defaultModelId;
    await writeModelsFile(file);

    const workspace = await freshDir("ws-env");
    const resolved = await resolveEffectiveModel(workspace);
    expect(resolved).toMatchObject({
      providerId: "env",
      modelId: process.env["MODEL_ID"]!,
      origin: "env",
    });
  });

  test("有全局默认时用全局默认（带供应商的 key）", async () => {
    await resetStore();
    const resolved = await resolveEffectiveModel(await freshDir("ws-default"));
    expect(resolved).toMatchObject({
      providerId: "ali-tokenplan",
      modelId: "deepseek-v4.1-flash",
      origin: "default",
    });
    expect(resolved!.apiKey).toBe(process.env["MODEL_API_KEY"]!);
  });

  test("agent 配置压过全局默认，且运行身份只认工作区绑定", async () => {
    await resetStore();
    await upsertProvider({ id: "deepseek", apiKey: "sk-deepseek-abcdef" });
    await createAgent({ id: "with-model", name: "带模型的 agent" });
    await updateAgent("with-model", { config: { model: { id: "deepseek-reasoner", providerId: "deepseek" } } });

    const workspace = await freshDir("ws-agent");
    await writeBinding(workspace, "with-model", { mode: "keep", reason: "user" });

    const resolved = await resolveEffectiveModel(workspace);
    expect(resolved).toMatchObject({
      providerId: "deepseek",
      modelId: "deepseek-reasoner",
      origin: "agent",
    });
    expect(resolved!.apiKey).toBe("sk-deepseek-abcdef");
    // 内置清单说 deepseek-reasoner 不看图 → 能力位随解析结果一起带出来
    expect(resolved!.vision).toBe(false);
  });

  test("老配置只有 baseUrl 时按 baseUrl 反查供应商", async () => {
    await resetStore();
    await createAgent({ id: "legacy-model" });
    await updateAgent("legacy-model", {
      config: { model: { id: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" } },
    });
    const workspace = await freshDir("ws-legacy");
    await writeBinding(workspace, "legacy-model", { mode: "keep", reason: "user" });

    const resolved = await resolveEffectiveModel(workspace);
    expect(resolved).toMatchObject({ providerId: "deepseek", modelId: "deepseek-chat", origin: "agent" });
  });

  test("选了被停用的供应商时不下发（回落到默认）", async () => {
    await resetStore();
    const file = await readModelsFile(process.env);
    file.providers.find((p) => p.id === "deepseek")!.enabled = false;
    await writeModelsFile(file);
    await createAgent({ id: "disabled-provider" });
    await updateAgent("disabled-provider", {
      config: { model: { id: "deepseek-chat", providerId: "deepseek" } },
    });
    const workspace = await freshDir("ws-disabled");
    await writeBinding(workspace, "disabled-provider", { mode: "keep", reason: "user" });

    const resolved = await resolveEffectiveModel(workspace);
    expect(resolved!.origin).toBe("default");
  });
});

/* ------------------------------------------------------- 选中项写入 */

describe("工作区选中项", () => {
  test("setSelection 写进绑定 agent 的 config.json，下一轮解析就变了", async () => {
    await resetStore();
    await upsertProvider({ id: "aliyun", apiKey: "sk-dashscope-abcdef" });
    await createAgent({ id: "picker" });
    const workspace = await freshDir("ws-pick");
    await writeBinding(workspace, "picker", { mode: "keep", reason: "user" });

    await setSelection(workspace, "aliyun", "qwen-vl-max");
    clearAgentRuntimeCache();
    invalidateModelResolution();

    const resolved = await resolveEffectiveModel(workspace);
    expect(resolved).toMatchObject({ providerId: "aliyun", modelId: "qwen-vl-max", origin: "agent", vision: true });

    const view = await getSelection(workspace, workspace);
    expect(view.agentId).toBe("picker");
    expect(view.configured).toEqual({ providerId: "aliyun", modelId: "qwen-vl-max" });
    expect(view.effective!.modelName).toContain("VL");
  });

  test("未绑定时给出可照做的错误（AGENT_NOT_BOUND）", async () => {
    await resetStore();
    const workspace = await freshDir("ws-unbound");
    await expect(getSelection(workspace, workspace)).rejects.toThrow(/尚未绑定 agent/);
  });
});

/* ------------------------------------------------------------ 视觉探针 */

/**
 * 假上游：**真的把图片解开看颜色**（不比对 base64 —— 详见 tests/support/png.ts 的说明），
 * 这是「一个能看图的模型」在测试里的替身。判分逻辑因此被真实地走了一遍，
 * 而不是把 probe 函数的返回值 mock 掉。
 */
function fakeVisionAnswer(body: string): string {
  const decoded = decodeFirstPngFromBody(body);
  const color = nearestProbeColor(decoded.pixels[0]!);
  // 顺带验证：生成的确实是「纯色方块」，不是花图
  for (const pixel of decoded.pixels) {
    expect([...pixel]).toEqual([...decoded.pixels[0]!]);
  }
  return `${color.label}色`;
}

interface FakeUpstream {
  url: string;
  calls: number;
  stop: () => void;
}

function startFakeUpstream(
  mode: "vision" | "blind" | "broken",
  options: { models?: string[] } = {},
): FakeUpstream {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({ data: (options.models ?? []).map((id) => ({ id })) });
      }
      calls += 1;
      if (mode === "broken") return new Response("boom", { status: 500 });
      const raw = await req.text();
      if (mode === "blind") {
        return Response.json({
          choices: [{ message: { role: "assistant", content: "抱歉，我无法查看图片。" } }],
        });
      }
      if (raw.includes("data:image/png")) {
        return Response.json({ choices: [{ message: { role: "assistant", content: fakeVisionAnswer(raw) } }] });
      }
      return Response.json({ choices: [{ message: { role: "assistant", content: "我不确定" } }] });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    get calls() {
      return calls;
    },
    stop: () => server.stop(true),
  };
}

describe("视觉探针端到端（对着假上游跑）", () => {
  test("看得见图的模型 → vision=true 且落盘 source=probe", async () => {
    await resetStore();
    const upstream = startFakeUpstream("vision");
    try {
      await upsertProvider({ kind: "custom", id: "fake", name: "假上游", baseUrl: upstream.url, apiKey: "sk-fake" });
      const result = await probeModelCapability("fake", "fake-vl");
      expect(result.vision).toBe(true);
      expect(result.correct).toBe(3);
      expect(result.persisted).toBe(true);

      const file = await readModelsFile(process.env);
      expect(file.capabilities[capabilityKey("fake", "fake-vl")]).toMatchObject({
        vision: true,
        source: "probe",
        failures: 0,
      });
    } finally {
      upstream.stop();
    }
  });

  test("看不见图的模型 → vision=false，并累加失败次数", async () => {
    await resetStore();
    const upstream = startFakeUpstream("blind");
    try {
      await upsertProvider({ kind: "custom", id: "fake", name: "假上游", baseUrl: upstream.url, apiKey: "sk-fake" });
      const result = await probeModelCapability("fake", "fake-text");
      expect(result.vision).toBe(false);
      expect(result.answered).toBe(3);
      expect(result.persisted).toBe(true);
      const file = await readModelsFile(process.env);
      expect(file.capabilities[capabilityKey("fake", "fake-text")]).toMatchObject({ vision: false, failures: 1 });
    } finally {
      upstream.stop();
    }
  });

  test("上游全挂时结论是 null 且**不写盘**（不把网络抖动固化成「不支持」）", async () => {
    await resetStore();
    const upstream = startFakeUpstream("broken");
    try {
      await upsertProvider({ kind: "custom", id: "fake", name: "假上游", baseUrl: upstream.url, apiKey: "sk-fake" });
      const result = await probeModelCapability("fake", "fake-flaky");
      expect(result.vision).toBeNull();
      expect(result.persisted).toBe(false);
      const file = await readModelsFile(process.env);
      expect(file.capabilities[capabilityKey("fake", "fake-flaky")]).toBeUndefined();
    } finally {
      upstream.stop();
    }
  });
});

/* ---------------------------------------------------------------- HTTP */

describe("HTTP：/models 契约", () => {
  test("GET /models 返回三家内置供应商且 key 掩码", async () => {
    await resetStore();
    const app = await loadApp();
    const res = await app.request("/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: { id: string; apiKeyMasked: string }[] };
    expect(body.providers.map((p) => p.id).sort()).toEqual(["ali-tokenplan", "aliyun", "deepseek"]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("sk-test-tokenplan");
  });

  test("POST /models/providers 非法 baseUrl → 400 + 可读字段", async () => {
    await resetStore();
    const app = await loadApp();
    const res = await app.request("/models/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "deepseek", baseUrl: "ftp://nope" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe("MODEL_INVALID_CONFIG");
    expect(body.field).toBe("baseUrl");
  });

  test("DELETE 内置供应商 → 409（不是 500）", async () => {
    await resetStore();
    const app = await loadApp();
    const res = await app.request("/models/providers/deepseek", { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MODEL_PROVIDER_LOCKED");
  });

  test("POST /models/providers/{id}/test 走通一次最小对话", async () => {
    await resetStore();
    const upstream = startFakeUpstream("vision", { models: ["qwen3-max"] });
    try {
      const app = await loadApp();
      await upsertProvider({ kind: "custom", id: "fake", name: "假上游", baseUrl: upstream.url, apiKey: "sk-fake" });
      const res = await app.request("/models/providers/fake/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: "fake-model" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; latencyMs: number };
      expect(body.ok).toBe(true);
      expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      upstream.stop();
    }
  });

  test("POST .../discover 拉远端清单并标出新增项（且不写盘）", async () => {
    await resetStore();
    const upstream = startFakeUpstream("vision", { models: ["zz-new-model"] });
    try {
      const app = await loadApp();
      await upsertProvider({ kind: "custom", id: "fake", name: "假上游", baseUrl: upstream.url, apiKey: "sk-fake" });
      const res = await app.request("/models/providers/fake/discover", { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; models: string[]; added: string[] };
      expect(body.ok).toBe(true);
      expect(body.models).toEqual(["zz-new-model"]);
      expect(body.added).toEqual(["zz-new-model"]);

      // 只读：磁盘上的清单没变
      const file = await readModelsFile(process.env);
      expect(file.providers.find((p) => p.id === "fake")!.models).toEqual([]);
    } finally {
      upstream.stop();
    }
  });

  test("没填 key 的供应商去测试 → 409 MODEL_NOT_CONFIGURED", async () => {
    await resetStore();
    const app = await loadApp();
    const res = await app.request("/models/providers/deepseek/test", { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MODEL_NOT_CONFIGURED");
  });

  test("GET /models/selection 需要工作区参数；未绑定 → 409", async () => {
    await resetStore();
    const app = await loadApp();
    expect((await app.request("/models/selection")).status).toBe(400);

    const workspace = await freshDir("ws-http-selection");
    const res = await app.request(`/models/selection?path=${encodeURIComponent(workspace)}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("AGENT_NOT_BOUND");
  });

  test("PUT /models/selection 落盘后 GET 看得到", async () => {
    await resetStore();
    await upsertProvider({ id: "aliyun", apiKey: "sk-dashscope-abcdef" });
    await createAgent({ id: "http-picker" });
    const workspace = await freshDir("ws-http-pick");
    await writeBinding(workspace, "http-picker", { mode: "keep", reason: "user" });

    const app = await loadApp();
    const put = await app.request("/models/selection", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: workspace, providerId: "aliyun", modelId: "qwen-plus" }),
    });
    expect(put.status).toBe(200);

    const get = await app.request(`/models/selection?path=${encodeURIComponent(workspace)}`);
    const body = (await get.json()) as { effective: { providerId: string; modelId: string; vision: boolean | null } };
    expect(body.effective.providerId).toBe("aliyun");
    expect(body.effective.modelId).toBe("qwen-plus");
    expect(body.effective.vision).toBe(false);
  });

  test("PUT /models/capability 手动指定后总览里看得见", async () => {
    await resetStore();
    const app = await loadApp();
    const res = await app.request("/models/capability", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "ali-tokenplan", modelId: "deepseek-v4.1-flash", vision: true }),
    });
    expect(res.status).toBe(200);

    const overview = await getOverview();
    const model = overview.models.find((m) => m.id === "deepseek-v4.1-flash")!;
    expect(model.vision).toBe(true);
    expect(model.visionSource).toBe("manual");
  });

  test("PUT /models/default 需要一个存在且启用的供应商", async () => {
    await resetStore();
    await expect(setDefaultModel("nope", "x")).rejects.toThrow(ModelError);
    await setDefaultModel("aliyun", "qwen3-max");
    const overview = await getOverview();
    expect(overview.defaults).toEqual({ providerId: "aliyun", modelId: "qwen3-max" });
  });
});
