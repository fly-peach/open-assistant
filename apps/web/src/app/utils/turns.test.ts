import { describe, expect, test } from "bun:test";
import type { Message } from "@langchain/langgraph-sdk";
import {
  countSteps,
  extractToolCalls,
  groupMessagesIntoTurns,
} from "@/app/utils/turns";

// ---------------------------------------------------------------------------
// fixture 构造
// ---------------------------------------------------------------------------

function human(id: string, content: string): Message {
  return { id, type: "human", content } as unknown as Message;
}

function ai(
  id: string,
  content: string,
  opts: { toolCalls?: Array<{ id: string; name: string; args: unknown }>; reasoning?: string } = {}
): Message {
  return {
    id,
    type: "ai",
    content,
    tool_calls: (opts.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.name,
      args: call.args,
    })),
    additional_kwargs: opts.reasoning ? { reasoning_content: opts.reasoning } : {},
  } as unknown as Message;
}

function toolResult(id: string, toolCallId: string, content: string, name: string): Message {
  return {
    id,
    type: "tool",
    content,
    name,
    tool_call_id: toolCallId,
  } as unknown as Message;
}

// ---------------------------------------------------------------------------
// 形态一：单轮多工具
// ---------------------------------------------------------------------------

describe("回合聚合 · 单轮多工具", () => {
  const messages: Message[] = [
    human("h1", "帮我看一下工作区"),
    ai("a1", "", {
      toolCalls: [{ id: "call-1", name: "ls", args: { path: "." } }],
      reasoning: "先列目录",
    }),
    toolResult("t1", "call-1", "a.md\nb.md", "ls"),
    ai("a2", "", {
      toolCalls: [{ id: "call-2", name: "write_file", args: { file_path: "/a.md", content: "x" } }],
      reasoning: "再写文件",
    }),
    toolResult("t2", "call-2", "写入成功", "write_file"),
    ai("a3", "看完了，一共两个文件。"),
  ];

  const turns = groupMessagesIntoTurns(messages);

  test("只有一条 user，聚成一个回合（不是互不相干的平铺条目）", () => {
    expect(turns.length).toBe(1);
    expect(turns[0].user?.id).toBe("h1");
  });

  test("过程保留两次工具调用，且按 tool_call.id 关联到结果", () => {
    expect(turns[0].process.length).toBe(2);
    const first = turns[0].process[0];
    const second = turns[0].process[1];
    if (first.kind !== "assistant" || second.kind !== "assistant") {
      throw new Error("过程条目应为 assistant 步骤");
    }
    expect(first.toolCalls[0]).toMatchObject({
      id: "call-1",
      name: "ls",
      status: "completed",
      result: "a.md\nb.md",
    });
    expect(second.toolCalls[0]).toMatchObject({
      id: "call-2",
      name: "write_file",
      status: "completed",
      result: "写入成功",
    });
  });

  test("结论被抽出来且常驻（不再留在过程里）", () => {
    expect(turns[0].conclusion?.id).toBe("a3");
    expect(
      turns[0].process.some(
        (step) => step.kind === "assistant" && step.message.id === "a3"
      )
    ).toBe(false);
  });

  test("快照：结构稳定", () => {
    expect(stepSnapshot(turns[0])).toEqual([
      { kind: "assistant", reasoning: "先列目录", tools: ["ls:completed"] },
      { kind: "assistant", reasoning: "再写文件", tools: ["write_file:completed"] },
    ]);
    expect(countSteps(turns[0])).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 形态二：工具报错
// ---------------------------------------------------------------------------

describe("回合聚合 · 工具报错", () => {
  const messages: Message[] = [
    human("h1", "改一下文件"),
    ai("a1", "", {
      toolCalls: [
        { id: "call-1", name: "edit_file", args: { file_path: "/a.md", old_string: "x", new_string: "y" } },
      ],
    }),
    {
      id: "t1",
      type: "tool",
      content: "Error: 找不到 old_string",
      name: "edit_file",
      tool_call_id: "call-1",
      status: "error",
    } as unknown as Message,
    ai("a2", "修改失败了。"),
  ];
  const turns = groupMessagesIntoTurns(messages);

  test("失败状态被标出，且回合标记 hasFailedTool", () => {
    const step = turns[0].process[0];
    if (step.kind !== "assistant") throw new Error("应为 assistant 步骤");
    expect(step.toolCalls[0].status).toBe("error");
    expect(turns[0].hasFailedTool).toBe(true);
  });

  test("失败时结论仍然常驻可见", () => {
    expect(turns[0].conclusion?.id).toBe("a2");
  });

  test("悬挂调用（回合已结束仍无结果）被收尾为中断而不是一直转圈", () => {
    const hanging = groupMessagesIntoTurns([
      human("h1", "跑一下"),
      ai("a1", "", { toolCalls: [{ id: "call-x", name: "ls", args: {} }] }),
    ]);
    const step = hanging[0].process[0];
    if (step.kind !== "assistant") throw new Error("应为 assistant 步骤");
    // 聚合层保持 pending，由卡片层结合 turnEnded 推导出中断（见 deriveToolStatus 测试）
    expect(step.toolCalls[0].status).toBe("pending");
    expect(step.toolCalls[0].result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 形态三：无思考
// ---------------------------------------------------------------------------

describe("回合聚合 · 无思考", () => {
  const messages: Message[] = [
    human("h1", "1+1"),
    ai("a1", "", { toolCalls: [{ id: "call-1", name: "ls", args: {} }] }),
    toolResult("t1", "call-1", "ok", "ls"),
    ai("a2", "2"),
  ];
  const turns = groupMessagesIntoTurns(messages);

  test("没有思考就不产生空思考块（reasoning 为空串）", () => {
    const step = turns[0].process[0];
    if (step.kind !== "assistant") throw new Error("应为 assistant 步骤");
    expect(step.reasoning).toBe("");
  });

  test("结构与有思考时一致", () => {
    expect(turns.length).toBe(1);
    expect(turns[0].conclusion?.id).toBe("a2");
    expect(turns[0].process.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 多回合 / 用户内容不被翻译
// ---------------------------------------------------------------------------

describe("回合聚合 · 多回合与内容保真", () => {
  test("每次提交产生一个回合", () => {
    const turns = groupMessagesIntoTurns([
      human("h1", "first"),
      ai("a1", "one"),
      human("h2", "second"),
      ai("a2", "two"),
    ]);
    expect(turns.map((turn) => turn.id)).toEqual(["h1", "h2"]);
    expect(turns.map((turn) => turn.conclusion?.id)).toEqual(["a1", "a2"]);
  });

  test("英文用户内容原文保留（不翻译、不改写）", () => {
    const original = "Add 'submit weekly report on Friday' to my todos.";
    const turns = groupMessagesIntoTurns([
      human("h1", original),
      ai("a1", "Done."),
    ]);
    expect(turns[0].user?.content).toBe(original);
    expect(turns[0].conclusion?.content).toBe("Done.");
  });
});

// ---------------------------------------------------------------------------
// 工具调用抽取
// ---------------------------------------------------------------------------

describe("工具调用抽取", () => {
  test("兼容 additional_kwargs.tool_calls / tool_calls / content 里的 tool_use", () => {
    const fromAdditional = extractToolCalls(
      {
        id: "x",
        type: "ai",
        content: "",
        additional_kwargs: {
          tool_calls: [{ id: "c1", name: "ls", args: { path: "." } }],
        },
      } as unknown as Message,
      false
    );
    expect(fromAdditional[0]).toMatchObject({ id: "c1", name: "ls", status: "pending" });

    const fromBlocks = extractToolCalls(
      {
        id: "y",
        type: "ai",
        content: [{ type: "tool_use", id: "c2", name: "glob", input: { pattern: "*" } }],
      } as unknown as Message,
      true
    );
    expect(fromBlocks[0]).toMatchObject({
      id: "c2",
      name: "glob",
      args: { pattern: "*" },
      status: "interrupted",
    });
  });
});

// ---------------------------------------------------------------------------

type TurnLike = ReturnType<typeof groupMessagesIntoTurns>[number];

function stepSnapshot(turn: TurnLike) {
  return turn.process.map((step) => {
    if (step.kind === "assistant") {
      return {
        kind: step.kind,
        reasoning: step.reasoning,
        tools: step.toolCalls.map((call) => `${call.name}:${call.status}`),
      };
    }
    return { kind: step.kind, tools: [`${step.toolCall.name}:${step.toolCall.status}`] };
  });
}