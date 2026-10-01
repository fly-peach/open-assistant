/**
 * 探针：定时任务后端 + 项目记忆接口（tasks 10.1–10.6 / 10.8）。
 *
 * 一次可复跑，逐项打印 PASS/FAIL。为不依赖真实模型，agent 任务用注入的
 * 确定性执行器；投递到会话走真实 conversation store（SQLite）。
 * 用法：`bun run scripts/probe-jobs.ts`（也可 bundle 后由 Node 跑，见 README/任务说明）。
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

process.env.OPEN_ASSISTANT_DISABLE_MIGRATION = "1";
process.env.OPEN_ASSISTANT_DISABLE_JOBS_SCHEDULER = "1";

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-probe-jobs-")));
process.env.AGENTS_ROOT = path.join(root, "agents");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");

const { ensureWorkspace } = await import("../src/workspace.js");
const { createAgent } = await import("../src/agents/registry.js");
const { agentDirPath, AGENT_MEMORY_FILE } = await import("../src/agents/root.js");
const { writeBinding } = await import("../src/binding.js");
const { readAgentMemory, writeAgentMemory } = await import("../src/agents/memory.js");
const { readJobs, workspaceJobsPath, normalizeJobSpec, createJobRecord, JobError } = await import("../src/jobs/index.js");
const { JobScheduler } = await import("../src/jobs/index.js");
const { setDefaultJobExecutor, runJobNow } = await import("../src/jobs/runner.js");
const { workspaceProjectMemoryPath, readProjectMemory, writeProjectMemory } = await import("../src/project-memory.js");
const { listSessions, readThreadMessages } = await import("../src/conversation/index.js");
const { app } = await import("../src/http.js");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures += 1;
}

function spec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

async function api(ws: string, method: string, suffix = "", body?: unknown): Promise<Response> {
  return app.request(`/jobs${suffix}?path=${encodeURIComponent(ws)}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify({ path: ws, ...(body as object) }) }),
  });
}

function sessionText(ws: string): string {
  const sessions = listSessions(ws);
  return sessions
    .flatMap((s) => readThreadMessages(ws, s.id))
    .map((m) => m.content ?? "")
    .join("\n");
}

// —— setup ——
const wsA = await ensureWorkspace(path.join(root, "ws-a"));
const wsB = await ensureWorkspace(path.join(root, "ws-b"));
await createAgent({ id: "alpha", name: "Alpha" });
await createAgent({ id: "beta", name: "Beta" });
await writeBinding(wsA, "alpha");
await writeBinding(wsB, "alpha");

// —— 10.1 存储读写 + 边界 ——
{
  const empty = await readJobs(wsA);
  check("10.1 文件不存在视为空", empty.exists === false && empty.file.jobs.length === 0);

  const wsCorrupt = await ensureWorkspace(path.join(root, "ws-corrupt"));
  const file = workspaceJobsPath(wsCorrupt);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{ broken", "utf8");
  const thrown = await readJobs(wsCorrupt).catch((e) => e as JobError);
  check("10.1 非法 JSON 报错", thrown instanceof JobError && thrown.code === "JOB_INVALID_JSON", thrown.message?.slice(0, 40));
  const overwrite = await createJobRecord(wsCorrupt, normalizeJobSpec(spec({ id: "x" }), { requireId: true })).then(
    () => null,
    (e) => e as JobError,
  );
  const unchanged = (await fs.readFile(file, "utf8")) === "{ broken";
  check("10.1 非法 JSON 不覆盖", overwrite !== null && unchanged);
}

// —— 10.2 端点 + 非法组合 ——
{
  const created = await api(wsA, "POST", "", spec({ id: undefined }));
  const { id } = (await created.json()) as { id: string };
  check("10.2 POST /jobs 创建成功", created.status === 200 && typeof id === "string" && id.length > 0, `id=${id}`);

  const listed = await api(wsA, "GET");
  const listBody = (await listed.json()) as { jobs: Array<{ id: string }> };
  check("10.2 GET /jobs 列出本工作区任务", listBody.jobs.some((j) => j.id === id));

  const silentText = await api(wsA, "POST", "", spec({ id: undefined, name: "t", content: { kind: "text", text: "x" }, silent: true }));
  check("10.2 文本 + 静默被拒", silentText.status === 400 && ((await silentText.json()) as { error: string }).error === "JOB_SILENT_TEXT");

  const six = await api(wsA, "POST", "", spec({ id: undefined, schedule: { kind: "periodic", cron: "0 9 * * * 5", end: { kind: "never" } } }));
  check("10.2 6 段 cron 被拒", six.status === 400 && ((await six.json()) as { error: string }).error === "JOB_INVALID_CRON");

  const bad = await api(wsA, "POST", "", spec({ id: undefined, runtime: { concurrency: -1, timeoutSeconds: 1, graceSeconds: 0 } }));
  check("10.2 非法运行约束被拒", bad.status === 400 && ((await bad.json()) as { error: string }).error === "JOB_INVALID_INPUT");

  const patched = await api(wsA, "PATCH", `/${id}`, { enabled: false });
  const disabled = (await readJobs(wsA)).file.jobs.find((j) => j.id === id)?.enabled === false;
  check("10.2 PATCH 启停生效", patched.status === 200 && disabled);
  const deleted = await api(wsA, "DELETE", `/${id}`);
  check("10.2 DELETE 生效", deleted.status === 200 && !(await readJobs(wsA)).file.jobs.some((j) => j.id === id));
}

// —— 10.3 手动触发 → 结果落进本工作区会话 ——
{
  setDefaultJobExecutor(async () => ({ content: "MARKER-10.3 已提醒" }));
  const created = await api(wsA, "POST", "", spec({ id: undefined, name: "agent 任务", content: { kind: "agent", text: "提醒我看待办" } }));
  const { id } = (await created.json()) as { id: string };
  const run = await api(wsA, "POST", `/${id}/run`);
  const runBody = (await run.json()) as { status: string };
  const text = sessionText(wsA);
  check("10.3 手动触发返回 ok", run.status === 200 && runBody.status === "ok", `status=${runBody.status}`);
  check("10.3 结果出现在本工作区会话记录", text.includes("MARKER-10.3"), text.split("\n").find((l) => l.includes("MARKER")) ?? "");
  const other = sessionText(wsB);
  check("10.3/10.4 任务不影响其他工作区", !other.includes("MARKER-10.3"));
}

// —— 10.4 宽限窗口补跑 / 不补跑 + 记录决定 ——
{
  const now = new Date("2030-06-01T12:00:00Z");
  const ws = await ensureWorkspace(path.join(root, "ws-grace"));
  const within = normalizeJobSpec(
    spec({ id: "within", content: { kind: "text", text: "ping" }, schedule: { kind: "periodic", cron: "0 * * * *", timezone: "UTC", end: { kind: "never" } } }),
    { requireId: true },
  );
  within.meta = { saveResult: false };
  within.nextRunAt = new Date(now.getTime() - 10_000).toISOString();
  await createJobRecord(ws, within);
  const s1 = new JobScheduler({ workspace: ws, now: () => now });
  const r1 = await s1.tick(now);
  const caughtUp = (await readJobs(ws)).file.jobs[0]!.lastRuns?.at(-1);
  check("10.4 窗口内补跑且记录决定", r1.entries[0]!.action === "ran" && r1.entries[0]!.status === "ok" && (caughtUp?.message ?? "").includes("补跑"), caughtUp?.message ?? "");

  const ws2 = await ensureWorkspace(path.join(root, "ws-grace-out"));
  const outside = normalizeJobSpec(
    spec({ id: "outside", content: { kind: "text", text: "ping" }, schedule: { kind: "periodic", cron: "0 * * * *", timezone: "UTC", end: { kind: "never" } } }),
    { requireId: true },
  );
  outside.meta = { saveResult: false };
  outside.nextRunAt = new Date(now.getTime() - 400_000).toISOString();
  await createJobRecord(ws2, outside);
  const s2 = new JobScheduler({ workspace: ws2, now: () => now });
  const r2 = await s2.tick(now);
  const skipped = (await readJobs(ws2)).file.jobs[0]!.lastRuns?.at(-1);
  check("10.4 窗口外不补跑且记录决定", r2.entries[0]!.action === "skipped" && skipped?.status === "skipped" && (skipped.message ?? "").includes("不补跑"), skipped?.message ?? "");
}

// —— 10.5 换绑后按新身份执行 ——
{
  const seen: string[] = [];
  setDefaultJobExecutor(async (ctx) => {
    seen.push(ctx.agentId ?? "none");
    return { content: `by ${ctx.agentId}` };
  });
  const job = normalizeJobSpec(spec({ id: "identity", content: { kind: "agent", text: "run" } }), { requireId: true });
  job.meta = { saveResult: false };
  await createJobRecord(wsA, job);
  await runJobNow({ workspace: wsA, job });
  await writeBinding(wsA, "beta");
  await runJobNow({ workspace: wsA, job });
  check("10.5 换绑后按新身份执行", seen.length === 2 && seen[0] === "alpha" && seen[1] === "beta", seen.join(" -> "));
}

// —— 10.6 项目记忆与 agent 长期记忆分开存放 ——
{
  await writeProjectMemory(wsA, "项目：本工作区的长期事实");
  await writeAgentMemory(agentDirPath("alpha"), "agent：跨工作区共享记忆");
  const projectPath = workspaceProjectMemoryPath(wsA);
  const agentPath = path.join(agentDirPath("alpha"), AGENT_MEMORY_FILE);
  const project = await readProjectMemory(wsA);
  const agentMem = await readAgentMemory(agentDirPath("alpha"));
  check("10.6 两份记忆路径不同", projectPath !== agentPath, `${projectPath} | ${agentPath}`);
  check("10.6 两份记忆内容互不串台", project === "项目：本工作区的长期事实" && agentMem === "agent：跨工作区共享记忆");
}

// —— 10.8 端到端：每天 9:00 提醒 → 手动触发 → 结果在会话里 ——
{
  setDefaultJobExecutor(async () => ({ content: "SHOULD-NOT-BE-USED" }));
  const created = await api(wsA, "POST", "", spec({
    id: undefined,
    name: "每天 9:00 提醒我看待办",
    content: { kind: "text", text: "9:00 了，记得看待办清单" },
    schedule: { kind: "periodic", cron: "0 9 * * *", timezone: "Asia/Shanghai", end: { kind: "never" } },
    // 文本 + 周期默认不存会话；这里显式开启，等价于用户在界面上勾选「保存结果」
    meta: { saveResult: true },
  }));
  const { id } = (await created.json()) as { id: string };
  const before = sessionText(wsA);
  const run = await api(wsA, "POST", `/${id}/run`);
  const after = sessionText(wsA);
  check("10.8 每天 9:00 任务手动触发", run.status === 200);
  check("10.8 提醒文本出现在会话里", after.includes("9:00 了，记得看待办清单") && !after.includes("SHOULD-NOT-BE-USED"));
  check("10.8 会话确实新增了结果", after.length > before.length, `+${after.length - before.length} chars`);
}

await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
console.log(failures === 0 ? "\nJOBS PROBE PASS" : `\nJOBS PROBE ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);