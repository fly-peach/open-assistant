/**
 * 上下文窗口（`contextWindow`）：解析优先级、手工指定，以及压缩阈值换算。
 *
 * 背景：上下文压缩的阈值以前来自 deepagents 的「模型 profile」，而我们的自定义模型没有
 * profile（`profile: {}`）→ 退化成写死的 170k。现在改为按**我们配置的窗口**算：
 * 触发 0.8×、保留 0.1×。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { AGENTS_ROOT_ENV } from "../src/agents/root.js";
import { clearAgentRuntimeCache, createAgent } from "../src/agents/registry.js";
import { writeBinding } from "../src/binding.js";
import { invalidateModelResolution } from "../src/models/middleware.js";
import {
  MODELS_FILE_ENV,
  readModelsFile,
  seedModelsFile,
  writeModelsFile,
} from "../src/models/store.js";
import { contextWindowFor, listModelViews, resolveEffectiveModel } from "../src/models/resolve.js";
import { setModelContextWindow } from "../src/models/index.js";
import { compactionThresholds } from "../src/models/compaction.js";

process.env.OPEN_ASSISTANT_DISABLE_MIGRATION = "1";

let root: string;
let modelsFile: string;
let workspace: string;
const original = {
  agents: process.env[AGENTS_ROOT_ENV],
  models: process.env[MODELS_FILE_ENV],
  MODEL_ID: process.env["MODEL_ID"],
  MODEL_BASE_URL: process.env["MODEL_BASE_URL"],
  MODEL_API_KEY: process.env["MODEL_API_KEY"],
};

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-cw-")));
  process.env[AGENTS_ROOT_ENV] = path.join(root, "agents");
  modelsFile = path.join(root, "models.json");
  process.env[MODELS_FILE_ENV] = modelsFile;
  process.env["MODEL_ID"] = "deepseek-v4.1-flash";
  process.env["MODEL_BASE_URL"] = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
  process.env["MODEL_API_KEY"] = "sk-test-1234567890";
  await writeModelsFile(seedModelsFile(process.env));
  workspace = await fs.realpath(await fs.mkdtemp(path.join(root, "ws-")));
  await createAgent({ id: "life", name: "生活管家" });
  await writeBinding(workspace, "life");
});

afterAll(async () => {
  for (const [key, value] of Object.entries(original)) {
    const envKey = key === "agents" ? AGENTS_ROOT_ENV : key === "models" ? MODELS_FILE_ENV : key;
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
  clearAgentRuntimeCache();
  invalidateModelResolution();
  await fs.rm(root, { recursive: true, force: true });
});

describe("compactionThresholds（纯函数）", () => {
  test("0.8 触发 / 0.1 保留；窗口未知 → null（不猜）", () => {
    expect(compactionThresholds(128_000)).toEqual({ trigger: 102_400, keep: 12_800 });
    expect(compactionThresholds(65_536)).toEqual({ trigger: 52_428, keep: 6_553 });
    expect(compactionThresholds(null)).toBeNull();
    expect(compactionThresholds(undefined)).toBeNull();
    expect(compactionThresholds(0)).toBeNull();
    expect(compactionThresholds(-1)).toBeNull();
  });
});

describe("contextWindow 解析：manual > catalog > unknown", () => {
  test("内置先验：deepseek-chat = 65536（catalog）", () => {
    const file = seedModelsFile(process.env);
    expect(contextWindowFor(file, "deepseek", "deepseek-chat")).toEqual({
      contextWindow: 65_536,
      source: "catalog",
    });
  });

  test("没有先验的模型 → 未知（token-plan 的 deepseek-v4.1-flash）", async () => {
    const file = await readModelsFile();
    expect(contextWindowFor(file, "ali-tokenplan", "deepseek-v4.1-flash")).toEqual({
      contextWindow: null,
      source: "unknown",
    });
  });

  test("手工指定优先于内置先验；清除后回落", async () => {
    await setModelContextWindow("ali-tokenplan", "deepseek-v4.1-flash", 131_072);
    let file = await readModelsFile();
    expect(contextWindowFor(file, "ali-tokenplan", "deepseek-v4.1-flash")).toEqual({
      contextWindow: 131_072,
      source: "manual",
    });
    // 覆盖内置先验
    await setModelContextWindow("deepseek", "deepseek-chat", 32_768);
    file = await readModelsFile();
    expect(contextWindowFor(file, "deepseek", "deepseek-chat")).toEqual({
      contextWindow: 32_768,
      source: "manual",
    });
    // 清除 → 回到内置先验
    await setModelContextWindow("deepseek", "deepseek-chat", null);
    file = await readModelsFile();
    expect(contextWindowFor(file, "deepseek", "deepseek-chat")).toEqual({
      contextWindow: 65_536,
      source: "catalog",
    });
  });

  test("非法窗口被拒", async () => {
    await expect(setModelContextWindow("ali-tokenplan", "deepseek-v4.1-flash", -5)).rejects.toThrow();
    await expect(setModelContextWindow("ali-tokenplan", "deepseek-v4.1-flash", Number.NaN)).rejects.toThrow();
  });
});

describe("解析链与列表都带上窗口", () => {
  test("resolveEffectiveModel 返回窗口（当前生效的是手工指定的那个）", async () => {
    await writeModelsFile(seedModelsFile(process.env));
    await setModelContextWindow("ali-tokenplan", "deepseek-v4.1-flash", 200_000);
    invalidateModelResolution();
    const resolved = await resolveEffectiveModel(workspace);
    expect(resolved?.modelId).toBe("deepseek-v4.1-flash");
    expect(resolved?.contextWindow).toBe(200_000);
    expect(compactionThresholds(resolved?.contextWindow)).toEqual({
      trigger: 160_000,
      keep: 20_000,
    });
  });

  test("listModelViews 每条都带 contextWindow + 来源", async () => {
    const file = await readModelsFile();
    const views = listModelViews(file);
    const chat = views.find((v) => v.providerId === "deepseek" && v.id === "deepseek-chat");
    expect(chat?.contextWindow).toBe(65_536);
    expect(chat?.contextWindowSource).toBe("catalog");
    const flash = views.find((v) => v.id === "deepseek-v4.1-flash");
    expect(flash?.contextWindow).toBe(200_000);
    expect(flash?.contextWindowSource).toBe("manual");
  });
});