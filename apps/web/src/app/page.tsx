"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Assistant } from "@langchain/langgraph-sdk";
import { useClient } from "@/providers/ClientProvider";
import { Button } from "@/components/ui/button";
import { useAppConfig } from "@/app/_shell/AppConfigContext";
import { ChatWorkspace } from "@/app/_chat/ChatWorkspace";
import zh from "@/i18n/zh";

/**
 * 对话页（路由 `/`，任务 10.2）。
 *
 * 页面内状态仍走查询参数：`workspace`（工作区）、`threadId`（当前会话）、
 * `assistantId`、`sidebar`——刷新与分享地址都能回到同一视图。
 * 外壳（导航 / 顶部栏 / 配置客户端）由根布局提供，本页只管内容区。
 */
function ChatPageInner() {
  const client = useClient();
  const { config } = useAppConfig();
  const [assistant, setAssistant] = useState<Assistant | null>(null);

  const assistantId = config?.assistantId ?? "";

  const fetchAssistant = useCallback(async () => {
    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        assistantId
      );

    if (isUUID) {
      try {
        const data = await client.assistants.get(assistantId);
        setAssistant(data);
      } catch (error) {
        console.error("获取助手失败：", error);
        setAssistant(fallbackAssistant(assistantId));
      }
    } else {
      try {
        const assistants = await client.assistants.search({
          graphId: assistantId,
          limit: 100,
        });
        const defaultAssistant = assistants.find(
          (item) => item.metadata?.["created_by"] === "system"
        );
        if (defaultAssistant === undefined) {
          throw new Error("没有找到默认助手");
        }
        setAssistant(defaultAssistant);
      } catch (error) {
        console.error(
          "无法通过 graph_id 找到默认助手，请直接指定 assistant_id：",
          error
        );
        setAssistant(fallbackAssistant(assistantId));
      }
    }
  }, [client, assistantId]);

  useEffect(() => {
    void fetchAssistant();
  }, [fetchAssistant]);

  return <ChatWorkspace assistant={assistant} />;
}

function fallbackAssistant(assistantId: string): Assistant {
  return {
    assistant_id: assistantId,
    graph_id: assistantId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    config: {},
    metadata: {},
    version: 1,
    name: assistantId,
    context: {},
  };
}

/** 未读到配置时（客户端首帧）与改造前一致的欢迎屏。 */
function WelcomeScreen() {
  const { openConfigDialog } = useAppConfig();
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold">{zh.app.welcomeTitle}</h1>
        <p className="mt-2 text-muted-foreground">
          {zh.app.welcomeDescription}
        </p>
        <Button
          onClick={openConfigDialog}
          className="mt-4"
        >
          {zh.app.openConfig}
        </Button>
      </div>
    </div>
  );
}

export default function ChatPage() {
  const { config } = useAppConfig();
  if (!config) return <WelcomeScreen />;
  return <ChatPageInner />;
}