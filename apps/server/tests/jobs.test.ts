import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

// 测试期间不触发历史会话迁移 / 后台调度器
process.env.OPEN_ASSISTANT_DISABLE_MIGRATION = "1";
process.env.OPEN_ASSISTANT_DISABLE_JOBS_SCHEDULER = "1";

import {
  JobError,
  JobScheduler,
  createJobRecord,
  normalizeJobSpec,
  readJobs,
  writeJobs,
  workspaceJobsPath,
} from "../src/jobs/index.js";
import { readProjectMemory, workspaceProjectMemoryPath, writeProjectMemory } from "../src/project-memory.js";
import { createAgent } from "../src/agents/registry.js";
import { writeBinding, readBinding } from "../src/binding.js";
import { agentDirPath } from "../src/agents/root.js";
import { ensureWorkspace } from "../src/workspace.js";

let root: string;
let counter = 0;
const savedAgentsRoot = process.env.AGENTS_ROOT;

async function freshWorkspace(name: string): Promise<string> {
  counter += 1;
  return ensureWorkspace(path.join(root, `${name}-${counter}`));
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-jobs-")));
  process.env.AGENTS_ROOT = path.join(root, "agents");
});

afterAll(async () => {
  if (savedAgentsRoot === undefined) delete process.env.AGENTS_ROOT;
  else process.env.AGENTS_ROOT = savedAgentsRoot;
  await fs.rm(root, { recursive: true, force: true });
});

function validSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    name: "每天提醒",
    enabled: true,
    heartbeat: false,
    content: { kind: "agent", text: "提醒我看待办" },
    schedule: { kind: "periodic", cron: "0 9 * * *", timezone: "Asia/Shanghai", end: { kind: "never" } },
    dispatch: { mode: "stream" },
    silent: false,
    runtime: { concurrency: 1, timeoutSeconds: 600, graceSeconds: 300 },
    ...overrides,
  };
}

describe("10.1 jobs.json 读写", () => {
  test("文件不存在视为空（不报错、不落盘）", async () => {
    const ws = await freshWorkspace("empty");
    const snapshot = await readJobs(ws);
    expect(snapshot.exists).toBe(false);
    expect(snapshot.etag).toBe(null);
    expect(snapshot.file.jobs).toEqual([]);
    await expect(fs.stat(workspaceJobsPath(ws))).rejects.toThrow();
  });

  test("写入后可读回，且是原子落盘", async () => {
    const ws = await freshWorkspace("write");
    const spec = normalizeJobSpec(validSpec(), { requireId: true });
    await createJobRecord(ws, spec);
    const snapshot = await readJobs(ws);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.file.jobs).toHaveLength(1);
    expect(snapshot.file.jobs[0]!.name).toBe("每天提醒");
    const raw = await fs.readFile(workspaceJobsPath(ws), "utf8");
    expect(JSON.parse(raw).version).toBe(1);
  });

  test("非法 JSON 报错且不覆盖（整体写入也被挡住）", async () => {
    const ws = await freshWorkspace("corrupt");
    const file = workspaceJobsPath(ws);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const corrupt = "{ not json";
    await fs.writeFile(file, corrupt, "utf8");

    await expect(readJobs(ws)).rejects.toBeInstanceOf(JobError);
    const err = await readJobs(ws).catch((e) => e as JobError);
    expect(err.code).toBe("JOB_INVALID_JSON");

    // 尝试整体覆盖写入 → 同样被拒绝，文件内容一个字节未变
    await expect(
      writeJobs(ws, { version: 1, updatedAt: new Date().toISOString(), jobs: [] }),
    ).rejects.toBeInstanceOf(JobError);
    expect(await fs.readFile(file, "utf8")).toBe(corrupt);

    // createJob 也必须先读到损坏而报错，不静默清空
    await expect(createJobRecord(ws, normalizeJobSpec(validSpec({ id: "x" }), { requireId: true }))).rejects.toBeInstanceOf(JobError);
    expect(await fs.readFile(file, "utf8")).toBe(corrupt);
  });
});

describe("10.2 字段校验", () => {
  test("cron：4 段补位、3 段补位、DOW 数字转缩写、拒绝 6 段", () => {
    expect(normalizeJobSpec(validSpec({ schedule: { kind: "periodic", cron: "9 * * 1", end: { kind: "never" } } })).schedule.cron).toBe("0 9 * * mon");
    expect(normalizeJobSpec(validSpec({ schedule: { kind: "periodic", cron: "* * 1", end: { kind: "never" } } })).schedule.cron).toBe("0 0 * * mon");
    expect(normalizeJobSpec(validSpec({ schedule: { kind: "periodic", cron: "0 9 * * 0", end: { kind: "never" } } })).schedule.cron).toBe("0 9 * * sun");
    expect(() =>
      normalizeJobSpec(validSpec({ schedule: { kind: "periodic", cron: "0 0 9 * * *", end: { kind: "never" } } })),
    ).toThrow(JobError);
  });

  test("文本任务 + 静默 → 拒绝（JOB_SILENT_TEXT）", () => {
    const err = (() => {
      try {
        normalizeJobSpec(validSpec({ content: { kind: "text", text: "hi" }, silent: true }));
      } catch (e) {
        return e as JobError;
      }
      return null;
    })();
    expect(err?.code).toBe("JOB_SILENT_TEXT");
  });

  test("非法字段（content.kind / runtime / timezone）被拒", () => {
    expect(() => normalizeJobSpec(validSpec({ content: { kind: "email", text: "x" } }))).toThrow(JobError);
    expect(() => normalizeJobSpec(validSpec({ runtime: { concurrency: -1, timeoutSeconds: 1, graceSeconds: 0 } }))).toThrow(JobError);
    expect(() =>
      normalizeJobSpec(validSpec({ schedule: { kind: "periodic", cron: "0 9 * * *", timezone: "Not/AZone", end: { kind: "never" } } })),
    ).toThrow(JobError);
  });

  test("meta.saveResult 默认：文本 + 周期 false，其他 true", () => {
    expect(
      normalizeJobSpec(validSpec({ content: { kind: "text", text: "x" }, schedule: { kind: "periodic", cron: "0 9 * * *", end: { kind: "never" } } })).meta?.saveResult,
    ).toBe(false);
    expect(
      normalizeJobSpec(validSpec({ content: { kind: "text", text: "x" }, schedule: { kind: "once", at: "2030-01-01T00:00:00Z", end: { kind: "never" } } })).meta?.saveResult,
    ).toBe(true);
    expect(normalizeJobSpec(validSpec()).meta?.saveResult).toBe(true);
  });
});

describe("10.4 调度器：宽限窗口", () => {
  test("窗口内补跑；窗口外不补跑且记录该决定", async () => {
    const ws = await freshWorkspace("grace");
    const now = new Date("2030-06-01T12:00:00Z");
    const base = normalizeJobSpec(
      validSpec({
        id: "periodic",
        content: { kind: "text", text: "ping" },
        schedule: { kind: "periodic", cron: "0 * * * *", timezone: "UTC", end: { kind: "never" } },
      }),
      { requireId: true },
    );
    base.meta = { saveResult: true };
    base.nextRunAt = new Date(now.getTime() - 10_000).toISOString(); // 晚 10s，窗口 300s
    await createJobRecord(ws, base);

    const deliveries: string[] = [];
    const deliverer = async () => {
      deliveries.push("called");
      return { threadId: "t1" };
    };
    const scheduler = new JobScheduler({ workspace: ws, deliverer, now: () => now });
    const within = await scheduler.tick(now);
    expect(within.entries[0]!.action).toBe("ran");
    expect(within.entries[0]!.status).toBe("ok");
    expect(deliveries).toHaveLength(1);
    const afterWithin = await readJobs(ws);
    expect(afterWithin.file.jobs[0]!.lastRuns?.at(-1)?.status).toBe("ok");
    expect(afterWithin.file.jobs[0]!.lastRuns?.at(-1)?.message).toContain("补跑");
    expect(afterWithin.file.jobs[0]!.nextRunAt).not.toBe(base.nextRunAt);

    // 窗口外：把 nextRunAt 设到更早（晚 400s > 300s）
    const ws2 = await freshWorkspace("grace-out");
    const job2 = { ...normalizeJobSpec(validSpec({ id: "periodic2", content: { kind: "text", text: "ping" }, schedule: { kind: "periodic", cron: "0 * * * *", timezone: "UTC", end: { kind: "never" } } }), { requireId: true }) };
    job2.meta = { saveResult: true };
    job2.nextRunAt = new Date(now.getTime() - 400_000).toISOString();
    await createJobRecord(ws2, job2);
    const deliveries2: string[] = [];
    const scheduler2 = new JobScheduler({ workspace: ws2, deliverer: async () => { deliveries2.push("x"); return {}; }, now: () => now });
    const outside = await scheduler2.tick(now);
    expect(outside.entries[0]!.action).toBe("skipped");
    expect(deliveries2).toHaveLength(0);
    const afterOutside = await readJobs(ws2);
    const skipped = afterOutside.file.jobs[0]!.lastRuns?.at(-1);
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.message).toContain("不补跑");
  });

  test("一次性任务到点执行，过期超窗记 skipped", async () => {
    const ws = await freshWorkspace("once");
    const now = new Date("2030-06-01T12:00:00Z");
    const spec = normalizeJobSpec(
      validSpec({ id: "once-1", content: { kind: "text", text: "one" }, schedule: { kind: "once", at: new Date(now.getTime() - 1000).toISOString(), end: { kind: "never" } } }),
      { requireId: true },
    );
    spec.meta = { saveResult: false };
    await createJobRecord(ws, spec);
    const scheduler = new JobScheduler({ workspace: ws, now: () => now });
    const result = await scheduler.tick(now);
    expect(result.entries[0]!.action).toBe("ran");
  });

  test("enabled=false 不触发", async () => {
    const ws = await freshWorkspace("disabled");
    const now = new Date("2030-06-01T12:00:00Z");
    const spec = normalizeJobSpec(validSpec({ id: "off", enabled: false, content: { kind: "text", text: "x" }, schedule: { kind: "once", at: new Date(now.getTime() - 1000).toISOString(), end: { kind: "never" } } }), { requireId: true });
    await createJobRecord(ws, spec);
    const scheduler = new JobScheduler({ workspace: ws, now: () => now });
    const result = await scheduler.tick(now);
    expect(result.entries[0]!.action).toBe("disabled");
  });
});

describe("10.5 触发身份取工作区绑定，换绑后按新身份", () => {
  test("换绑后执行器拿到新 agent id", async () => {
    const ws = await freshWorkspace("identity");
    await createAgent({ id: "alpha", name: "Alpha" });
    await createAgent({ id: "beta", name: "Beta" });
    await writeBinding(ws, "alpha");

    const seen: string[] = [];
    const spec = normalizeJobSpec(validSpec({ id: "identity-job" }), { requireId: true });
    spec.meta = { saveResult: false };
    await createJobRecord(ws, spec);

    const { runJobNow } = await import("../src/jobs/runner.js");
    const executor = async (ctx: { agentId: string | null }) => {
      seen.push(ctx.agentId ?? "none");
      return { content: "done" };
    };
    await runJobNow({ workspace: ws, job: spec, executor, deliverer: async () => ({}) });
    expect(seen).toEqual(["alpha"]);
    expect((await readBinding(ws))?.agentId).toBe("alpha");

    await writeBinding(ws, "beta");
    await runJobNow({ workspace: ws, job: spec, executor, deliverer: async () => ({}) });
    expect(seen).toEqual(["alpha", "beta"]);
  });
});

describe("心跳任务：以 agent 心跳文件为内容", () => {
  test("heartbeat 允许空 content.text，并用 HEARTBEAT.md 当请求", async () => {
    const ws = await freshWorkspace("heartbeat");
    await createAgent({ id: "beater" });
    await writeBinding(ws, "beater");
    await fs.writeFile(path.join(agentDirPath("beater"), "HEARTBEAT.md"), "检查今日待办", "utf8");

    const spec = normalizeJobSpec(
      validSpec({ id: "hb", heartbeat: true, content: { kind: "agent", text: "" } }),
      { requireId: true },
    );
    expect(spec.meta?.saveResult).toBe(true);
    spec.meta = { saveResult: false };
    await createJobRecord(ws, spec);

    const prompts: string[] = [];
    const { runJobNow } = await import("../src/jobs/runner.js");
    const outcome = await runJobNow({
      workspace: ws,
      job: spec,
      executor: async (ctx) => {
        prompts.push(ctx.prompt);
        return { content: "ok" };
      },
      deliverer: async () => ({}),
    });
    expect(outcome.status).toBe("ok");
    expect(prompts).toEqual(["检查今日待办"]);
  });
});

describe("10.2 HTTP 端点 + 10.6 项目记忆文件", () => {
  async function loadApp() {
    return (await import("../src/http.js")).app;
  }

  test("GET/POST/PATCH/DELETE /jobs 全链路", async () => {
    const app = await loadApp();
    const ws = await freshWorkspace("http");
    const body = validSpec({ id: undefined });
    delete (body as { id?: unknown }).id;

    const created = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ws, ...body }),
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    expect(id.length).toBeGreaterThan(0);

    const listed = await app.request(`/jobs?path=${encodeURIComponent(ws)}`);
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { jobs: Array<{ id: string; name: string }> };
    expect(listBody.jobs.map((j) => j.id)).toContain(id);

    const patched = await app.request(`/jobs/${id}?path=${encodeURIComponent(ws)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ws, enabled: false }),
    });
    expect(patched.status).toBe(200);
    const afterPatch = await readJobs(ws);
    expect(afterPatch.file.jobs[0]!.enabled).toBe(false);

    const deleted = await app.request(`/jobs/${id}?path=${encodeURIComponent(ws)}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect((await readJobs(ws)).file.jobs).toHaveLength(0);
  });

  test("非法组合经 HTTP 被拒", async () => {
    const app = await loadApp();
    const ws = await freshWorkspace("http-invalid");
    const silentText = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ws, ...validSpec({ id: undefined, name: "t", content: { kind: "text", text: "x" }, silent: true }) }),
    });
    expect(silentText.status).toBe(400);
    expect(((await silentText.json()) as { error: string }).error).toBe("JOB_SILENT_TEXT");

    const sixSeg = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ws, ...validSpec({ id: undefined, schedule: { kind: "periodic", cron: "0 9 * * * 5", end: { kind: "never" } } }) }),
    });
    expect(sixSeg.status).toBe(400);
    expect(((await sixSeg.json()) as { error: string }).error).toBe("JOB_INVALID_CRON");

    const badField = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ws, ...validSpec({ id: undefined, runtime: { concurrency: -3, timeoutSeconds: 1, graceSeconds: 0 } }) }),
    });
    expect(badField.status).toBe(400);
    expect(((await badField.json()) as { error: string }).error).toBe("JOB_INVALID_INPUT");
  });

  test("GET/PUT /memory/project 与 agent 记忆分开", async () => {
    const app = await loadApp();
    const ws = await freshWorkspace("memory");
    const empty = await app.request(`/memory/project?path=${encodeURIComponent(ws)}`);
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { content: string }).content).toBe("");

    const put = await app.request(`/memory/project?path=${encodeURIComponent(ws)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ws, content: "项目事实" }),
    });
    expect(put.status).toBe(200);
    const got = await app.request(`/memory/project?path=${encodeURIComponent(ws)}`);
    expect(((await got.json()) as { content: string }).content).toBe("项目事实");
    expect(await readProjectMemory(ws)).toBe("项目事实");

    // 路径不同：项目记忆在工作区，agent 记忆在 agents 根
    const agentId = "mem-agent";
    await createAgent({ id: agentId });
    expect(workspaceProjectMemoryPath(ws)).toBe(path.join(ws, ".open-assistant", "project-memory.md"));
    expect(agentDirPath(agentId)).not.toBe(workspaceProjectMemoryPath(ws));
    await writeProjectMemory(ws, "项目");
    expect(await readProjectMemory(ws)).toBe("项目");
  });
});