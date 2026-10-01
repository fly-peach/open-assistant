/**
 * 文本 / JSON 文件的小工具：原子写入 + 容错读取。
 * 放在 agents 目录下供注册表与绑定共用（两者都要写纯文本 / JSON）。
 */
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

export async function statOrNull(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/** 原子写文本：同目录临时文件 + fsync + rename（避免读到半截文件） */
export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export function toJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 原子写 JSON（两位缩进 + 结尾换行，方便人直接编辑） */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomic(filePath, toJsonText(value));
}

/** 读取 JSON；文件不存在 → null；内容不是合法 JSON → 交给 onInvalid */
export async function readJsonOrNull<T>(
  filePath: string,
  onInvalid: (error: Error) => T,
): Promise<T | unknown | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    return onInvalid(new Error(`${filePath} 不是合法 JSON（${(err as Error).message}）`));
  }
}