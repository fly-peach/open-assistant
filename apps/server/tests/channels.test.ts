/**
 * 频道模块测试（tasks 13.1–13.6）。
 *
 * 重点覆盖三条最容易做错的：
 * - **凭据既不落工作区也不落 agent 目录**（两处都会被整个复制分享）
 * - **配置损坏时报错而不当成空**（否则下一次写入会覆盖用户配置）
 * - **非法取值当场拒绝并指出字段**（而不是运行期才炸）
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  CHANNEL_SECRETS_ENV,
  ChannelError,
  builtinChannelKeys,
  channelCatalogEntry,
  channelSecretsPath,
  channelsPath,
  clearChannelSecrets,
  defaultConfigFor,
  findChannel,
  hasSecret,
  humanizeChannelKey,
  isBuiltinChannel,
  maskSecret,
  maskedSecretsView,
  readChannelSecrets,
  readChannelsFile,
  removeChannel,
  secretFieldsOf,
  upsertChannel,
  validateChannelInput,
  writeChannelSecrets,
} from "../src/channels/index.js";

let root = "";
let counter = 0;
const originalSecretsEnv = process.env[CHANNEL_SECRETS_ENV];

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-ch-")));
  // 凭据库指到临时目录，避免污染真实 HOME
  process.env[CHANNEL_SECRETS_ENV] = path.join(root, "channel-secrets.json");
});
afterAll(async () => {
  if (originalSecretsEnv === undefined) delete process.env[CHANNEL_SECRETS_ENV];
  else process.env[CHANNEL_SECRETS_ENV] = originalSecretsEnv;
  await fs.rm(root, { recursive: true, force: true });
});

async function freshAgent(name: string): Promise<string> {
  counter += 1;
  const dir = path.join(root, `${name}-${counter}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("13.1 频道目录", () => {
  test("首发包含 QQ 与飞书", () => {
    expect(builtinChannelKeys()).toContain("qq");
    expect(builtinChannelKeys()).toContain("feishu");
    expect(isBuiltinChannel("qq")).toBe(true);
    expect(isBuiltinChannel("feishu")).toBe(true);
  });

  test("目录之外的频道不被拒绝，按键名生成可读名", () => {
    const entry = channelCatalogEntry("my-custom-bot");
    expect(entry.builtin).toBe(false);
    expect(entry.label).toBe("My Custom Bot");
    expect(isBuiltinChannel("my-custom-bot")).toBe(false);
    expect(humanizeChannelKey("we_com_bot")).toBe("We Com Bot");
    expect(humanizeChannelKey("")).toBe("");
  });

  test("目录外频道仍带公共字段（界面能渲染表单）", () => {
    const entry = channelCatalogEntry("whatever");
    expect(entry.fields.length).toBeGreaterThan(0);
    expect(entry.fields.map((f) => f.key)).toContain("bot_prefix");
  });

  test("图标标识存在（供界面区分）", () => {
    expect(channelCatalogEntry("qq").icon).toBe("qq");
    expect(channelCatalogEntry("feishu").icon).toBe("feishu");
  });
});

describe("13.2 字段类型系统与公共字段", () => {
  test("公共字段齐全", () => {
    const keys = channelCatalogEntry("qq").fields.map((f) => f.key);
    for (const expected of [
      "bot_prefix",
      "show_thinking",
      "show_tool_calls",
      "show_tool_results",
      "tool_call_max_length",
      "tool_result_max_length",
      "dm_policy",
      "group_policy",
      "require_mention",
      "streaming_enabled",
    ]) {
      expect(keys).toContain(expected);
    }
  });

  test("字段都有控件类型与中文标签", () => {
    for (const field of channelCatalogEntry("feishu").fields) {
      expect(["text", "password", "number", "switch", "select"]).toContain(field.type);
      expect(field.label.length).toBeGreaterThan(0);
    }
  });

  test("select 字段有候选项；number 字段有范围", () => {
    const dm = channelCatalogEntry("qq").fields.find((f) => f.key === "dm_policy")!;
    expect(dm.options?.map((o) => o.value).sort()).toEqual(["allowlist", "open"]);
    const maxLen = channelCatalogEntry("qq").fields.find((f) => f.key === "tool_call_max_length")!;
    expect(maxLen.min).toBeGreaterThan(0);
    expect(maxLen.max).toBeGreaterThan(maxLen.min!);
  });

  test("默认配置只含非敏感字段", () => {
    const defaults = defaultConfigFor(channelCatalogEntry("feishu"));
    expect(defaults["domain"]).toBe("feishu");
    expect(defaults["media_dir"]).toBe("media");
    expect(Object.keys(defaults)).not.toContain("app_secret");
    expect(Object.keys(defaults)).not.toContain("encrypt_key");
  });

  test("非法取值被拒且指出字段", () => {
    const entry = channelCatalogEntry("qq");
    expect(() => validateChannelInput(entry, { dm_policy: "sometimes" })).toThrow(ChannelError);
    try {
      validateChannelInput(entry, { dm_policy: "sometimes" });
    } catch (err) {
      expect((err as ChannelError).code).toBe("CHANNEL_INVALID_FIELD");
      expect((err as ChannelError).field).toBe("dm_policy");
      expect((err as ChannelError).message).toContain("私聊策略");
    }
    expect(() => validateChannelInput(entry, { tool_call_max_length: 1 })).toThrow();
    expect(() => validateChannelInput(entry, { tool_call_max_length: 999999 })).toThrow();
    expect(() => validateChannelInput(entry, { tool_call_max_length: "abc" })).toThrow();
    expect(() => validateChannelInput(entry, { show_thinking: "maybe" })).toThrow();
  });

  test("字段表之外的键被忽略", () => {
    const res = validateChannelInput(channelCatalogEntry("qq"), { 未来的字段: "x", bot_prefix: "AI" });
    expect(Object.keys(res.config)).not.toContain("未来的字段");
    expect(res.config["bot_prefix"]).toBe("AI");
  });

  test("switch 接受布尔与字符串两种写法", () => {
    expect(validateChannelInput(channelCatalogEntry("qq"), { show_thinking: true }).config["show_thinking"]).toBe(true);
    expect(validateChannelInput(channelCatalogEntry("qq"), { show_thinking: "true" }).config["show_thinking"]).toBe(true);
    expect(validateChannelInput(channelCatalogEntry("qq"), { show_thinking: "false" }).config["show_thinking"]).toBe(false);
  });
});

describe("13.3 QQ 与飞书的特有字段", () => {
  test("QQ：应用标识 / 客户端密钥（凭据）/ 确认话术", () => {
    const entry = channelCatalogEntry("qq");
    expect(secretFieldsOf(entry).map((f) => f.key)).toEqual(["client_secret"]);
    const appId = entry.fields.find((f) => f.key === "app_id")!;
    expect(appId.required).toBe(true);
    expect(entry.fields.find((f) => f.key === "ack_message")?.default).toBe("收到，正在处理…");
  });

  test("飞书：应用标识 / 应用密钥（凭据）/ 校验凭据（凭据）/ 媒体目录 / 域名切换", () => {
    const entry = channelCatalogEntry("feishu");
    const secrets = secretFieldsOf(entry).map((f) => f.key).sort();
    expect(secrets).toEqual(["app_secret", "encrypt_key", "verification_token"]);
    const domain = entry.fields.find((f) => f.key === "domain")!;
    expect(domain.options?.map((o) => o.value).sort()).toEqual(["feishu", "lark"]);
    expect(entry.fields.find((f) => f.key === "media_dir")?.default).toBe("media");
  });

  test("凭据字段标记为 secret 且必填情况正确", () => {
    const feishu = channelCatalogEntry("feishu");
    const appSecret = feishu.fields.find((f) => f.key === "app_secret")!;
    expect(appSecret.secret).toBe(true);
    expect(appSecret.required).toBe(true);
    const encryptKey = feishu.fields.find((f) => f.key === "encrypt_key")!;
    expect(encryptKey.secret).toBe(true);
    expect(encryptKey.required).toBeUndefined(); // 长连接方式不需要
  });
});

describe("13.4 频道配置的存取", () => {
  test("写入后读回，落在 agent 定义目录内的 channels.json", async () => {
    const dir = await freshAgent("store");
    const { instance } = await upsertChannel(dir, "qq", {
      input: { app_id: "1024", bot_prefix: "小助", dm_policy: "allowlist" },
    });
    expect(instance.key).toBe("qq");
    expect(instance.enabled).toBe(false);

    const file = await readChannelsFile(dir);
    expect(file.channels).toHaveLength(1);
    expect(findChannel(file, "qq")?.config["app_id"]).toBe("1024");
    expect(await fs.stat(channelsPath(dir)).then((s) => s.isFile())).toBe(true);
    // 默认值被补齐
    expect(findChannel(file, "qq")?.config["group_policy"]).toBe("allowlist");
  });

  test("损坏的文件报错而不当成空", async () => {
    const dir = await freshAgent("corrupt");
    await fs.writeFile(channelsPath(dir), "{ 这不是 JSON", "utf8");
    await expect(readChannelsFile(dir)).rejects.toThrow(ChannelError);
    try {
      await readChannelsFile(dir);
    } catch (err) {
      expect((err as ChannelError).code).toBe("CHANNELS_FILE_CORRUPT");
    }
    // 且不会被覆盖
    expect(await fs.readFile(channelsPath(dir), "utf8")).toBe("{ 这不是 JSON");
  });

  test("结构不对（缺 channels 数组）也算损坏", async () => {
    const dir = await freshAgent("corrupt2");
    await fs.writeFile(channelsPath(dir), JSON.stringify({ version: 1 }), "utf8");
    await expect(readChannelsFile(dir)).rejects.toThrow();
  });

  test("文件不存在视为「没接任何频道」", async () => {
    const dir = await freshAgent("missing");
    const file = await readChannelsFile(dir);
    expect(file.channels).toEqual([]);
  });

  test("更新是合并而非覆盖：只改传入的字段", async () => {
    const dir = await freshAgent("merge");
    await upsertChannel(dir, "qq", { input: { app_id: "1", bot_prefix: "A" } });
    await upsertChannel(dir, "qq", { input: { bot_prefix: "B" } });
    const file = await readChannelsFile(dir);
    const cfg = findChannel(file, "qq")!.config;
    expect(cfg["bot_prefix"]).toBe("B");
    expect(cfg["app_id"]).toBe("1"); // 没被清掉
  });

  test("删除频道", async () => {
    const dir = await freshAgent("remove");
    await upsertChannel(dir, "qq", { input: { app_id: "1" } });
    expect(await removeChannel(dir, "qq")).toBe(true);
    expect((await readChannelsFile(dir)).channels).toEqual([]);
    expect(await removeChannel(dir, "qq")).toBe(false);
  });

  test("配置跟着 agent 走：换个工作区引用同一个 agent 目录，配置仍在", async () => {
    const agentDir = await freshAgent("agent-owned");
    await upsertChannel(agentDir, "feishu", { input: { app_id: "cli_x", domain: "lark" } });
    // 模拟「换绑到另一个工作区」：agent 目录没变，读出来还是同一份
    const again = await readChannelsFile(agentDir);
    expect(findChannel(again, "feishu")?.config["domain"]).toBe("lark");
    expect(findChannel(again, "feishu")?.config["app_id"]).toBe("cli_x");
  });
});

describe("13.5 / 13.6 凭据：不落两处 + 掩码", () => {
  test("凭据库在用户主目录侧，不在 agent 目录也不在工作区", async () => {
    const agentDir = await freshAgent("secrets-loc");
    const workspaceDir = await freshAgent("secrets-ws");
    await upsertChannel(agentDir, "qq", { input: { app_id: "1" } });
    await writeChannelSecrets("agent-a", "qq", { client_secret: "super-secret-value" });

    expect(channelSecretsPath()).toBe(process.env[CHANNEL_SECRETS_ENV]!);
    // 两处目录里都不该出现明文
    for (const dir of [agentDir, workspaceDir]) {
      const files = await fs.readdir(dir);
      for (const f of files) {
        const full = path.join(dir, f);
        if ((await fs.stat(full)).isFile()) {
          expect(await fs.readFile(full, "utf8")).not.toContain("super-secret-value");
        }
      }
    }
  });

  test("只写传入的凭据键，其余保留；空串表示清除", async () => {
    await writeChannelSecrets("agent-b", "feishu", { app_secret: "s1", verification_token: "t1" });
    await writeChannelSecrets("agent-b", "feishu", { app_secret: "s2" });
    let secrets = await readChannelSecrets("agent-b", "feishu");
    expect(secrets["app_secret"]).toBe("s2");
    expect(secrets["verification_token"]).toBe("t1");

    await writeChannelSecrets("agent-b", "feishu", { verification_token: "" });
    secrets = await readChannelSecrets("agent-b", "feishu");
    expect(hasSecret(secrets, "verification_token")).toBe(false);
    expect(secrets["app_secret"]).toBe("s2");
  });

  test("清理：按频道清 / 按 agent 清", async () => {
    await writeChannelSecrets("agent-c", "qq", { client_secret: "x" });
    await writeChannelSecrets("agent-c", "feishu", { app_secret: "y" });
    await clearChannelSecrets("agent-c", "qq");
    expect(await readChannelSecrets("agent-c", "qq")).toEqual({});
    expect((await readChannelSecrets("agent-c", "feishu"))["app_secret"]).toBe("y");
    await clearChannelSecrets("agent-c");
    expect(await readChannelSecrets("agent-c", "feishu")).toEqual({});
  });

  test("掩码：短值只说已设置，长值只露尾 4 位", () => {
    expect(maskSecret("")).toBe("");
    expect(maskSecret("abc")).toBe("已设置");
    expect(maskSecret("12345678")).toBe("已设置");
    expect(maskSecret("abcdefghijkl")).toBe("已设置（…ijkl）");
    expect(maskSecret("abcdefghijkl")).not.toContain("abcdefgh");
  });

  test("掩码视图只输出凭据字段的已设置/未设置", () => {
    const view = maskedSecretsView(
      ["app_secret", "encrypt_key"],
      { app_secret: "abcdefghijkl" },
    );
    expect(view["app_secret"]).toContain("已设置");
    expect(view["app_secret"]).not.toContain("abcdefgh");
    expect(view["encrypt_key"]).toBe("");
  });

  test("凭据文件损坏时按空处理，不阻断读取", async () => {
    await fs.writeFile(process.env[CHANNEL_SECRETS_ENV]!, "{ broken", "utf8");
    expect(await readChannelSecrets("agent-x", "qq")).toEqual({});
  });
});

describe("13.7 启用前的必填校验", () => {
  test("启用时缺必填凭据 → 拒绝并指出字段", async () => {
    const dir = await freshAgent("enable-missing");
    await expect(upsertChannel(dir, "qq", { enabled: true, input: { app_id: "1" } })).rejects.toThrow(
      ChannelError,
    );
    try {
      await upsertChannel(dir, "qq", { enabled: true, input: { app_id: "1" } });
    } catch (err) {
      expect((err as ChannelError).field).toBe("client_secret");
      expect((err as ChannelError).code).toBe("CHANNEL_MISSING_FIELD");
    }
  });

  test("启用时缺必填的非凭据字段 → 拒绝并指出字段", async () => {
    const dir = await freshAgent("enable-missing2");
    await expect(
      upsertChannel(dir, "qq", { enabled: true, existingSecrets: { client_secret: "s" } }),
    ).rejects.toThrow();
  });

  test("凭据已在库里时，只改非敏感字段也能启用", async () => {
    const dir = await freshAgent("enable-ok");
    const { instance } = await upsertChannel(dir, "qq", {
      enabled: true,
      input: { app_id: "1" },
      existingSecrets: { client_secret: "s" },
    });
    expect(instance.enabled).toBe(true);
  });

  test("不启用时允许缺凭据（可以先填一半再保存）", async () => {
    const dir = await freshAgent("draft");
    const { instance } = await upsertChannel(dir, "feishu", { input: { app_id: "cli_x" } });
    expect(instance.enabled).toBe(false);
  });

  test("凭据不进 channels.json", async () => {
    const dir = await freshAgent("no-secret-in-file");
    await upsertChannel(dir, "qq", {
      input: { app_id: "1", client_secret: "TOP-SECRET" },
      existingSecrets: { client_secret: "TOP-SECRET" },
    });
    expect(await fs.readFile(channelsPath(dir), "utf8")).not.toContain("TOP-SECRET");
  });
});