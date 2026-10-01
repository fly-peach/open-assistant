import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  APP_DATA_DIR,
  PERSONA_FILE,
  WorkspaceError,
  ensureAppDataDir,
  ensureWorkspace,
  isFilesystemRoot,
  listDirectories,
  listDirectory,
  listFilesystemRoots,
  normalizeWorkspacePath,
  readWorkspaceFile,
  resolveWorkspaceDir,
  resolveWorkspacePath,
  workspaceAppDataDir,
  workspaceSessionIndexPath,
  workspaceTodosPath,
} from "../src/workspace.js";
import { createThreadForWorkspace, readWorkspaceSessionIndex, upsertWorkspaceSessionIndex } from "../src/sessions.js";

let root: string;

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-ws-")));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** 递归快照目录内容（含隐藏文件），用于断言「一个字节都没变」 */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
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

async function newWorkspaceDir(name: string): Promise<string> {
  const p = path.join(root, name);
  await fs.mkdir(p, { recursive: true });
  return p;
}

describe("8.1 工作区解析：绝对路径 → 目录", () => {
  test("绝对路径可用；相对路径被拒绝", async () => {
    const p = await newWorkspaceDir("abs-ws");
    const dir = await resolveWorkspaceDir(p);
    expect(dir).toBe(await fs.realpath(p));

    const relErr = await resolveWorkspaceDir("relative/ws").catch((e) => e);
    expect(relErr).toBeInstanceOf(WorkspaceError);
    expect((relErr as WorkspaceError).code).toBe("WORKSPACE_INVALID_PATH");

    expect(() => normalizeWorkspacePath("a/b")).toThrow(WorkspaceError);
    expect(() => normalizeWorkspacePath("")).toThrow(WorkspaceError);
    expect(() => normalizeWorkspacePath(undefined)).toThrow(WorkspaceError);
  });

  test("不存在的路径：resolve 报 404，ensure 可创建", async () => {
    const p = path.join(root, "not-yet");
    const err = await resolveWorkspaceDir(p).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).code).toBe("WORKSPACE_MISSING");
    expect((err as WorkspaceError).status).toBe(404);

    const created = await ensureWorkspace(p);
    expect(created).toBe(await fs.realpath(p));
    expect((await fs.stat(created)).isDirectory()).toBe(true);

    // create:false 时不创建
    const p2 = path.join(root, "no-create");
    const err2 = await ensureWorkspace(p2, { create: false }).catch((e) => e);
    expect((err2 as WorkspaceError).code).toBe("WORKSPACE_MISSING");
  });
});

describe("8.2 路径校验：存在 / 是目录 / 可读写", () => {
  test("不是目录 → WORKSPACE_NOT_DIR", async () => {
    const filePath = path.join(root, "as-file");
    await fs.writeFile(filePath, "not a dir", "utf8");
    const dirErr = await resolveWorkspaceDir(filePath).catch((e) => e);
    expect((dirErr as WorkspaceError).code).toBe("WORKSPACE_NOT_DIR");
    const ensureErr = await ensureWorkspace(filePath).catch((e) => e);
    expect((ensureErr as WorkspaceError).code).toBe("WORKSPACE_NOT_DIR");
  });

  test("不可读 / 不可写目录被拒绝（POSIX；root 身份下跳过）", async () => {
    if (process.platform === "win32") return;
    const readOnly = await newWorkspaceDir("readonly");
    await fs.chmod(readOnly, 0o555);
    try {
      const writable = await fs
        .access(readOnly, fs.constants.W_OK)
        .then(() => true)
        .catch(() => false);
      if (!writable) {
        const err = await resolveWorkspaceDir(readOnly).catch((e) => e);
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).code).toBe("WORKSPACE_NOT_WRITABLE");
      }
    } finally {
      await fs.chmod(readOnly, 0o755);
    }

    const noRead = await newWorkspaceDir("noread");
    await fs.chmod(noRead, 0o000);
    try {
      const readable = await fs
        .access(noRead, fs.constants.R_OK)
        .then(() => true)
        .catch(() => false);
      if (!readable) {
        const err = await resolveWorkspaceDir(noRead).catch((e) => e);
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).code).toBe("WORKSPACE_UNREADABLE");
      }
    } finally {
      await fs.chmod(noRead, 0o755);
    }
  });
});

describe("8.3 拒绝文件系统根", () => {
  test("文件系统根被拒绝且错误可读", async () => {
    const rootPath = path.parse(process.cwd()).root;
    expect(isFilesystemRoot(rootPath)).toBe(true);
    expect(isFilesystemRoot(rootPath + path.sep)).toBe(true);
    expect(isFilesystemRoot(root)).toBe(false);

    expect(() => normalizeWorkspacePath(rootPath)).toThrow(WorkspaceError);
    const err = await resolveWorkspaceDir(rootPath).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).code).toBe("WORKSPACE_FS_ROOT");
    expect((err as WorkspaceError).message).toMatch(/根|磁盘/);

    if (process.platform === "win32") {
      expect(isFilesystemRoot("Z:\\")).toBe(true);
      expect(isFilesystemRoot("z:/")).toBe(true);
      expect(isFilesystemRoot("Z:\\Windows")).toBe(false);
    } else {
      expect(isFilesystemRoot("/")).toBe(true);
      expect(isFilesystemRoot("/usr")).toBe(false);
    }
  });
});

describe("8.4 realpath 归一化判重", () => {
  test("同一目录的不同写法 → 同一身份", async () => {
    const p = await newWorkspaceDir("Normalize");
    const real = await fs.realpath(p);
    expect(await resolveWorkspaceDir(p)).toBe(real);
    expect(await resolveWorkspaceDir(p + path.sep)).toBe(real);
    expect(await resolveWorkspaceDir(path.join(p, "sub", ".."))).toBe(real);
    expect(await resolveWorkspaceDir(path.join(p, "..", "Normalize"))).toBe(real);
    if (process.platform === "win32") {
      // 大小写不敏感：不同大小写写法必须归一到同一 realpath
      expect(await resolveWorkspaceDir(p.toUpperCase())).toBe(real);
    }
  });
});

describe("8.5 本机目录浏览", () => {
  test("listFilesystemRoots 返回至少一个根，且都是根", async () => {
    const roots = await listFilesystemRoots();
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) expect(isFilesystemRoot(r)).toBe(true);
  });

  test("listDirectories 只列目录、返回 parent、realpath 归一", async () => {
    const p = await newWorkspaceDir("browse");
    await fs.mkdir(path.join(p, "sub1"), { recursive: true });
    await fs.mkdir(path.join(p, "sub2"), { recursive: true });
    await fs.mkdir(path.join(p, ".hidden"), { recursive: true });
    await fs.writeFile(path.join(p, "file.txt"), "x", "utf8");

    const res = await listDirectories(p);
    expect(res.path).toBe(await fs.realpath(p));
    expect(res.parent).toBe(path.dirname(await fs.realpath(p)));
    const names = res.entries.map((e) => e.name);
    expect(names).toContain("sub1");
    expect(names).toContain("sub2");
    expect(names).toContain(".hidden");
    expect(names).not.toContain("file.txt");
    for (const entry of res.entries) expect(path.isAbsolute(entry.path)).toBe(true);

    const missing = await listDirectories(path.join(root, "no-such-dir")).catch((e) => e);
    expect((missing as WorkspaceError).code).toBe("PATH_NOT_FOUND");

    const fileErr = await listDirectories(path.join(p, "file.txt")).catch((e) => e);
    expect((fileErr as WorkspaceError).code).toBe("PATH_NOT_DIR");
  });

  test("根目录浏览 parent 为 null", async () => {
    const rootPath = path.parse(process.cwd()).root;
    try {
      const res = await listDirectories(rootPath);
      expect(res.parent).toBe(null);
    } catch (err) {
      // 某些环境下列举根可能被拒绝，此时断言错误可读即可（不整体崩溃）
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe("FS_LIST_FAILED");
    }
  });

  test("无权限目录 → 可读提示而非崩溃（POSIX；root 身份下跳过）", async () => {
    if (process.platform === "win32") return;
    const p = await newWorkspaceDir("denied");
    await fs.chmod(p, 0o000);
    try {
      const readable = await fs
        .access(p, fs.constants.R_OK)
        .then(() => true)
        .catch(() => false);
      if (readable) return;
      const err = await listDirectories(p).catch((e) => e);
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe("FS_LIST_FAILED");
      expect((err as WorkspaceError).message.length).toBeGreaterThan(0);
    } finally {
      await fs.chmod(p, 0o755);
    }
  });
});

describe("8.6 应用数据落在 <工作区>/.open-assistant/", () => {
  test("会话索引写在工作区应用数据子目录，不散落到工作区根", async () => {
    const p = await newWorkspaceDir("appdata-ws");
    await ensureWorkspace(p);
    const real = await fs.realpath(p);
    const appDir = workspaceAppDataDir(p);
    expect(appDir).toBe(path.join(real, APP_DATA_DIR));
    expect(await ensureAppDataDir(p)).toBe(appDir);

    await upsertWorkspaceSessionIndex(p, { id: "thread-1" });
    const indexPath = workspaceSessionIndexPath(p);
    expect(indexPath.startsWith(appDir)).toBe(true);

    const index = await readWorkspaceSessionIndex(p);
    expect(index.sessions.map((s) => s.id)).toContain("thread-1");

    const rootEntries = await fs.readdir(real);
    expect(rootEntries).not.toContain("sessions.json");
    expect(rootEntries).not.toContain("config.json");
    expect(rootEntries).toContain(APP_DATA_DIR);

    // 幂等 upsert
    await upsertWorkspaceSessionIndex(p, { id: "thread-1" });
    const again = await readWorkspaceSessionIndex(p);
    expect(again.sessions.filter((s) => s.id === "thread-1").length).toBe(1);
  });

  test("createThreadForWorkspace：归属写绝对路径，索引落应用数据目录", async () => {
    const p = await newWorkspaceDir("thread-index");
    await ensureWorkspace(p);
    const real = await fs.realpath(p);
    const calls: Array<{ metadata?: Record<string, unknown> }> = [];
    const fakeClient = {
      threads: {
        create: async (opts: { metadata?: Record<string, unknown> }) => {
          calls.push(opts);
          return { thread_id: "t-1", created_at: new Date().toISOString(), metadata: opts.metadata };
        },
      },
    } as unknown as Parameters<typeof createThreadForWorkspace>[0];

    const thread = await createThreadForWorkspace(fakeClient, p);
    expect(calls[0]!.metadata?.["workspace"]).toBe(real);
    expect(thread.thread_id).toBe("t-1");

    const index = await readWorkspaceSessionIndex(p);
    expect(index.sessions.map((s) => s.id)).toContain("t-1");
    expect((await fs.readdir(real)).includes("sessions.json")).toBe(false);
  });
});

describe("8.7 / 9.1 选定目录时不写入任何文件", () => {
  test("空目录：ensureWorkspace 一个文件也不写", async () => {
    const p = await newWorkspaceDir("empty-skeleton");
    const before = await snapshotTree(p);
    const dir = await ensureWorkspace(p);
    await ensureWorkspace(p);
    const after = await snapshotTree(p);
    expect(after).toEqual(before);
    expect(after).toEqual({});
    expect(await fs.readdir(dir)).toEqual([]);
  });

  test("非空目录：一个字节都没变", async () => {
    const p = await newWorkspaceDir("nonempty");
    await fs.mkdir(path.join(p, "keep"), { recursive: true });
    await fs.writeFile(path.join(p, "keep", "a.txt"), "hello", "utf8");
    await fs.writeFile(path.join(p, "root.txt"), "root", "utf8");
    await fs.writeFile(path.join(p, ".dotfile"), "dot", "utf8");
    // 已有的人设文件也不能被覆盖
    await fs.writeFile(path.join(p, PERSONA_FILE), "# 我的人设\n", "utf8");

    const before = await snapshotTree(p);
    await ensureWorkspace(p);
    await ensureWorkspace(p);
    const after = await snapshotTree(p);
    expect(after).toEqual(before);
    expect(Object.keys(after)).not.toContain(APP_DATA_DIR + "/");
  });
});

describe("8.12 旧 id 工作区作为绝对路径仍可选用", () => {
  test("旧 `.workspaces/<id>` 目录可直接以路径打开且文件树正常", async () => {
    const legacy = path.join(root, ".workspaces", "default");
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "notes.md"), "# legacy", "utf8");

    const dir = await resolveWorkspaceDir(legacy);
    expect(dir).toBe(await fs.realpath(legacy));
    const entries = await listDirectory(dir, "/");
    const names = entries.map((e) => e.name);
    expect(names).toContain("notes.md");

    // 浏览器里也能从工作区根逐层进入旧工作区
    const browse = await listDirectories(path.join(root, ".workspaces"));
    expect(browse.entries.map((e) => e.name)).toContain("default");
  });
});

describe("1.7 列举目录一层（工作区内虚拟路径）", () => {
  test("目录优先、跳过隐藏与 node_modules", async () => {
    const dir = await ensureWorkspace(path.join(root, "tree-a"));
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.writeFile(path.join(dir, "b.md"), "b", "utf8");
    await fs.writeFile(path.join(dir, "a.txt"), "a", "utf8");

    const entries = await listDirectory(dir, "/");
    const names = entries.map((e) => e.name);
    expect(names[0]).toBe("sub");
    expect(names).toContain("a.txt");
    expect(names).toContain("b.md");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(entries[0]!.type).toBe("directory");
    expect(entries[0]!.path).toBe("/sub");
    // 不递归：子目录内容不计入
    await fs.writeFile(path.join(dir, "sub", "deep.txt"), "deep", "utf8");
    const again = await listDirectory(dir, "/");
    expect(again.map((e) => e.name)).not.toContain("deep.txt");
  });

  test("列举大目录耗时与子目录内容无关（只读一层）", async () => {
    const dir = await ensureWorkspace(path.join(root, "tree-big"));
    const heavy = path.join(dir, "heavy");
    await fs.mkdir(heavy, { recursive: true });
    await Promise.all(
      Array.from({ length: 400 }, (_, i) => fs.writeFile(path.join(heavy, `f${i}.txt`), "x", "utf8")),
    );
    await fs.writeFile(path.join(dir, "top.txt"), "t", "utf8");

    const start = performance.now();
    const entries = await listDirectory(dir, "/");
    const elapsed = performance.now() - start;
    expect(entries[0]!.name).toBe("heavy");
    expect(entries.map((e) => e.name)).toContain("top.txt");
    expect(elapsed).toBeLessThan(500);
  });
});

describe("1.8 读取文件与路径约束", () => {
  test("读取工作区内文件", async () => {
    const dir = await ensureWorkspace(path.join(root, "read-a"));
    await fs.mkdir(path.join(dir, "notes"), { recursive: true });
    await fs.writeFile(path.join(dir, "notes", "a.md"), "# hello", "utf8");
    const file = await readWorkspaceFile(dir, "/notes/a.md");
    expect(file.content).toBe("# hello");
    expect(file.path).toBe("/notes/a.md");
    expect(file.encoding).toBe("utf8");
    expect(file.mimeType).toBe("text/markdown");
  });

  test("工作区外路径被拒绝", async () => {
    const dir = await ensureWorkspace(path.join(root, "read-b"));
    await fs.writeFile(path.join(root, "outside.txt"), "secret", "utf8");
    const err = await readWorkspaceFile(dir, "../outside.txt").catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(["PATH_INVALID", "PATH_OUT_OF_WORKSPACE"]).toContain((err as WorkspaceError).code);
    expect(await readWorkspaceFile(dir, "/ok.txt").catch((e) => e)).toBeInstanceOf(WorkspaceError);
  });

  test("符号链接逃逸被拒绝（若平台支持）", async () => {
    const dir = await ensureWorkspace(path.join(root, "read-symlink"));
    const outside = path.join(root, "link-target.txt");
    await fs.writeFile(outside, "secret", "utf8");
    try {
      await fs.symlink(outside, path.join(dir, "link.txt"));
    } catch {
      return; // Windows 无权限时跳过
    }
    const err = await readWorkspaceFile(dir, "/link.txt").catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).code).toBe("PATH_OUT_OF_WORKSPACE");
  });

  test("resolveWorkspacePath 词法拒绝 .. 与绝对路径", () => {
    const base = path.join(root, "lexical");
    expect(() => resolveWorkspacePath(base, "../x")).toThrow(WorkspaceError);
    expect(() => resolveWorkspacePath(base, "/../x")).toThrow(WorkspaceError);
    expect(() => resolveWorkspacePath(base, "~/.ssh/id_rsa")).toThrow(WorkspaceError);
    expect(resolveWorkspacePath(base, "/a/b.txt")).toBe(path.join(base, "a", "b.txt"));
    expect(workspaceTodosPath(base)).toBe(path.join(base, "todos.json"));
  });
});