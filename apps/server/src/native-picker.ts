/**
 * 本机文件夹选择对话框（在后端所在机器上弹出系统原生对话框）。
 *
 * 为什么需要它：工作区是一个**本机绝对路径**，而浏览器出于安全拿不到真实绝对路径。
 * 本项目定位是「跑在你自己电脑上」，所以让**后端**弹系统对话框、把选中的绝对路径回传，
 * 是「用户主动选择本地文件夹」最直接的做法。无图形界面 / 用户取消时优雅降级
 * （前端仍可退回逐层浏览）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PickFolderResult {
  /** 选中的绝对路径；取消 / 失败时为 null */
  path: string | null;
  cancelled: boolean;
  /** 该平台没有原生选择器实现 */
  unsupported?: boolean;
  error?: string;
}

/** 按平台给出「弹文件夹对话框」的命令（纯函数，便于测试） */
export function nativePickerCommand(
  platform: NodeJS.Platform,
): { file: string; args: string[] } | null {
  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$d.Description = '选择工作区目录'",
      "$d.ShowNewFolderButton = $true",
      "$f = New-Object System.Windows.Forms.Form",
      "$f.TopMost = $true",
      "$r = $d.ShowDialog($f)",
      "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
    ].join("; ");
    return { file: "powershell.exe", args: ["-NoProfile", "-STA", "-Command", script] };
  }
  if (platform === "darwin") {
    return {
      file: "osascript",
      args: ["-e", 'POSIX path of (choose folder with prompt "选择工作区目录")'],
    };
  }
  if (platform === "linux") {
    return { file: "zenity", args: ["--file-selection", "--directory", "--title=选择工作区目录"] };
  }
  return null;
}

/** 用户取消在 osascript / zenity 上会以非零退出或特定文案表示 */
function looksCancelled(message: string): boolean {
  return /cancel|user canceled|用户已取消|-128/i.test(message);
}

/**
 * 弹出本机文件夹对话框并返回选中的绝对路径。
 * `timeoutMs` 到点即放弃（避免无图形界面时请求被永久挂住）。
 */
export async function pickNativeFolder(timeoutMs = 120_000): Promise<PickFolderResult> {
  const command = nativePickerCommand(process.platform);
  if (!command) {
    return {
      path: null,
      cancelled: false,
      unsupported: true,
      error: `当前平台（${process.platform}）暂不支持原生文件夹对话框`,
    };
  }
  try {
    const { stdout } = await execFileAsync(command.file, command.args, {
      timeout: timeoutMs,
      maxBuffer: 1 << 20,
    });
    const picked = stdout.trim().replace(/[/\\]$/, "");
    if (picked.length === 0) return { path: null, cancelled: true };
    return { path: picked, cancelled: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    const message = (e.stderr || e.message || "").trim();
    if (e.killed) {
      return { path: null, cancelled: false, error: "等待选择超时（后端可能没有图形界面）" };
    }
    if (looksCancelled(message)) return { path: null, cancelled: true };
    return {
      path: null,
      cancelled: false,
      error: message || "无法打开本机文件夹对话框（后端可能没有图形界面）",
    };
  }
}