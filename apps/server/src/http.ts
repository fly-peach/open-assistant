/**
 * 自定义 HTTP 入口（挂载进 langgraph dev server，走 `langgraph.json` 的 `http.app`）。
 *
 * 工作区一律以「绝对路径」传参（不再有 :id）：
 * - GET  /fs/list                          无 path → 列本机磁盘 / 根
 * - GET  /fs/list?path=<abs>               列出该目录下的子目录（只列目录）
 * - POST /fs/pick-folder                   弹后端主机的系统文件夹对话框 → { path, cancelled, error? }
 * - POST /workspace                        body { path, create? } → { path }（realpath 归一化，不写任何文件）
 * - GET  /workspace/status?path=<ws>       初始化状态（两件套各自是否存在）
 * - POST /workspace/init                   body { path } → { path, created, skipped }（幂等、不覆盖）
 * - GET  /workspace/tree?path=<ws>&rel=<r> 列举工作区内某目录一层
 * - GET  /workspace/file?path=<ws>&rel=<r> 读取工作区内某文件
 * - GET  /workspace/todos?path=<ws>        读取 todos.json
 * - PUT  /workspace/todos?path=<ws>        原子写入 todos.json（乐观并发，冲突 409）
 * - GET  /agents                           列出 agents 根下的全部定义（含异常标注）
 * - POST /agents                           body { id, name?, description? } → { id }
 * - GET  /agents/contactable?path=<ws>      本工作区的 agent 能联系哪些对端（受 contactableAgents 约束）
 * - POST /agents/{id}/ask                  body { path, text, sessionId? } → 跨工作区调用（对端在自己工作区跑一轮）
 * - GET  /agents/{id}                      单个 agent 定义（含 config / persona / memory / skills）
 * - PATCH /agents/{id}                     body { name?, description?, config?, persona?, memory? } → { id }
 * - DELETE /agents/{id}                    → { ok: true }
 * - GET  /agents/{id}/memory               → { content }
 * - PUT  /agents/{id}/memory               body { content } → { ok: true }
 * - GET  /agents/{id}/skills            → { skills: [{ name, description, source, disabled }] }（共享池 + 私有，同名私有优先）
 * - POST /agents/{id}/skills             body { name, description?, content? } → { name }（新增私有技能）
 * - POST /agents/{id}/skills/import      body { sourcePath, name?, target? } → { name }（从本机文件夹导入）
 * - POST /agents/{id}/skills/upload      multipart（字段名=相对路径）→ { name }（上传技能文件夹）
 * - GET  /agents/{id}/skills/{name}      → { name, description, source, disabled, content }（SKILL.md 正文）
 * - PUT  /agents/{id}/skills/{name}      body { enabled } → { name, enabled, disabledSkills }（启用/关闭）
 * - DELETE /agents/{id}/skills/{name}    → { ok: true }（仅私有技能）
 * - GET  /agents/{id}/team                 → 子 agent 团队视图 { agentId, dir, teamDir, exists, toolCatalog, members }
 * - POST /agents/{id}/team                 body { name, description, systemPrompt? } → { name }
 * - GET  /agents/{id}/team/{name}          → { member }
 * - PUT  /agents/{id}/team/{name}          body { description?, tools?, model?, skills?, mode?, systemPrompt? } → { name, member }
 * - GET  /workspace/binding?path=<ws>      工作区绑定视图（未绑定 → agentId: null）
 * - PUT  /workspace/binding                body { path, agentId, mode: "keep"|"archive" } → { agentId }
 * - GET  /workspace/sessions?path=<ws>     会话列表（工作区会话库，含非活跃）
 * - GET  /workspace/sessions/{id}?path=<ws> 单条会话（会话行 + 轮次 + 消息）
 * - PATCH /workspace/sessions/{id}?path=<ws> body { title } 重命名会话（null / 空串 = 清空）
 * - DELETE /workspace/sessions/{id}?path=<ws> 删除会话（默认连带子会话）
 * - GET  /workspace/sessions/{id}/replay?path=<ws>[&keepRecentTurns=N] 冷会话重放窗口（摘要 + 最近轮次）
 * - POST /workspace/sessions/{id}/compact?path=<ws>[&keepRecentTurns=N]  手动压缩
 * - GET  /workspace/sessions/{id}/search?path=<ws>&q=<kw> 会话内检索（含被压缩内容）
 * - GET  /memory/project?path=<ws>         项目记忆（返回 wiki/index.md 内容）
 * - PUT  /memory/project                   写 index.md 的「项目记忆」分区
 * - GET  /wiki/schema?path=<ws>            SCHEMA.md 解析结果（实体类型 / 目录约定 / 字段）
 * - GET  /wiki/index?path=<ws>             内容目录（提问先读它）
 * - GET  /wiki/log?path=<ws>&limit=N       时间线最近 N 条
 * - GET  /wiki/pages?path=<ws>             wiki 页面与源层文件清单
 * - GET  /wiki/graph?path=<ws>[&rebuild=1]  知识图谱 {nodes, edges}（缺图时按需重建）
 * - POST /wiki/graph/rebuild              重建图谱 → {nodes, edges, citations, links}
 * - GET  /wiki/lint?path=<ws>              体检报告（只读，不改内容）
 * - POST /wiki/ingest                      body { path, rawPath, title?, entities? } → 收录结果
 * - POST /wiki/archive                     body { path, title, content, kind? } → 回填结果
 *
 * ## 模型配置（供应商 / 模型清单 / 能力位 / 工作区选中项）
 *
 * - GET    /models                         总览：供应商（apiKey 只给掩码）+ 可选模型 + 全局默认
 * - POST   /models/providers               新建或更新供应商 body { id?, kind?, name?, baseUrl?, apiKey?, enabled?, models? }
 * - DELETE /models/providers/{id}          删除（内置三家不可删）
 * - POST   /models/providers/{id}/discover 拉远端 /models 清单（只读，不写盘）
 * - POST   /models/providers/{id}/models   把模型加入手工清单 body { models: string[] }
 * - POST   /models/providers/{id}/test     连通性测试 body { modelId? } → { ok, latencyMs, reply }
 * - PUT    /models/default                 设全局默认模型 body { providerId, modelId }
 * - POST   /models/capability/probe        跑视觉探针 body { providerId, modelId } → { vision, attempts, ... }
 * - PUT    /models/capability              手动指定能力位 body { providerId, modelId, vision }
 * - DELETE /models/capability              清掉能力位 body { providerId, modelId }
 * - GET    /models/selection?path=<ws>     该工作区这轮会用的模型（对话页顶部下拉用）
 * - PUT    /models/selection               把选中模型写进绑定 agent 的 config.json
 */
import { Hono } from "hono";
import crypto from "node:crypto";
import {
  WorkspaceError,
  ensureWorkspace,
  initWorkspace,
  listDirectories,
  listDirectory,
  listFilesystemRoots,
  readWorkspaceFile,
  readWorkspaceInitStatus,
  resolveWorkspaceDir,
} from "./workspace.js";
import { TodoStoreError, readTodos, writeTodos, type TodoFile } from "./todos.js";
import { runWorkspaceMigrationOnce } from "./sessions.js";
import { nativePickerCommand, pickNativeFolder } from "./native-picker.js";
import { AgentError } from "./agents/errors.js";
import { ConversationStoreError } from "./conversation/types.js";
import { ModelError } from "./models/errors.js";
import {
  addProviderModels,
  clearModelCapability,
  deleteProvider,
  discoverModels,
  getOverview,
  getSelection,
  probeModelCapability,
  setDefaultModel,
  setModelCapability,
  setSelection,
  testProvider,
  upsertProvider,
} from "./models/index.js";
import {
  createAgent,
  createAgentSkill,
  deleteAgent,
  deleteAgentSkill,
  importAgentSkill,
  listAgents,
  readAgent,
  setAgentEnabled,
  setAgentPinned,
  setAgentSkillEnabled,
  setAgentWorkspaceDir,
  updateAgent,
  uploadAgentSkill,
} from "./agents/registry.js";
import { readSkillContent } from "./agents/skills.js";
import { ensurePersonalAssistants } from "./agents/personal-assistants.js";
import { askAgent, listContactableAgents } from "./agents/comms.js";
import {
  listMemoryTree,
  readCoreMemory,
  readMemoryFile,
  writeCoreMemory,
} from "./agents/memory.js";
import { createSubAgent, listTeam, readSubAgent, updateSubAgent } from "./agents/team.js";
import {
  channelFieldsFor,
  deleteChannelView,
  listChannelViews,
  upsertChannelView,
} from "./channels/index.js";
import { readBindingView, writeBinding } from "./binding.js";
import { readAgentProfilesView } from "./agent-profiles.js";
import {
  JobError,
  applyJobPatch,
  createJobRecord,
  deleteJobRecord,
  ensureSchedulerStarted,
  getJob,
  normalizeJobSpec,
  readJobs,
  replaceJobRecord,
  runJobNow,
} from "./jobs/index.js";
import { cronNext } from "./jobs/cron.js";
import { readProjectMemory, writeProjectMemory } from "./project-memory.js";
import {
  archiveAnswer,
  ingestRawDocument,
  latestLogEntries,
  lintWiki,
  listSourceFiles,
  loadGraph,
  rebuildGraph,
  listWikiPages,
  loadWikiSchema,
  readWikiIndex,
  readWikiLog,
  type IngestEntityInput,
} from "./wiki/index.js";

const log = (msg: string) => console.log(msg);

export const app = new Hono();

// 只在工作区路由上做一次性的「历史会话归属回填」（workspace / agent_id），
// 避免影响 langgraph 自身路由。
// 测试环境可用 OPEN_ASSISTANT_DISABLE_MIGRATION=1 关闭，避免误连真实 server。
const migrationMiddleware = async (_c: unknown, next: () => Promise<void>) => {
  if (process.env.OPEN_ASSISTANT_DISABLE_MIGRATION !== "1") {
    await runWorkspaceMigrationOnce(log);
  }
  await next();
};
app.use("/workspace", migrationMiddleware);
app.use("/workspace/*", migrationMiddleware);

app.onError((err, c) => {
  if (err instanceof WorkspaceError) {
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  }
  if (err instanceof TodoStoreError) {
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  }
  if (err instanceof AgentError) {
    return c.json(
      { error: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) },
      err.status as 400,
    );
  }
  if (err instanceof JobError) {
    return c.json(
      { error: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) },
      err.status as 400,
    );
  }
  if (err instanceof ModelError) {
    return c.json(
      { error: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) },
      err.status as 400,
    );
  }
  if (err instanceof ConversationStoreError) {
    const status = err.code === "CONVERSATION_THREAD_NOT_FOUND" ? 404 : 400;
    return c.json({ error: err.code, message: err.message }, status);
  }
  console.error("[http] unhandled error:", err);
  return c.json({ error: "INTERNAL", message: (err as Error).message }, 500);
});

/** 解析工作区路径查询参数（缺失 → 可读错误） */
function requireWorkspaceQuery(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new WorkspaceError("WORKSPACE_INVALID_PATH", "缺少 path 查询参数（工作区绝对路径）");
  }
  return raw;
}

// —— 本机目录浏览 ——

/** 在后端所在机器上弹系统「选择文件夹」对话框，返回选中的绝对路径 */
app.post("/fs/pick-folder", async (c) => {
  // 诊断用：只看会跑什么命令，不真的弹框（避免在无人值守环境里挂住）
  if (c.req.query("probe") === "1") {
    return c.json({
      platform: process.platform,
      command: nativePickerCommand(process.platform),
    });
  }
  return c.json(await pickNativeFolder());
});

app.get("/fs/list", async (c) => {
  const raw = c.req.query("path");
  if (raw === undefined || raw.trim().length === 0) {
    const roots = await listFilesystemRoots();
    return c.json({ roots });
  }
  const result = await listDirectories(raw);
  return c.json(result);
});

// —— 工作区选择 / 初始化 ——

// 选定目录：只创建目录（或复现已有目录），MUST NOT 写入任何文件。
app.post("/workspace", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; create?: unknown };
  if (typeof body.path !== "string" || body.path.trim().length === 0) {
    return c.json({ error: "WORKSPACE_INVALID_PATH", message: "请求体必须包含 path（工作区绝对路径）" }, 400);
  }
  const dir = await ensureWorkspace(body.path, { create: body.create !== false });
  return c.json({ path: dir });
});

// 初始化状态：两件套各自是否存在（只读）
app.get("/workspace/status", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const status = await readWorkspaceInitStatus(workspace);
  return c.json(status);
});

// 显式初始化：幂等、只补缺失、绝不覆盖（用户点「初始化」才调）
app.post("/workspace/init", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { path?: unknown };
  if (typeof body.path !== "string" || body.path.trim().length === 0) {
    return c.json({ error: "WORKSPACE_INVALID_PATH", message: "请求体必须包含 path（工作区绝对路径）" }, 400);
  }
  const result = await initWorkspace(body.path);
  return c.json(result);
});

// —— 工作区内文件树 / 文件 / TODO ——

app.get("/workspace/tree", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  const rel = c.req.query("rel") ?? "/";
  const entries = await listDirectory(dir, rel);
  return c.json({ workspace: dir, path: rel, rel, entries });
});

app.get("/workspace/file", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  const rel = c.req.query("rel");
  if (!rel) {
    return c.json({ error: "PATH_INVALID", message: "缺少 rel 查询参数" }, 400);
  }
  const file = await readWorkspaceFile(dir, rel);
  return c.json({ workspace: dir, rel, ...file });
});

app.get("/workspace/todos", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  const snapshot = await readTodos(dir);
  return c.json({ workspace: dir, path: dir, exists: snapshot.exists, etag: snapshot.etag, file: snapshot.file });
});

app.put("/workspace/todos", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  const body = (await c.req.json().catch(() => null)) as
    | (TodoFile & { expectedEtag?: string | null })
    | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "TODO_INVALID_INPUT", message: "请求体必须是 JSON 对象" }, 400);
  }
  const { expectedEtag, ...file } = body;
  const { etag } = await writeTodos(dir, file as TodoFile, { expectedEtag });
  return c.json({ ok: true, workspace: dir, etag });
});

// —— Agent 注册表（tasks 1.1–1.8，契约见文件头注释）——

app.get("/agents", async (c) => {
  const result = await listAgents();
  return c.json(result);
});

app.post("/agents", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: unknown;
    name?: unknown;
    description?: unknown;
  };
  const id = await createAgent({
    id: body.id,
    name: typeof body.name === "string" ? body.name : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
  });
  return c.json({ id });
});

/** 当前工作区绑定的 agent 能联系哪些对端（受 contactableAgents 约束） */
app.get("/agents/contactable", async (c) => {
  const workspace = await resolveWorkspaceDir(requireWorkspaceQuery(c.req.query("path")));
  return c.json(await listContactableAgents(workspace));
});

app.get("/agents/:id", async (c) => {
  const def = await readAgent(c.req.param("id"));
  return c.json({
    id: def.id,
    name: def.name,
    description: def.description,
    config: def.config,
    persona: def.persona,
    memory: def.memory,
    skills: def.skills.map((s) => ({ name: s.name, description: s.description })),
  });
});

app.patch("/agents/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = await updateAgent(c.req.param("id"), {
    name: body["name"],
    description: body["description"],
    config: body["config"],
    persona: body["persona"],
    memory: body["memory"],
  });
  return c.json({ id });
});

app.delete("/agents/:id", async (c) => {
  await deleteAgent(c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/agents/:id/memory", async (c) => {
  const def = await readAgent(c.req.param("id"));
  // 返回**核心长期记忆**（MEMORY.md）；分层细节走 /memory/tree 与 /memory/file
  return c.json({ content: await readCoreMemory(def.dir) });
});

app.put("/agents/:id/memory", async (c) => {
  const def = await readAgent(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { content?: unknown };
  if (typeof body.content !== "string") {
    return c.json({ error: "AGENT_INVALID_CONFIG", message: "content 必须是字符串", field: "content" }, 400);
  }
  await writeCoreMemory(def.dir, body.content);
  return c.json({ ok: true });
});

// 分层记忆的树（核心 MEMORY.md + memory/ + digest/），供前端浏览（tasks 11.1 / 11.18）
app.get("/agents/:id/memory/tree", async (c) => {
  const def = await readAgent(c.req.param("id"));
  return c.json({ agentId: def.id, entries: await listMemoryTree(def.dir) });
});

// 读记忆目录下的某个文件（按需展开；越界或不存在 → 404）
app.get("/agents/:id/memory/file", async (c) => {
  const def = await readAgent(c.req.param("id"));
  const rel = c.req.query("rel");
  const read = await readMemoryFile(def.dir, rel ?? "");
  if (!read) {
    return c.json({ error: "MEMORY_FILE_NOT_FOUND", message: `记忆文件不存在或不可读：${rel ?? ""}` }, 404);
  }
  return c.json(read);
});

// —— 频道（tasks 13.1–13.8）：频道归属 agent 定义，所以挂在 /agents/:id 下 ——
//
// 返回「已配置 + 可添加」两组，并带上每个频道的字段定义 —— 界面**按字段定义自动渲染表单**，
// 以后加频道不用改页面。凭据一律只回掩码。

app.get("/agents/:id/channels", async (c) => {
  const def = await readAgent(c.req.param("id"));
  const { configured, available } = await listChannelViews(def.id, def.dir);
  const fields: Record<string, unknown> = {};
  for (const view of [...configured, ...available]) {
    fields[view.key] = channelFieldsFor(view.key);
  }
  return c.json({ agentId: def.id, configured, available, fields });
});

app.put("/agents/:id/channels/:key", async (c) => {
  const def = await readAgent(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as {
    enabled?: unknown;
    config?: unknown;
    secrets?: unknown;
  };
  const config =
    body.config && typeof body.config === "object" && !Array.isArray(body.config)
      ? (body.config as Record<string, unknown>)
      : {};
  const secrets =
    body.secrets && typeof body.secrets === "object" && !Array.isArray(body.secrets)
      ? Object.fromEntries(
          Object.entries(body.secrets as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  const channel = await upsertChannelView(def.id, def.dir, c.req.param("key"), {
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    config,
    secrets,
  });
  return c.json({ channel });
});

app.delete("/agents/:id/channels/:key", async (c) => {
  const def = await readAgent(c.req.param("id"));
  const ok = await deleteChannelView(def.id, def.dir, c.req.param("key"));
  return c.json({ ok });
});

app.get("/agents/:id/skills", async (c) => {
  const def = await readAgent(c.req.param("id"));
  return c.json({
    skills: def.skills.map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      disabled: s.disabled,
      overridesShared: s.overridesShared,
    })),
  });
});

/** 新增 agent **私有**技能（共享池里的技能是继承来的，只可开关不可删） */
app.post("/agents/:id/skills", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name: unknown;
    description?: unknown;
    content?: unknown;
  };
  const name = await createAgentSkill(c.req.param("id"), body);
  return c.json({ name });
});

/** 从本机文件夹导入技能（整份复制 SKILL.md 与附带资源） */
app.post("/agents/:id/skills/import", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    sourcePath: unknown;
    name?: unknown;
    target?: unknown;
  };
  const name = await importAgentSkill(c.req.param("id"), body);
  return c.json({ name });
});

/** 跨工作区调用：让对端 agent 在它自己的工作区里跑一轮，返回答复 */
app.post("/agents/:id/ask", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    path?: unknown;
    text?: unknown;
    sessionId?: unknown;
    callerThreadId?: unknown;
  };
  if (typeof body.path !== "string" || body.path.trim().length === 0) {
    return c.json({ error: "WORKSPACE_INVALID_PATH", message: "请求体必须包含 path（发起方工作区绝对路径）" }, 400);
  }
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return c.json({ error: "AGENT_INVALID_CONFIG", message: "请求体必须包含 text" }, 400);
  }
  const callerWorkspaceDir = await resolveWorkspaceDir(body.path);
  const result = await askAgent({
    callerWorkspaceDir,
    toAgentId: c.req.param("id"),
    text: body.text,
    ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
    ...(typeof body.callerThreadId === "string" ? { callerThreadId: body.callerThreadId } : {}),
  });
  return c.json(result);
});

/** 上传技能文件夹（multipart：字段名 = 相对路径；需要含 SKILL.md） */
app.post("/agents/:id/skills/upload", async (c) => {
  const form = await c.req.formData();
  const files: Array<{ path: string; data: Uint8Array }> = [];
  for (const [field, value] of form.entries()) {
    if (typeof value === "string") continue;
    files.push({ path: field, data: new Uint8Array(await value.arrayBuffer()) });
  }
  const name = await uploadAgentSkill(c.req.param("id"), {
    files,
    name: c.req.query("name"),
    target: c.req.query("target"),
  });
  return c.json({ name });
});

/** 读取单个技能的 SKILL.md 正文（点开看详情用） */
app.get("/agents/:id/skills/:name", async (c) => {
  const def = await readAgent(c.req.param("id"));
  const skill = def.skills.find((s) => s.name === c.req.param("name"));
  if (!skill) {
    return c.json({ error: "AGENT_SKILL_NOT_FOUND", message: `找不到技能：${c.req.param("name")}` }, 404);
  }
  const content = await readSkillContent(skill.dir);
  return c.json({
    name: skill.name,
    description: skill.description,
    source: skill.source,
    disabled: skill.disabled,
    overridesShared: skill.overridesShared,
    content: content ?? "",
  });
});

/** 启用 / 关闭某个技能（共享与私有都适用；只影响该 agent） */
app.put("/agents/:id/skills/:name", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "AGENT_INVALID_CONFIG", message: "enabled 必须是布尔值" }, 400);
  }
  const config = await setAgentSkillEnabled(c.req.param("id"), c.req.param("name"), body.enabled);
  return c.json({ name: c.req.param("name"), enabled: body.enabled, disabledSkills: config.disabledSkills });
});

/** 删除 agent 私有技能 */
app.delete("/agents/:id/skills/:name", async (c) => {
  await deleteAgentSkill(c.req.param("id"), c.req.param("name"));
  return c.json({ ok: true });
});

/** 初始化：幂等创建 4 位个人助理（已存在的目录不动，不覆盖用户改动） */
app.post("/agents/ensure-personal", async (c) => {
  return c.json(await ensurePersonalAssistants());
});

// —— 子 agent 团队（specs/subagent-team）——
//
// 契约见 `spike/findings/04-team-page.md` §3.2（**前端按同一份契约并行实现，形状不要改**）：
// ① 列表：非法声明照样进 `members`，用 `valid:false` + `issues` 标注（不拖垮整体加载）；
// ② 更新：合并 = 当前 frontmatter ⊕ patch，**整体校验通过才写**（原子写，失败一个字节都不动）；
// ③ 新建：description 必填（它是路由依据），骨架里**不写** tools/model/skills（保持「未声明 = 继承」）。
// 错误码：AGENT_NOT_FOUND / SUBAGENT_INVALID_ID / SUBAGENT_ALREADY_EXISTS /
//         SUBAGENT_NOT_FOUND / SUBAGENT_INVALID_SPEC（带 field），由 onError 统一出口。

app.get("/agents/:id/team", async (c) => {
  return c.json(await listTeam(c.req.param("id")));
});

app.get("/agents/:id/team/:name", async (c) => {
  const member = await readSubAgent(c.req.param("id"), c.req.param("name"));
  return c.json({ member });
});

app.post("/agents/:id/team", async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const name = await createSubAgent(c.req.param("id"), {
    name: body["name"],
    description: body["description"],
    systemPrompt: body["systemPrompt"],
  });
  return c.json({ name });
});

app.put("/agents/:id/team/:name", async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const member = await updateSubAgent(c.req.param("id"), c.req.param("name"), body);
  return c.json({ name: member.name, member });
});

// —— 工作区绑定（tasks 1.9–1.12）——

app.get("/workspace/binding", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  return c.json(await readBindingView(workspace));
});

app.put("/workspace/binding", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    path?: unknown;
    agentId?: unknown;
    mode?: unknown;
  };
  if (typeof body.path !== "string" || body.path.trim().length === 0) {
    return c.json(
      { error: "WORKSPACE_INVALID_PATH", message: "请求体必须包含 path（工作区绝对路径）" },
      400,
    );
  }
  if (typeof body.agentId !== "string" || body.agentId.trim().length === 0) {
    return c.json({ error: "AGENT_INVALID_ID", message: "请求体必须包含 agentId" }, 400);
  }
  const mode = body.mode === "archive" ? "archive" : "keep";
  const result = await writeBinding(body.path, body.agentId, { mode, reason: "user" });
  return c.json({ agentId: result.binding.agentId });
});

// —— 会话库（会话内容的工作区事实源：`<工作区>/.open-assistant/sessions.sqlite`）——
//
// 内容由 `workspaceMiddleware.afterAgent` 在一轮结束时落库（见 conversation/recording.ts）。
// 这里只读 / 删：列表给会话列表用，详情给冷会话重建用。
// 动态 import：不碰 SQLite 的调用方（如纯 JSON 单测）不必加载 `node:sqlite`。

/** 解析带上下限的整数查询参数（非法 / 越界一律取默认或夹紧） */
function intQuery(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 列出某工作区的会话（会话库记录 + 平台实时状态叠加；缺的历史 thread 会被导入） */
app.get("/workspace/sessions", async (c) => {
  const workspace = await resolveWorkspaceDir(requireWorkspaceQuery(c.req.query("path")));
  const limit = intQuery(c.req.query("limit"), 50, 1, 200);
  const offset = intQuery(c.req.query("offset"), 0, 0, 100_000);
  const { listWorkspaceSessions } = await import("./conversation/session-list.js");
  return c.json({ sessions: await listWorkspaceSessions(workspace, { limit, offset }) });
});

/** 单条会话：会话行 + 轮次 + 消息（冷会话据此重建） */
app.get("/workspace/sessions/:id", async (c) => {
  const workspace = await resolveWorkspaceDir(requireWorkspaceQuery(c.req.query("path")));
  const id = c.req.param("id");
  const { getThread, listTurns, readThreadMessages } = await import("./conversation/index.js");
  const thread = getThread(workspace, id);
  if (!thread) {
    return c.json({ error: "SESSION_NOT_FOUND", message: `找不到会话: ${id}` }, 404);
  }
  return c.json({
    thread,
    turns: listTurns(workspace, id),
    messages: readThreadMessages(workspace, id),
  });
});

/** 删除会话（默认连带子会话；子会话处置见 store.deleteThread） */
app.delete("/workspace/sessions/:id", async (c) => {
  const workspace = await resolveWorkspaceDir(requireWorkspaceQuery(c.req.query("path")));
  const id = c.req.param("id");
  const { deleteThread, getThread } = await import("./conversation/index.js");
  if (!getThread(workspace, id)) {
    return c.json({ error: "SESSION_NOT_FOUND", message: `找不到会话: ${id}` }, 404);
  }
  return c.json(deleteThread(workspace, id));
});

/** 重命名会话（body `{ title }`；null / 空串 = 清空，回到默认标题） */
app.patch("/workspace/sessions/:id", async (c) => {
  const workspace = await resolveWorkspaceDir(requireWorkspaceQuery(c.req.query("path")));
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
  if (body.title !== null && body.title !== undefined && typeof body.title !== "string") {
    return c.json({ error: "SESSION_INVALID_TITLE", message: "title 必须是字符串或 null" }, 400);
  }
  const { getThread, updateThreadTitle } = await import("./conversation/index.js");
  if (!getThread(workspace, id)) {
    return c.json({ error: "SESSION_NOT_FOUND", message: `找不到会话: ${id}` }, 404);
  }
  const trimmed = typeof body.title === "string" ? body.title.trim() : null;
  const updated = updateThreadTitle(workspace, id, trimmed && trimmed.length > 0 ? trimmed : null);
  return c.json({ thread: updated });
});

/** 冷会话重放窗口：摘要 + 窗口内轮次消息（重开冷会话时用它起一条新线程） */
app.get("/workspace/sessions/:id/replay", async (c) => {
  const workspace = await resolveWorkspaceDir(requireWorkspaceQuery(c.req.query("path")));
  const id = c.req.param("id");
  const { buildReplayContext, getThread } = await import("./conversation/index.js");
  if (!getThread(workspace, id)) {
    return c.json({ error: "SESSION_NOT_FOUND", message: `找不到会话: ${id}` }, 404);
  }
  const keep = c.req.query("keepRecentTurns");
  const context = buildReplayContext(
    workspace,
    id,
    keep === undefined ? {} : { keepRecentTurns: intQuery(keep, 0, 0, 1000) },
  );
  return c.json(context);
});

/** 手动触发压缩（排查 / 测试用；正常由落库路径按阈值自动触发） */
app.post("/workspace/sessions/:id/compact", async (c) => {
  const workspace = await resolveWorkspaceDir(requireWorkspaceQuery(c.req.query("path")));
  const id = c.req.param("id");
  const { DEFAULT_COMPACTION_CONFIG, compactThread, getThread } = await import(
    "./conversation/index.js"
  );
  if (!getThread(workspace, id)) {
    return c.json({ error: "SESSION_NOT_FOUND", message: `找不到会话: ${id}` }, 404);
  }
  const keep = intQuery(c.req.query("keepRecentTurns"), DEFAULT_COMPACTION_CONFIG.keepRecentTurns, 0, 1000);
  return c.json({ compaction: compactThread(workspace, id, { keepRecentTurns: keep }) });
});

/** 在会话里检索消息（被压缩内容仍在库中，可检索） */
app.get("/workspace/sessions/:id/search", async (c) => {
  const workspace = await resolveWorkspaceDir(requireWorkspaceQuery(c.req.query("path")));
  const id = c.req.param("id");
  const { getThread, searchThreadMessages } = await import("./conversation/index.js");
  if (!getThread(workspace, id)) {
    return c.json({ error: "SESSION_NOT_FOUND", message: `找不到会话: ${id}` }, 404);
  }
  return c.json({ messages: searchThreadMessages(workspace, id, c.req.query("q") ?? "") });
});

// —— 智能体档案 / 工作区归属（1:1）——
//
// 契约见 apps/web/src/lib/agentProfilesApi.ts。规则在 agents/registry.ts：
// agent ↔ 工作区目录 1:1，一个目录只能绑一位；默认 agent 不能停用。

/** 选择器要的名单：所有 agent + 各自的工作区目录 + 当前工作区用的是谁 */
app.get("/agent-profiles", async (c) => {
  const workspace = c.req.query("workspace");
  return c.json(await readAgentProfilesView(typeof workspace === "string" ? workspace : ""));
});

/** 给 agent 指定 / 解除工作区目录（1:1 冲突会返回 409） */
app.put("/agents/:id/workspace", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { workspaceDir?: unknown };
  const value = body.workspaceDir;
  if (value !== null && typeof value !== "string") {
    return c.json(
      { error: "AGENT_INVALID_CONFIG", message: "workspaceDir 必须是字符串或 null" },
      400,
    );
  }
  const config = await setAgentWorkspaceDir(c.req.param("id"), value);
  return c.json({ id: c.req.param("id"), workspaceDir: config.workspaceDir });
});

app.put("/agents/:id/enabled", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
  const config = await setAgentEnabled(c.req.param("id"), body.enabled === true);
  return c.json({ id: c.req.param("id"), enabled: config.enabled });
});

app.put("/agents/:id/pinned", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { pinned?: unknown };
  const config = await setAgentPinned(c.req.param("id"), body.pinned === true);
  return c.json({ id: c.req.param("id"), pinned: config.pinned });
});

// —— 定时任务（按工作区，tasks 10.1–10.5 / 10.8；字段契约见 apps/web/src/lib/jobsApi.ts）——

/** 计算一次「首次/重置后」的下一次触发时刻（不含宽限补跑逻辑） */
function initialNextRunAt(spec: ReturnType<typeof normalizeJobSpec>, from: Date): string | null {
  if (spec.schedule.kind === "once") {
    return spec.schedule.at ?? null;
  }
  const next = spec.schedule.cron
    ? cronNext(spec.schedule.cron, spec.schedule.timezone, from)
    : null;
  return next ? next.toISOString() : null;
}

function readPathFromBody(body: Record<string, unknown>): string | undefined {
  return typeof body.path === "string" ? body.path : undefined;
}

app.get("/jobs", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  if (process.env.OPEN_ASSISTANT_DISABLE_JOBS_SCHEDULER !== "1") {
    ensureSchedulerStarted(dir);
  }
  const snapshot = await readJobs(dir);
  return c.json({ workspace: dir, exists: snapshot.exists, jobs: snapshot.file.jobs });
});

app.post("/jobs", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const workspace = typeof c.req.query("path") === "string" ? c.req.query("path") : readPathFromBody(body);
  const dir = await resolveWorkspaceDir(requireWorkspaceQuery(workspace));
  const providedId = typeof body.id === "string" && body.id.length > 0 ? body.id : undefined;
  const id = providedId ?? crypto.randomUUID();
  const { path: _path, ...rest } = body;
  const spec = normalizeJobSpec({ ...rest, id }, { requireId: true });
  spec.nextRunAt = initialNextRunAt(spec, new Date());
  await createJobRecord(dir, spec);
  return c.json({ id: spec.id });
});

app.patch("/jobs/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const workspace = typeof c.req.query("path") === "string" ? c.req.query("path") : readPathFromBody(body);
  const dir = await resolveWorkspaceDir(requireWorkspaceQuery(workspace));
  const id = c.req.param("id");
  const existing = await getJob(dir, id);
  if (!existing) {
    throw new JobError("JOB_NOT_FOUND", `任务不存在: ${id}`, 404);
  }
  const { path: _path, id: _id, ...patch } = body;
  const spec = normalizeJobSpec(applyJobPatch(existing, patch), { requireId: true });
  // 改了触发规则就重算下一次；只启停/改内容时保留既有 nextRunAt（含错过状态）
  if (Object.prototype.hasOwnProperty.call(patch, "schedule")) {
    spec.nextRunAt = initialNextRunAt(spec, new Date());
  }
  await replaceJobRecord(dir, spec);
  return c.json({ ok: true, job: spec });
});

app.delete("/jobs/:id", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  await deleteJobRecord(dir, c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/jobs/:id/run", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  const id = c.req.param("id");
  const job = await getJob(dir, id);
  if (!job) {
    throw new JobError("JOB_NOT_FOUND", `任务不存在: ${id}`, 404);
  }
  const outcome = await runJobNow({ workspace: dir, job, reason: "manual" });
  return c.json({ ok: true, status: outcome.status, message: outcome.message ?? null });
});

// —— 项目记忆（tasks 10.6 / 11.9–11.17）——工作区级，落在 `wiki/index.md` ——

// 返回 `wiki/index.md` 的内容（迁移后语义一致）；wiki 尚未建立时回退旧单文件。
app.get("/memory/project", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  return c.json({ content: await readProjectMemory(dir) });
});

app.put("/memory/project", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; content?: unknown };
  const workspace = typeof c.req.query("path") === "string" ? c.req.query("path") : readPathFromBody(body);
  const dir = await resolveWorkspaceDir(requireWorkspaceQuery(workspace));
  if (typeof body.content !== "string") {
    return c.json({ error: "JOB_INVALID_INPUT", message: "content 必须是字符串", field: "content" }, 400);
  }
  await writeProjectMemory(dir, body.content);
  return c.json({ ok: true });
});

// —— 项目 wiki（tasks 11.9–11.17）——工作区根的 `wiki/` 目录 ——

// SCHEMA.md 解析结果（实体类型 / 目录约定 / 页面字段）+ 原文
app.get("/wiki/schema", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  const schema = await loadWikiSchema(dir);
  return c.json({ workspace: dir, schema });
});

// 内容目录（提问先读它）；wiki 不存在 → content: null（视为空，不报错）
app.get("/wiki/index", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  return c.json({ workspace: dir, content: await readWikiIndex(dir) });
});

// 时间线最近 N 条（等价于 `grep "^## \[" wiki/log.md | tail -N`）
app.get("/wiki/log", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  const rawLimit = Number.parseInt(c.req.query("limit") ?? "20", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 20;
  const content = (await readWikiLog(dir)) ?? "";
  return c.json({ workspace: dir, limit, entries: latestLogEntries(content, limit) });
});

// wiki 页面清单 + 源层文件清单（文件树之外的结构化视图）
app.get("/wiki/pages", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  const [pages, sources] = await Promise.all([listWikiPages(dir), listSourceFiles(dir)]);
  return c.json({
    workspace: dir,
    pages: pages.map((p) => ({ path: p.path, title: p.title, type: p.type, sources: p.sources })),
    // 兼容字段名：历史上叫 raw，现在语义是「源层 = 工作区里用户自己的文件」
    sources: sources.map((path) => ({ path })),
    raw: sources.map((path) => ({ path })),
  });
});

// 知识图谱（tasks 12.1–12.8）：节点 + 边；缺图时按需重建一次
app.get("/wiki/graph", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  if (c.req.query("rebuild") === "1") await rebuildGraph(dir);
  const graph = await loadGraph(dir);
  return c.json({ workspace: dir, ...graph });
});

// 全量重建图谱（原子：先算完整张图再一次性写文件）
app.post("/wiki/graph/rebuild", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { path?: string };
  const workspace = requireWorkspaceQuery(body.path);
  const dir = await resolveWorkspaceDir(workspace);
  const result = await rebuildGraph(dir);
  return c.json({ workspace: dir, ...result });
});

// 体检：只报告不改内容（tasks 11.17）
app.get("/wiki/lint", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  return c.json(await lintWiki(dir));
});

// 收录（tasks 11.13）：摘要页 + 实体页 + index + log
app.post("/wiki/ingest", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    path?: unknown;
    rawPath?: unknown;
    title?: unknown;
    summary?: unknown;
    body?: unknown;
    entities?: unknown;
    date?: unknown;
  };
  const dir = await resolveWorkspaceDir(requireWorkspaceQuery(readPathFromBody(body)));
  if (typeof body.rawPath !== "string" || body.rawPath.trim().length === 0) {
    return c.json({ error: "WIKI_INVALID_INPUT", message: "rawPath 必须是字符串", field: "rawPath" }, 400);
  }
  const entities = Array.isArray(body.entities) ? (body.entities as IngestEntityInput[]) : undefined;
  const result = await ingestRawDocument(dir, {
    rawPath: body.rawPath,
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
    ...(typeof body.body === "string" ? { body: body.body } : {}),
    ...(typeof body.date === "string" ? { date: body.date } : {}),
    ...(entities ? { entities } : {}),
  });
  return c.json(result);
});

// 答案回填（tasks 11.16）：把一次分析归档成新页
app.post("/wiki/archive", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    path?: unknown;
    title?: unknown;
    content?: unknown;
    kind?: unknown;
    sources?: unknown;
    links?: unknown;
    mode?: unknown;
  };
  const dir = await resolveWorkspaceDir(requireWorkspaceQuery(readPathFromBody(body)));
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return c.json({ error: "WIKI_INVALID_INPUT", message: "title 必须是字符串", field: "title" }, 400);
  }
  if (typeof body.content !== "string") {
    return c.json({ error: "WIKI_INVALID_INPUT", message: "content 必须是字符串", field: "content" }, 400);
  }
  const result = await archiveAnswer(dir, {
    title: body.title,
    content: body.content,
    ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
    ...(Array.isArray(body.sources) ? { sources: body.sources.map(String) } : {}),
    ...(Array.isArray(body.links) ? { links: body.links.map(String) } : {}),
    ...(body.mode === "new" || body.mode === "update" ? { mode: body.mode } : {}),
  });
  return c.json(result);
});

// —— 模型配置（供应商 / 模型清单 / 能力位 / 工作区选中项）——
//
// 安全约定：**apiKey 明文只进不出**。所有返回体里的 key 都是掩码，
// 前端改 key 时提交新值（提交掩码会被忽略，见 models/index.ts 的 isMasked）。

app.get("/models", async (c) => {
  return c.json(await getOverview());
});

app.post("/models/providers", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const provider = await upsertProvider({
    id: body["id"],
    kind: body["kind"],
    name: body["name"],
    baseUrl: body["baseUrl"],
    apiKey: body["apiKey"],
    enabled: body["enabled"],
    models: body["models"],
  });
  return c.json({ provider });
});

app.delete("/models/providers/:id", async (c) => {
  await deleteProvider(c.req.param("id"));
  return c.json({ ok: true });
});

// 拉远端模型清单：只读（不写盘），失败的 error 原样带回给界面展示
app.post("/models/providers/:id/discover", async (c) => {
  return c.json(await discoverModels(c.req.param("id")));
});

// 把（远端/手工）模型加进该供应商的清单：这是「写」，与上面的刷新分开
app.post("/models/providers/:id/models", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { models?: unknown };
  const provider = await addProviderModels(
    c.req.param("id"),
    Array.isArray(body.models) ? body.models.map(String) : [],
  );
  return c.json({ provider });
});

app.post("/models/providers/:id/test", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { modelId?: unknown };
  const result = await testProvider(
    c.req.param("id"),
    typeof body.modelId === "string" ? body.modelId : undefined,
  );
  return c.json(result);
});

app.put("/models/default", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    providerId?: unknown;
    modelId?: unknown;
  };
  if (typeof body.providerId !== "string" || typeof body.modelId !== "string") {
    return c.json(
      { error: "MODEL_INVALID_CONFIG", message: "请求体必须包含 providerId 与 modelId", field: "providerId" },
      400,
    );
  }
  await setDefaultModel(body.providerId, body.modelId);
  return c.json({ ok: true });
});

// 视觉探针：真的发一张纯色小图过去看它认不认得（结论落进能力缓存）
app.post("/models/capability/probe", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    providerId?: unknown;
    modelId?: unknown;
  };
  if (typeof body.providerId !== "string" || typeof body.modelId !== "string") {
    return c.json(
      { error: "MODEL_INVALID_CONFIG", message: "请求体必须包含 providerId 与 modelId", field: "modelId" },
      400,
    );
  }
  return c.json(await probeModelCapability(body.providerId, body.modelId));
});

// 手动指定能力位（最高优先级：用户比我们更清楚这个模型的情况）
app.put("/models/capability", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    providerId?: unknown;
    modelId?: unknown;
    vision?: unknown;
  };
  if (typeof body.providerId !== "string" || typeof body.modelId !== "string") {
    return c.json(
      { error: "MODEL_INVALID_CONFIG", message: "请求体必须包含 providerId 与 modelId", field: "modelId" },
      400,
    );
  }
  if (typeof body.vision !== "boolean") {
    return c.json({ error: "MODEL_INVALID_CONFIG", message: "vision 必须是布尔值", field: "vision" }, 400);
  }
  const capability = await setModelCapability(body.providerId, body.modelId, body.vision);
  return c.json({ capability });
});

app.delete("/models/capability", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    providerId?: unknown;
    modelId?: unknown;
  };
  if (typeof body.providerId !== "string" || typeof body.modelId !== "string") {
    return c.json(
      { error: "MODEL_INVALID_CONFIG", message: "请求体必须包含 providerId 与 modelId", field: "modelId" },
      400,
    );
  }
  await clearModelCapability(body.providerId, body.modelId);
  return c.json({ ok: true });
});

// 对话页顶部「模型」下拉：读当前工作区这轮真正会用的模型
app.get("/models/selection", async (c) => {
  const workspace = requireWorkspaceQuery(c.req.query("path"));
  const dir = await resolveWorkspaceDir(workspace);
  return c.json(await getSelection(workspace, dir));
});

// 选中模型写进绑定 agent 的 config.json（下一轮生效，无需重启）
app.put("/models/selection", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    path?: unknown;
    providerId?: unknown;
    modelId?: unknown;
  };
  const workspace = requireWorkspaceQuery(readPathFromBody(body));
  const dir = await resolveWorkspaceDir(workspace);
  if (typeof body.providerId !== "string" || typeof body.modelId !== "string") {
    return c.json(
      { error: "MODEL_INVALID_CONFIG", message: "请求体必须包含 providerId 与 modelId", field: "providerId" },
      400,
    );
  }
  await setSelection(dir, body.providerId, body.modelId);
  return c.json(await getSelection(workspace, dir));
});

// 便于 `bun run scripts/*` / 单测直接调用，而不必起 server。
export default app;