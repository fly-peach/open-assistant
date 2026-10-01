/**
 * 频道服务层测试（tasks 13.1–13.8 的组合视图）——
 * 界面/HTTP 直接消费的就是这一层，重点验证「掩码 + 必填缺失解释 + 两分区」。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  CHANNEL_SECRETS_ENV,
  channelFieldsFor,
  deleteChannelView,
  enabledChannels,
  listChannelViews,
  missingRequiredFields,
  upsertChannelView,
} from "../src/channels/index.js";

let root = "";
let counter = 0;
const originalEnv = process.env[CHANNEL_SECRETS_ENV];

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-chsvc-")));
  process.env[CHANNEL_SECRETS_ENV] = path.join(root, "secrets.json");
});
afterAll(async () => {
  if (originalEnv === undefined) delete process.env[CHANNEL_SECRETS_ENV];
  else process.env[CHANNEL_SECRETS_ENV] = originalEnv;
  await fs.rm(root, { recursive: true, force: true });
});

async function freshAgent(name: string): Promise<string> {
  counter += 1;
  const dir = path.join(root, `${name}-${counter}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("频道视图：已配置 / 可添加两分区", () => {
  test("初始：configured 空，available 含 QQ 与飞书", async () => {
    const dir = await freshAgent("views-init");
    const { configured, available } = await listChannelViews("agent-v1", dir);
    expect(configured).toEqual([]);
    expect(available.map((a) => a.key).sort()).toEqual(["feishu", "qq"]);
    expect(available.every((a) => a.enabled === false)).toBe(true);
  });

  test("添加后从 available 移到 configured", async () => {
    const dir = await freshAgent("views-move");
    await upsertChannelView("agent-v2", dir, "qq", { config: { app_id: "1" } });
    const { configured, available } = await listChannelViews("agent-v2", dir);
    expect(configured.map((c) => c.key)).toEqual(["qq"]);
    expect(available.map((a) => a.key)).toEqual(["feishu"]);
  });

  test("视图带标签/图标/内置标记，供卡片渲染", async () => {
    const dir = await freshAgent("views-card");
    const view = await upsertChannelView("agent-v3", dir, "feishu", { config: { app_id: "cli_x" } });
    expect(view.label).toBe("飞书");
    expect(view.icon).toBe("feishu");
    expect(view.builtin).toBe(true);
    expect(view.config["domain"]).toBe("feishu"); // 默认值已补齐
  });
});

describe("凭据只回掩码", () => {
  test("配置回掩码，不回明文", async () => {
    const dir = await freshAgent("views-mask");
    const view = await upsertChannelView("agent-v4", dir, "qq", {
      config: { app_id: "1" },
      secrets: { client_secret: "abcdefghijkl" },
    });
    expect(view.secrets["client_secret"]).toContain("已设置");
    expect(view.secrets["client_secret"]).not.toContain("abcdefgh");
    // 整个视图序列化后也不该出现明文
    expect(JSON.stringify(view)).not.toContain("abcdefghijkl");
  });

  test("空串表示清除凭据，视图随之变为未设置", async () => {
    const dir = await freshAgent("views-clear");
    await upsertChannelView("agent-v5", dir, "qq", { secrets: { client_secret: "xyz123456789" } });
    const cleared = await upsertChannelView("agent-v5", dir, "qq", { secrets: { client_secret: "" } });
    expect(cleared.secrets["client_secret"]).toBe("");
  });

  test("不传 secrets 时不动原值", async () => {
    const dir = await freshAgent("views-keep");
    await upsertChannelView("agent-v6", dir, "qq", { secrets: { client_secret: "keepme12345" } });
    const after = await upsertChannelView("agent-v6", dir, "qq", { config: { bot_prefix: "A" } });
    expect(after.secrets["client_secret"]).toContain("已设置");
  });
});

describe("必填缺失要能解释", () => {
  test("缺凭据与缺非凭据字段都被列出", () => {
    const missing = missingRequiredFields("qq", { app_id: "" }, {});
    expect(missing.sort()).toEqual(["app_id", "client_secret"]);
    expect(missingRequiredFields("qq", { app_id: "1" }, { client_secret: "s" })).toEqual([]);
  });

  test("视图里的 missing 随配置补齐而减少", async () => {
    const dir = await freshAgent("views-missing");
    const before = await upsertChannelView("agent-v7", dir, "qq", {});
    expect(before.missing.length).toBeGreaterThan(0);
    const after = await upsertChannelView("agent-v7", dir, "qq", {
      config: { app_id: "1" },
      secrets: { client_secret: "s" },
    });
    expect(after.missing).toEqual([]);
  });

  test("必填没齐时启用会被拒（错误指出字段）", async () => {
    const dir = await freshAgent("views-enable");
    await expect(upsertChannelView("agent-v8", dir, "qq", { enabled: true, config: { app_id: "1" } })).rejects.toThrow();
  });
});

describe("字段定义与运行时", () => {
  test("界面能拿到字段定义（按它渲染表单）", () => {
    const fields = channelFieldsFor("feishu");
    expect(fields.map((f) => f.key)).toContain("app_secret");
    expect(fields.every((f) => typeof f.label === "string" && f.label.length > 0)).toBe(true);
    // 目录外的频道也有一组公共字段
    expect(channelFieldsFor("whatever").length).toBeGreaterThan(0);
  });

  test("enabledChannels 只返回启用的且必填齐全的", async () => {
    const dir = await freshAgent("views-enabled");
    await upsertChannelView("agent-v9", dir, "qq", {
      enabled: true,
      config: { app_id: "1" },
      secrets: { client_secret: "s" },
    });
    await upsertChannelView("agent-v9", dir, "feishu", { config: { app_id: "cli_x" } }); // 未启用
    const enabled = await enabledChannels("agent-v9", dir);
    expect(enabled.map((e) => e.key)).toEqual(["qq"]);

    // 启用后把配置改坏（模拟人工改文件）→ 运行时不再返回它
    await fs.writeFile(
      path.join(dir, "channels.json"),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        channels: [{ key: "qq", enabled: true, config: { app_id: "" }, updatedAt: "" }],
      }),
      "utf8",
    );
    expect(await enabledChannels("agent-v9", dir)).toEqual([]);
  });

  test("删除频道同时清掉凭据（不留悬空凭据）", async () => {
    const dir = await freshAgent("views-delete");
    await upsertChannelView("agent-v10", dir, "qq", { secrets: { client_secret: "gone1234567" } });
    expect(await deleteChannelView("agent-v10", dir, "qq")).toBe(true);
    const { configured, available } = await listChannelViews("agent-v10", dir);
    expect(configured).toEqual([]);
    expect(available.map((a) => a.key).sort()).toEqual(["feishu", "qq"]);

    // 重新添加同一频道 → 凭据应该已经是空的（被清掉了）
    const readded = await upsertChannelView("agent-v10", dir, "qq", {});
    expect(readded.secrets["client_secret"]).toBe("");
  });
});