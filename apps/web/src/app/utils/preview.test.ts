import { describe, expect, test } from "bun:test";
import {
  formatSize,
  getExtension,
  getLanguage,
  getPreviewType,
  isTodoFile,
  toImageSrc,
} from "@/app/utils/preview";

describe("文件预览分流（5.4 / 5.5）", () => {
  test("json → 结构化渲染", () => {
    expect(getPreviewType("todos.json")).toBe("json");
    expect(getPreviewType("/data/config.json")).toBe("json");
  });

  test("markdown → 富文本", () => {
    expect(getPreviewType("README.md")).toBe("markdown");
    expect(getPreviewType("docs/guide.markdown")).toBe("markdown");
  });

  test("已知编程语言 → 代码高亮", () => {
    expect(getPreviewType("main.ts")).toBe("code");
    expect(getPreviewType("component.tsx")).toBe("code");
    expect(getPreviewType("script.py")).toBe("code");
    expect(getLanguage("main.ts")).toBe("typescript");
    expect(getLanguage("Main.java")).toBe("java");
  });

  test("图片 → 图片", () => {
    expect(getPreviewType("logo.png")).toBe("image");
    expect(getPreviewType("photo.jpg")).toBe("image");
    // svg 既是 markup 又是图片，按图片优先
    expect(getPreviewType("icon.svg")).toBe("image");
  });

  test("纯文本 → 等宽文本", () => {
    expect(getPreviewType("notes.txt")).toBe("text");
    expect(getPreviewType("data.csv")).toBe("text");
    expect(getPreviewType(".gitignore")).toBe("text");
  });

  test("不支持的类型 → unsupported（不崩溃）", () => {
    expect(getPreviewType("archive.zip")).toBe("unsupported");
    expect(getPreviewType("binary.exe")).toBe("unsupported");
    expect(getPreviewType("font.woff2")).toBe("unsupported");
  });

  test("未知扩展名按 MIME 兜底", () => {
    expect(getPreviewType("mystery", "text/plain")).toBe("text");
    expect(getPreviewType("mystery", "image/png")).toBe("image");
    expect(getPreviewType("mystery", "application/octet-stream")).toBe(
      "unsupported"
    );
    // 无扩展名、无 MIME 时按文本展示，避免误报不支持
    expect(getPreviewType("Makefile")).toBe("text");
  });

  test("扩展名与 basename 解析兼容 Windows 风格路径", () => {
    expect(getExtension("C:\\ws\\a\\b.JSON")).toBe("json");
    expect(getExtension("noext")).toBe("");
  });
});

describe("TODO 文件识别（6.1）", () => {
  test("basename 为 todos.json 即视为 TODO 文件", () => {
    expect(isTodoFile("/todos.json")).toBe(true);
    expect(isTodoFile("todos.json")).toBe(true);
    expect(isTodoFile("/sub/todos.json")).toBe(true);
    expect(isTodoFile("/TODOS.JSON")).toBe(true);
    expect(isTodoFile("/todos-backup.json")).toBe(false);
    expect(isTodoFile("/notes.md")).toBe(false);
  });
});

describe("图片 data URL 拼装（5.4）", () => {
  test("二进制图片用 base64", () => {
    expect(toImageSrc("AAAA", "base64", "image/png")).toBe(
      "data:image/png;base64,AAAA"
    );
  });

  test("文本类图片（svg）做 URL 编码", () => {
    const src = toImageSrc("<svg></svg>", "utf8", "image/svg+xml");
    expect(src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(src).toContain("%3Csvg%3E");
  });
});

describe("文件大小格式化（5.6 辅助）", () => {
  test("按量级切换单位", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatSize(null)).toBe("");
  });
});