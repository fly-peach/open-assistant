/**
 * tasks 9.1–9.8：工作区初始化（显式动作 / 幂等 / 不覆盖）+ 首次引导 + 人设保护。
 *
 * 验证策略：
 * - 9.1 / 9.3 / 9.4 / 9.5：直接打 HTTP 路由（与前端同一份契约）或 workspace 纯函数；
 * - 9.6 / 9.7 / 9.8：用**生产用的同一份中间件** + 脚本化假模型跑真实 graph 会话，
 *   断言「本次发给模型的消息」「工具调用拦截结果」与磁盘上的文件，
 *   真实模型端的验证见 scripts/probe-bootstrap.ts。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { createDeepAgent, FilesystemBackend } from "deepagents";

import {
  BOOTSTRAP_FILE,
  BOOTSTRAP_FLAG_FILE,
  PERSONA_FILE,
  ensureWorkspace,
  initWorkspace,
  readWorkspaceInitStatus,
  workspaceBootstrapFlagPath,
} from "../src/workspace.js";
import { BOOTSTRAP_CONTENT, PERSONA_CONTENT, WORKSPACE_MATERIALS } from "../src/workspace-materials.js";
import {
  BOOTSTRAP_GUIDANCE,
  isFirstUserInteraction,
  prependGuidance,
} from "../src/bootstrap.js";
import { isPersonaPath, workspaceMiddleware } from "../src/workspace-middleware.js";
import { todoTools } from "../src/todo-tools.js";
import { personaTools } from "../src/persona-tools.js";

process.env.OPEN_ASSISTANT_DISABLE_MIGRATION = "1";

let root: string;
let counter = 0;

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-init-")));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function freshDir(name: string): Promise<string> {
  counter += 1;
  const p = path.join(root, `${name}-${counter}`);
  await fs.mkdir(p, { recursive: true });
  return p;
}

/** 递归快照目录内容（含隐藏文件） */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        result[`${rel}/`] = "";
        await walk(full, rel);
      } else {
        result[rel] = await fs.readFile(full, "utf8");
      }
    }
  }
  await walk(dir, "");
  return result;
}

async function loadApp() {
  return (await import("../src/http.js")).app;
}

// —— 脚本化假模型：记录每次「发给模型的消息」，并按脚本返回 AIMessage ——

class ScriptedChatModel extends BaseChatModel {
  /** 每次 _generate 收到的消息（第 0 条是系统消息） */
  readonly calls: BaseMessage[][] = [];
  private readonly script: AIMessage[];

  constructor(script: AIMessage[]) {
    super({});
    this.script = [...script];
  }

  _llmType(): string {
    return "scripted";
  }

  bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const next = this.script.length > 1 ? (this.script.shift() as AIMessage) : this.script[0]!;
    return {
      generations: [
        { text: typeof next.content === "string" ? next.content : "", message: next },
      ],
    };
  }
}

/** 用生产中间件 + 假模型建一个同构 graph（只差模型） */
function makeFakeAgent(workspace: string, script: AIMessage[]) {
  const model = new ScriptedChatModel(script);
  const graph = createDeepAgent({
    model,
    systemPrompt: "内置默认人设",
    tools: [...todoTools, ...personaTools],
    backend: () => new FilesystemBackend({ rootDir: workspace, virtualMode: true }),
    middleware: [workspaceMiddleware],
  });
  return { graph, model };
}

/** 模拟「引导已触发」：写防重标记（与应用数据子目录共存） */
async function markBootstrapTriggered(dir: string): Promise<void> {
  const flag = workspaceBootstrapFlagPath(dir);
  await fs.mkdir(path.dirname(flag), { recursive: true });
  await fs.writeFile(flag, "x", "utf8");
}

function toolCall(name: string, args: Record<string, unknown>, id = "call-1") {
  return new AIMessage({ content: "", tool_calls: [{ name, args, id }] });
}

function userMessage(content: string) {
  return { type: "human" as const, content };
}

describe("9.1 选定目录时不自动写入任何文件（HTTP）", () => {
  test("POST /workspace：空目录保持不变", async () => {
    const app = await loadApp();
    const dir = await freshDir("select-empty");
    const before = await snapshotTree(dir);
    const res = await app.request("/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    expect(res.status).toBe(200);
    expect(await snapshotTree(dir)).toEqual(before);
    expect(await snapshotTree(dir)).toEqual({});
    expect(await fs.readdir(dir)).toEqual([]);
  });

  test("POST /workspace：含用户文件的目录一个字节不变", async () => {
    const app = await loadApp();
    const dir = await freshDir("select-nonempty");
    await fs.writeFile(path.join(dir, "notes.md"), "# 我的笔记", "utf8");
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub", "a.txt"), "a", "utf8");
    const before = await snapshotTree(dir);

    await app.request("/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    // 状态查询也必须是只读的
    await app.request(`/workspace/status?path=${encodeURIComponent(dir)}`);

    const after = await snapshotTree(dir);
    expect(after).toEqual(before);
    expect(Object.keys(after)).not.toContain(PERSONA_FILE);
    expect(Object.keys(after)).not.toContain(BOOTSTRAP_FILE);
    expect(Object.keys(after)).not.toContain(".open-assistant/");
  });
});

describe("9.2 两件套物料", () => {
  test("AGENTS.md 是人设：中文、含 TODO 工具与工作区约束", () => {
    expect(PERSONA_CONTENT.length).toBeGreaterThan(200);
    expect(PERSONA_CONTENT).toContain("todo_create");
    expect(PERSONA_CONTENT).toContain("todos.json");
    expect(PERSONA_CONTENT).toContain("工作区");
    // 中文为主：不含大写英文占位模板
    expect(PERSONA_CONTENT).not.toContain("TODO:");
  });

  test("BOOTSTRAP.md 是第一人称剧本，且只指向 AGENTS.md", () => {
    expect(BOOTSTRAP_CONTENT).toContain("你刚醒过来");
    expect(BOOTSTRAP_CONTENT).toContain("BOOTSTRAP.md");
    expect(BOOTSTRAP_CONTENT).toContain(PERSONA_FILE);
    // 绝不引用三件套里的另外几个名字
    expect(BOOTSTRAP_CONTENT).not.toContain("PROFILE.md");
    expect(BOOTSTRAP_CONTENT).not.toContain("SOUL.md");
    expect(BOOTSTRAP_CONTENT).not.toContain("MEMORY.md");
    expect(PERSONA_CONTENT).not.toContain("SOUL.md");
  });

  test("物料文件名与 workspace 常量保持一致（防止两边改名字改漏）", () => {
    expect(WORKSPACE_MATERIALS.map((m) => m.name)).toEqual([PERSONA_FILE, BOOTSTRAP_FILE]);
  });

  test("引导指示本身不指向 PROFILE/SOUL/MEMORY，且要求读 BOOTSTRAP.md", () => {
    expect(BOOTSTRAP_GUIDANCE).toContain(BOOTSTRAP_FILE);
    expect(BOOTSTRAP_GUIDANCE).toContain(PERSONA_FILE);
    expect(BOOTSTRAP_GUIDANCE).not.toContain("MEMORY.md");
    expect(BOOTSTRAP_GUIDANCE).not.toContain("PROFILE.md");
  });
});

describe("9.3 初始化：幂等、只补缺失、不覆盖", () => {
  test("空目录首次初始化写入两件套；内容与物料一致", async () => {
    const dir = await freshDir("init-once");
    const res = await initWorkspace(dir);
    expect(res.path).toBe(await fs.realpath(dir));
    expect(res.created).toEqual([PERSONA_FILE, BOOTSTRAP_FILE]);
    expect(res.skipped).toEqual([]);
    expect(await fs.readFile(path.join(dir, PERSONA_FILE), "utf8")).toBe(PERSONA_CONTENT);
    expect(await fs.readFile(path.join(dir, BOOTSTRAP_FILE), "utf8")).toBe(BOOTSTRAP_CONTENT);
  });

  test("再次初始化：全部跳过，已存在的同名文件内容一个字都不变", async () => {
    const dir = await freshDir("init-idempotent");
    await initWorkspace(dir);
    // 用户手工改过两件套
    await fs.writeFile(path.join(dir, PERSONA_FILE), "# 我的人设：叫我小助\n", "utf8");
    await fs.writeFile(path.join(dir, BOOTSTRAP_FILE), "# 自定义引导\n", "utf8");

    const res = await initWorkspace(dir);
    expect(res.created).toEqual([]);
    expect(res.skipped).toEqual([PERSONA_FILE, BOOTSTRAP_FILE]);
    expect(await fs.readFile(path.join(dir, PERSONA_FILE), "utf8")).toBe("# 我的人设：叫我小助\n");
    expect(await fs.readFile(path.join(dir, BOOTSTRAP_FILE), "utf8")).toBe("# 自定义引导\n");
  });

  test("只缺一件时只补那一件（含用户已有目录不被删改）", async () => {
    const dir = await freshDir("init-partial");
    await fs.writeFile(path.join(dir, PERSONA_FILE), "# 已有的人设\n", "utf8");
    await fs.writeFile(path.join(dir, "我的笔记.md"), "别动我", "utf8");

    const res = await initWorkspace(dir);
    expect(res.created).toEqual([BOOTSTRAP_FILE]);
    expect(res.skipped).toEqual([PERSONA_FILE]);
    expect(await fs.readFile(path.join(dir, PERSONA_FILE), "utf8")).toBe("# 已有的人设\n");
    expect(await fs.readFile(path.join(dir, "我的笔记.md"), "utf8")).toBe("别动我");
  });

  test("HTTP POST /workspace/init 契约：{ path, created, skipped }", async () => {
    const app = await loadApp();
    const dir = await freshDir("init-http");
    const first = await app.request("/workspace/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { path: string; created: string[]; skipped: string[] };
    expect(body.path).toBe(await fs.realpath(dir));
    expect(body.created).toEqual([PERSONA_FILE, BOOTSTRAP_FILE]);
    expect(body.skipped).toEqual([]);

    const second = await app.request("/workspace/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    const body2 = (await second.json()) as { created: string[]; skipped: string[] };
    expect(body2.created).toEqual([]);
    expect(body2.skipped).toEqual([PERSONA_FILE, BOOTSTRAP_FILE]);

    const bad = await app.request("/workspace/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
  });
});

describe("9.4 初始化状态查询：区分两件套", () => {
  test("全缺 / 缺引导 / 齐全 三种情况", async () => {
    const app = await loadApp();

    const none = await freshDir("status-none");
    type S = {
      initialized: boolean;
      files: { agentsMd: boolean; bootstrapMd: boolean; bootstrapCompleted: boolean };
    };

    const s0 = (await (
      await app.request(`/workspace/status?path=${encodeURIComponent(none)}`)
    ).json()) as S;
    expect(s0).toEqual({
      initialized: false,
      files: { agentsMd: false, bootstrapMd: false, bootstrapCompleted: false },
    });

    // 只有人设 → 已初始化（人设就位即算初始化，见 workspace.ts 注释）
    const onlyAgent = await freshDir("status-agent");
    await fs.writeFile(path.join(onlyAgent, PERSONA_FILE), "# x", "utf8");
    const s1 = (await (
      await app.request(`/workspace/status?path=${encodeURIComponent(onlyAgent)}`)
    ).json()) as S;
    expect(s1).toEqual({
      initialized: true,
      files: { agentsMd: true, bootstrapMd: false, bootstrapCompleted: false },
    });

    // 只有引导文件 → 未初始化（还没有人设）
    const onlyBootstrap = await freshDir("status-bootstrap");
    await fs.writeFile(path.join(onlyBootstrap, BOOTSTRAP_FILE), "# x", "utf8");
    const s2 = (await (
      await app.request(`/workspace/status?path=${encodeURIComponent(onlyBootstrap)}`)
    ).json()) as S;
    expect(s2).toEqual({
      initialized: false,
      files: { agentsMd: false, bootstrapMd: true, bootstrapCompleted: false },
    });

    const both = await freshDir("status-both");
    await initWorkspace(both);
    const s3 = (await (
      await app.request(`/workspace/status?path=${encodeURIComponent(both)}`)
    ).json()) as S;
    expect(s3).toEqual({
      initialized: true,
      files: { agentsMd: true, bootstrapMd: true, bootstrapCompleted: false },
    });

    // 直接调用同样正确；不存在的路径 → 可读错误
    expect(await readWorkspaceInitStatus(both)).toEqual(s3);
    const missing = await app.request(
      `/workspace/status?path=${encodeURIComponent(path.join(root, "nope-status"))}`,
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("WORKSPACE_MISSING");
  });

  test("引导完成后仍视为已初始化，入口不得重新出现（防引导循环）", async () => {
    const app = await loadApp();
    const dir = await freshDir("status-after-bootstrap");
    await initWorkspace(dir);

    // 模拟助手完成首次引导：写人设 → 删引导文件 → 留下防重标记
    await fs.writeFile(path.join(dir, PERSONA_FILE), "# 我是谁\n\n我叫小助。", "utf8");
    await fs.unlink(path.join(dir, BOOTSTRAP_FILE));
    await fs.mkdir(path.dirname(workspaceBootstrapFlagPath(dir)), { recursive: true });
    await fs.writeFile(workspaceBootstrapFlagPath(dir), "", "utf8");

    const s = (await (
      await app.request(`/workspace/status?path=${encodeURIComponent(dir)}`)
    ).json()) as {
      initialized: boolean;
      files: { agentsMd: boolean; bootstrapMd: boolean; bootstrapCompleted: boolean };
    };

    expect(s.files.agentsMd).toBe(true);
    expect(s.files.bootstrapMd).toBe(false);
    expect(s.files.bootstrapCompleted).toBe(true);
    // 关键：仍算已初始化。否则界面会把初始化入口放回来，点一下又写回 BOOTSTRAP.md，
    // 引导就永远结束不了。
    expect(s.initialized).toBe(true);
  });

  test("状态查询是只读的：不创建 .open-assistant/", async () => {    const dir = await freshDir("status-readonly");
    await readWorkspaceInitStatus(dir);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

describe("9.5 初始化失败：错误可读且工作区仍可用", () => {
  test("同名路径是目录导致写入失败 → 可读错误 + 已写入信息", async () => {
    const app = await loadApp();
    const dir = await freshDir("init-fail");
    // 用目录占住 BOOTSTRAP.md：writeFile 必然失败（跨平台可用）
    await fs.mkdir(path.join(dir, BOOTSTRAP_FILE));

    const res = await app.request("/workspace/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("WORKSPACE_INIT_FAILED");
    expect(body.message).toContain(BOOTSTRAP_FILE);
    expect(body.message).toContain(PERSONA_FILE); // 已写入的那件有交代

    // 工作区仍可用：状态 / 文件树都还能查
    const status = await app.request(`/workspace/status?path=${encodeURIComponent(dir)}`);
    expect(status.status).toBe(200);
    const tree = await app.request(
      `/workspace/tree?path=${encodeURIComponent(dir)}&rel=%2F`,
    );
    expect(tree.status).toBe(200);
  });

  test("POSIX 权限错误 → 403 且报错可读（Windows / root 跳过）", async () => {
    if (process.platform === "win32") return;
    const dir = await freshDir("init-eacces");
    await fs.chmod(dir, 0o555);
    try {
      const writable = await fs
        .access(dir, fs.constants.W_OK)
        .then(() => true)
        .catch(() => false);
      if (writable) return;
      const err = await initWorkspace(dir).catch((e) => e);
      expect((err as { code?: string }).code).toBe("WORKSPACE_INIT_FAILED");
      expect((err as { status?: number }).status).toBe(403);
      expect((err as Error).message.length).toBeGreaterThan(0);
    } finally {
      await fs.chmod(dir, 0o755);
    }
  });
});

describe("9.6 / 9.7 首次引导注入", () => {
  test("首次交互：引导拼到本轮用户消息前，且不入 state；同时写防重标记", async () => {
    const dir = await freshDir("boot-first");
    await initWorkspace(dir);
    const { graph, model } = makeFakeAgent(dir, [new AIMessage("你好，初次见面！我该怎么称呼你？")]);

    const result = await graph.invoke(
      { messages: [userMessage("你好")] },
      { configurable: { workspace: dir } },
    );

    const firstCall = model.calls[0]!;
    expect(SystemMessage.isInstance(firstCall[0])).toBe(true);
    // 引导在本轮用户消息前（本轮消息级注入）
    expect(String(firstCall[1]!.content)).toBe(BOOTSTRAP_GUIDANCE + "你好");
    // 引导没有写进 state（对话历史与界面都不该看到它）
    expect(String(result.messages[0]!.content)).toBe("你好");
    expect(JSON.stringify(result.messages)).not.toContain("引导模式");
    // 防重标记立刻落盘（落在应用数据子目录，不在工作区根）
    expect(await fs.readFile(workspaceBootstrapFlagPath(dir), "utf8")).toContain("triggeredAt");
    expect((await fs.readdir(dir)).includes(BOOTSTRAP_FLAG_FILE)).toBe(false);
  });

  test("同一工作区第二次交互不再注入", async () => {
    const dir = await freshDir("boot-once");
    await initWorkspace(dir);
    // 先跑一轮，把防重标记写上
    const first = makeFakeAgent(dir, [new AIMessage("初次见面")]);
    await first.graph.invoke(
      { messages: [userMessage("你好")] },
      { configurable: { workspace: dir } },
    );
    expect(String(first.model.calls[0]![1]!.content)).toContain("引导模式");

    const second = makeFakeAgent(dir, [new AIMessage("记得，你叫小明")]);
    const result = await second.graph.invoke(
      { messages: [userMessage("我叫小明")] },
      { configurable: { workspace: dir } },
    );
    expect(String(second.model.calls[0]![1]!.content)).toBe("我叫小明");
    expect(String(result.messages[0]!.content)).toBe("我叫小明");
  });

  test("无 BOOTSTRAP.md → 不注入，也不写标记", async () => {
    const dir = await freshDir("boot-absent");
    await fs.writeFile(path.join(dir, PERSONA_FILE), "# 已有的人设", "utf8");
    const { graph, model } = makeFakeAgent(dir, [new AIMessage("好的")]);
    await graph.invoke({ messages: [userMessage("你好")] }, { configurable: { workspace: dir } });
    expect(String(model.calls[0]![1]!.content)).toBe("你好");
    expect(await fs.stat(workspaceBootstrapFlagPath(dir)).catch(() => null)).toBe(null);
  });

  test("非首次交互（已有助手回复）→ 不注入，也不写标记", async () => {
    const dir = await freshDir("boot-notfirst");
    await initWorkspace(dir);
    const { graph, model } = makeFakeAgent(dir, [new AIMessage("接着说")]);
    await graph.invoke(
      {
        messages: [
          new HumanMessage("你好"),
          new AIMessage("初次见面"),
          new HumanMessage("我在整理笔记"),
        ],
      },
      { configurable: { workspace: dir } },
    );
    const outgoing = model.calls[0]!;
    expect(String(outgoing[outgoing.length - 1]!.content)).toBe("我在整理笔记");
    expect(await fs.stat(workspaceBootstrapFlagPath(dir)).catch(() => null)).toBe(null);
  });

  test("首次交互判定与拼接：纯函数边界（含分块内容）", () => {
    expect(isFirstUserInteraction([new HumanMessage("a")])).toBe(true);
    expect(isFirstUserInteraction([new HumanMessage("a"), new AIMessage("b")])).toBe(false);
    expect(isFirstUserInteraction([new HumanMessage("a"), new AIMessage("b"), new HumanMessage("c")])).toBe(
      false,
    );
    // 系统消息不算（request.messages 本来也不含系统消息）
    expect(isFirstUserInteraction([new SystemMessage("s"), new HumanMessage("a")])).toBe(true);

    const blocks = [
      new HumanMessage({
        content: [{ type: "text", text: "分块内容" }],
      }),
    ];
    const patched = prependGuidance(blocks, "# 引导\n");
    const content = patched[0]!.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toBe("# 引导\n分块内容");
    // 原消息对象不被改动
    const original = blocks[0]!.content as Array<{ type: string; text: string }>;
    expect(original[0]!.text).toBe("分块内容");
  });
});

describe("9.8 人设保护收窄为只保护 AGENTS.md", () => {
  test("agent 用文件工具覆盖 AGENTS.md 被拒，但删除 BOOTSTRAP.md 可以", async () => {
    const dir = await freshDir("protect-basic");
    await initWorkspace(dir);
    await fs.writeFile(path.join(dir, PERSONA_FILE), "# 我的人设：叫我小助\n", "utf8");

    const { graph } = makeFakeAgent(dir, [
      toolCall("write_file", { file_path: `/${PERSONA_FILE}`, content: "# 被改坏了" }),
      toolCall("delete", { file_path: `/${BOOTSTRAP_FILE}` }, "call-2"),
      new AIMessage("done"),
    ]);

    const result = await graph.invoke(
      { messages: [userMessage("把人设替换成被改坏了，然后删掉 BOOTSTRAP.md")] },
      { configurable: { workspace: dir } },
    );

    const toolMessages = result.messages.filter((m) => ToolMessage.isInstance(m)) as ToolMessage[];
    expect(toolMessages.length).toBeGreaterThanOrEqual(2);
    // 覆盖人设被拦下
    expect(String(toolMessages[0]!.content)).toContain("PERSONA_PROTECTED");
    expect(await fs.readFile(path.join(dir, PERSONA_FILE), "utf8")).toBe("# 我的人设：叫我小助\n");
    // BOOTSTRAP.md 必须删得掉，否则引导永远结束不了
    expect(await fs.stat(path.join(dir, BOOTSTRAP_FILE)).catch(() => null)).toBe(null);
  });

  test("文件工具任何时候都碰不到 AGENTS.md：引导进行中 + 引导结束后都拒绝", async () => {
    // 引导进行中（BOOTSTRAP.md 还在、防重标记已写）
    const during = await freshDir("protect-during-bootstrap");
    await initWorkspace(during);
    await markBootstrapTriggered(during);

    // 引导结束后（BOOTSTRAP.md 被删）
    const after = await freshDir("protect-after-bootstrap");
    await initWorkspace(after);
    await fs.rm(path.join(after, BOOTSTRAP_FILE));
    await markBootstrapTriggered(after);

    for (const dir of [during, after]) {
      for (const tool of ["write_file", "edit_file", "delete"] as const) {
        const args =
          tool === "edit_file"
            ? { file_path: `/${PERSONA_FILE}`, old_string: "x", new_string: "y" }
            : tool === "delete"
              ? { file_path: `/${PERSONA_FILE}` }
              : { file_path: `/${PERSONA_FILE}`, content: "# 被我覆盖了" };
        const { graph } = makeFakeAgent(dir, [toolCall(tool, args), new AIMessage("done")]);
        const result = await graph.invoke(
          { messages: [userMessage("改一下人设")] },
          { configurable: { workspace: dir } },
        );
        const toolMessages = result.messages.filter((m) => ToolMessage.isInstance(m)) as ToolMessage[];
        expect(String(toolMessages[0]!.content)).toContain("PERSONA_PROTECTED");
      }
      expect(await fs.readFile(path.join(dir, PERSONA_FILE), "utf8")).toBe(PERSONA_CONTENT);
    }
  });

  test("专用通道 persona_write：引导期间可写；引导结束后被拒", async () => {
    const dir = await freshDir("persona-tool");
    await initWorkspace(dir);
    await markBootstrapTriggered(dir);

    const ok = makeFakeAgent(dir, [
      toolCall("persona_write", { content: "# 我是小助\n说话简短。\n", mode: "replace" }),
      new AIMessage("记好了"),
    ]);
    const okResult = await ok.graph.invoke(
      { messages: [userMessage("你叫小助，说话简短一点")] },
      { configurable: { workspace: dir } },
    );
    const okTools = okResult.messages.filter((m) => ToolMessage.isInstance(m)) as ToolMessage[];
    expect(String(okTools[0]!.content)).toContain('"ok": true');
    expect(await fs.readFile(path.join(dir, PERSONA_FILE), "utf8")).toBe("# 我是小助\n说话简短。\n");

    // 引导结束：删掉 BOOTSTRAP.md 后通道关闭
    await fs.rm(path.join(dir, BOOTSTRAP_FILE));
    const locked = makeFakeAgent(dir, [
      toolCall("persona_write", { content: "# 偷偷改", mode: "replace" }),
      new AIMessage("done"),
    ]);
    const lockedResult = await locked.graph.invoke(
      { messages: [userMessage("再改一次人设")] },
      { configurable: { workspace: dir } },
    );
    const lockedTools = lockedResult.messages.filter((m) => ToolMessage.isInstance(m)) as ToolMessage[];
    expect(String(lockedTools[0]!.content)).toContain("PERSONA_LOCKED");
    expect(await fs.readFile(path.join(dir, PERSONA_FILE), "utf8")).toBe("# 我是小助\n说话简短。\n");
  });

  test("persona_write 的 append 模式：追加而不丢已有内容", async () => {
    const dir = await freshDir("persona-append");
    await initWorkspace(dir);
    const { graph } = makeFakeAgent(dir, [
      toolCall("persona_write", { content: "## 用户资料\n叫我小明", mode: "append" }),
      new AIMessage("done"),
    ]);
    const result = await graph.invoke(
      { messages: [userMessage("追加用户资料")] },
      { configurable: { workspace: dir } },
    );
    const toolMessages = result.messages.filter((m) => ToolMessage.isInstance(m)) as ToolMessage[];
    expect(String(toolMessages[0]!.content)).toContain('"mode": "append"');
    const content = await fs.readFile(path.join(dir, PERSONA_FILE), "utf8");
    expect(content.startsWith(PERSONA_CONTENT.trimEnd())).toBe(true);
    expect(content).toContain("## 用户资料");
  });

  test("人设装载：AGENTS.md 进系统提示词；缺失时回退内置默认人设", async () => {
    const withPersonaDir = await freshDir("persona-loaded");
    await fs.writeFile(path.join(withPersonaDir, PERSONA_FILE), "# 我是小助\n", "utf8");
    const a = makeFakeAgent(withPersonaDir, [new AIMessage("好")]);
    await a.graph.invoke(
      { messages: [userMessage("你好")] },
      { configurable: { workspace: withPersonaDir } },
    );
    const sysA = a.model.calls[0]![0] as SystemMessage;
    expect(sysA.text).toContain("<persona>");
    expect(sysA.text).toContain("# 我是小助");
    expect(sysA.text).toContain("内置默认人设");

    const withoutPersonaDir = await freshDir("persona-default");
    const b = makeFakeAgent(withoutPersonaDir, [new AIMessage("好")]);
    await b.graph.invoke(
      { messages: [userMessage("你好")] },
      { configurable: { workspace: withoutPersonaDir } },
    );
    const sysB = b.model.calls[0]![0] as SystemMessage;
    expect(sysB.text).toBe("内置默认人设");
  });

  test("isPersonaPath 归一化：斜杠 / 反斜杠 / ./ 前缀", () => {
    expect(isPersonaPath("/AGENTS.md")).toBe(true);
    expect(isPersonaPath("AGENTS.md")).toBe(true);
    expect(isPersonaPath("./AGENTS.md")).toBe(true);
    expect(isPersonaPath("\AGENTS.md")).toBe(true);
    expect(isPersonaPath("/notes/AGENTS.md")).toBe(false);
    expect(isPersonaPath("/BOOTSTRAP.md")).toBe(false);
    expect(isPersonaPath(undefined)).toBe(false);
  });
});

describe("9.1 回归：确保 ensureWorkspace 不再写文件", () => {
  test("ensureWorkspace 只保证目录可用", async () => {
    const dir = await freshDir("ensure-no-write");
    await ensureWorkspace(dir);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});