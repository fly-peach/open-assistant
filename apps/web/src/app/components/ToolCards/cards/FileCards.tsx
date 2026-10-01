"use client";

import React from "react";
import { FilePlus2, FileText, Pencil, Send, Trash2, FilePenLine } from "lucide-react";
import { DefaultBlock } from "@/app/components/ToolCards/DefaultBlock";
import {
  ToolBadge,
  ToolCardShell,
  errorSummary,
} from "@/app/components/ToolCards/ToolCardShell";
import {
  countLines,
  extractResultText,
  getFileLanguage,
  paramString,
  stringifyResult,
  type CardProps,
} from "@/app/components/ToolCards/types";
import zh, { t } from "@/i18n/zh";

/** 读取路径参数（已归一化，兼容 file_path / path / file ...）。 */
function fileOf(params: Record<string, unknown>): string {
  return paramString(params, "file_path");
}

/** 摘要行文案：有路径就带上路径（spec 要求未展开即可看到路径）。 */
function fileTitle(template: string, fallback: string, file: string): string {
  return file
    ? t(template, { file: file.length > 90 ? `…${file.slice(-90)}` : file })
    : fallback;
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export const ReadFileCard: React.FC<CardProps> = ({ content, isStreaming }) => {
  const file = fileOf(content.params);
  const title = fileTitle(zh.tool.readFile, zh.tool.readFileDefault, file);

  if (content.status === "error") {
    return (
      <ToolCardShell
        content={content}
        isStreaming={isStreaming}
        icon={<FileText size={13} />}
        title={title}
        inlineResult={errorSummary(content)}
      />
    );
  }

  const output = extractResultText(content.result);
  const lineCount = countLines(output);
  return (
    <ToolCardShell
      content={content}
      isStreaming={isStreaming}
      icon={<FileText size={13} />}
      title={title}
      badges={
        content.status === "done" && lineCount > 0 ? (
          <ToolBadge tone="info">{t(zh.tool.badgeLines, { count: lineCount })}</ToolBadge>
        ) : null
      }
      inlineResult={
        !output && content.status !== "calling"
          ? (stringifyResult(content.result) || null)
          : null
      }
    >
      {output && (
        <DefaultBlock
          title={zh.tool.sectionOutput}
          content={output}
          language={getFileLanguage(file)}
        />
      )}
    </ToolCardShell>
  );
};

// ---------------------------------------------------------------------------
// 写入 / 追写（结构相同，只有文案与图标不同）
// ---------------------------------------------------------------------------

function ContentWritingCard({
  content,
  isStreaming,
  append,
}: {
  content: CardProps["content"];
  isStreaming?: boolean;
  append?: boolean;
}) {
  const file = fileOf(content.params);
  const title = fileTitle(
    append ? zh.tool.appendFile : zh.tool.writeFile,
    append ? zh.tool.appendFileDefault : zh.tool.writeFileDefault,
    file
  );

  if (content.status === "error") {
    return (
      <ToolCardShell
        content={content}
        isStreaming={isStreaming}
        icon={append ? <FilePenLine size={13} /> : <FilePlus2 size={13} />}
        title={title}
        inlineResult={errorSummary(content)}
      />
    );
  }

  const written = paramString(content.params, "content");
  const lineCount = countLines(written);
  const isCalling = content.status === "calling";
  return (
    <ToolCardShell
      content={content}
      isStreaming={isStreaming}
      icon={append ? <FilePenLine size={13} /> : <FilePlus2 size={13} />}
      title={title}
      badges={
        !isCalling && lineCount > 0 ? (
          <ToolBadge tone="add">{t(zh.tool.badgeLines, { count: lineCount })}</ToolBadge>
        ) : null
      }
    >
      {written && (
        <DefaultBlock
          title={zh.tool.sectionContent}
          content={written}
          language={getFileLanguage(file)}
        />
      )}
    </ToolCardShell>
  );
}

export const WriteFileCard: React.FC<CardProps> = (props) => (
  <ContentWritingCard {...props} />
);

export const AppendFileCard: React.FC<CardProps> = (props) => (
  <ContentWritingCard
    {...props}
    append
  />
);

// ---------------------------------------------------------------------------
// 修改：增删对照
// ---------------------------------------------------------------------------

const DiffBlock: React.FC<{ oldText: string; newText: string }> = ({
  oldText,
  newText,
}) => {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  return (
    <div className="my-1 max-h-[360px] overflow-auto rounded-lg border border-[var(--color-border)] font-mono text-xxs leading-5">
      {oldLines.map((line, index) => (
        <div
          key={`del-${index}`}
          className="whitespace-pre-wrap break-all bg-red-500/10 px-2 text-red-700 dark:text-red-300"
        >
          {`- ${line}`}
        </div>
      ))}
      {newLines.map((line, index) => (
        <div
          key={`add-${index}`}
          className="whitespace-pre-wrap break-all bg-green-500/10 px-2 text-green-700 dark:text-green-300"
        >
          {`+ ${line}`}
        </div>
      ))}
    </div>
  );
};

export const EditFileCard: React.FC<CardProps> = ({ content, isStreaming }) => {
  const file = fileOf(content.params);
  const title = fileTitle(zh.tool.editFile, zh.tool.editFileDefault, file);

  if (content.status === "error") {
    return (
      <ToolCardShell
        content={content}
        isStreaming={isStreaming}
        icon={<Pencil size={13} />}
        title={title}
        inlineResult={errorSummary(content)}
      />
    );
  }

  // 键名归一化在这里兑现：DeepAgents 用 old_string/new_string，
  // QwenPaw 系工具用 old_text/new_text，两者都已映射到 canonical 键。
  const oldText = paramString(content.params, "old_text");
  const newText = paramString(content.params, "new_text");
  const isCalling = content.status === "calling";

  return (
    <ToolCardShell
      content={content}
      isStreaming={isStreaming}
      icon={<Pencil size={13} />}
      title={title}
      badges={
        !isCalling ? (
          <>
            <ToolBadge tone="del">
              {t(zh.tool.badgeDelLines, { count: countLines(oldText) })}
            </ToolBadge>
            <ToolBadge tone="add">
              {t(zh.tool.badgeAddLines, { count: countLines(newText) })}
            </ToolBadge>
          </>
        ) : null
      }
      inlineResult={
        isCalling ? null : stringifyResult(content.result) || null
      }
    >
      {(oldText || newText) && (
        <DiffBlock
          oldText={oldText}
          newText={newText}
        />
      )}
      {!oldText && !newText && !isCalling && (
        <DefaultBlock
          title={zh.tool.sectionOutput}
          content={extractResultText(content.result)}
        />
      )}
    </ToolCardShell>
  );
};

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

export const DeleteFileCard: React.FC<CardProps> = ({ content, isStreaming }) => {
  const file = fileOf(content.params);
  const title = fileTitle(
    zh.tool.deleteFile,
    zh.tool.deleteFileDefault,
    file
  );
  return (
    <ToolCardShell
      content={content}
      isStreaming={isStreaming}
      icon={<Trash2 size={13} />}
      title={title}
      inlineResult={
        content.status === "error"
          ? errorSummary(content)
          : stringifyResult(content.result) || null
      }
    >
      {extractResultText(content.result) && (
        <DefaultBlock
          title={zh.tool.sectionOutput}
          content={extractResultText(content.result)}
        />
      )}
    </ToolCardShell>
  );
};

// ---------------------------------------------------------------------------
// 发送文件：媒体预览（原生标签，无 antd）
// ---------------------------------------------------------------------------

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
const VIDEO_EXT = ["mp4", "webm", "mov", "m4v"];
const AUDIO_EXT = ["mp3", "wav", "ogg", "m4a", "flac"];

function mediaKind(path: string): "image" | "video" | "audio" | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXT.includes(ext)) return "image";
  if (VIDEO_EXT.includes(ext)) return "video";
  if (AUDIO_EXT.includes(ext)) return "audio";
  return null;
}

function isResolvableUrl(path: string): boolean {
  return /^(https?:|data:|blob:|\/)/.test(path);
}

function MediaPreview({ path }: { path: string }) {
  const kind = mediaKind(path);
  if (!kind || !isResolvableUrl(path)) return null;
  if (kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={path}
        alt={path}
        className="my-1 max-h-64 max-w-[256px] rounded-lg border border-[var(--color-border)] object-contain"
      />
    );
  }
  if (kind === "video") {
    return (
      <video
        src={path}
        controls
        className="my-1 max-h-64 max-w-[320px] rounded-lg border border-[var(--color-border)]"
      />
    );
  }
  return (
    <audio
      src={path}
      controls
      className="my-1 w-full max-w-[320px]"
    />
  );
}

export const SendFileCard: React.FC<CardProps> = ({ content, isStreaming }) => {
  const file = fileOf(content.params);
  const title = fileTitle(zh.tool.sendFile, zh.tool.sendFileDefault, file);
  if (content.status === "error") {
    return (
      <ToolCardShell
        content={content}
        isStreaming={isStreaming}
        icon={<Send size={13} />}
        title={title}
        inlineResult={errorSummary(content)}
      />
    );
  }
  return (
    <ToolCardShell
      content={content}
      isStreaming={isStreaming}
      icon={<Send size={13} />}
      title={title}
      defaultExpanded={Boolean(mediaKind(file))}
    >
      <MediaPreview path={file} />
    </ToolCardShell>
  );
};