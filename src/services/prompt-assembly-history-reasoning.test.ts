import { describe, expect, test } from "bun:test";

import { type LlmMessage } from "../llm/types";
import { __reasoningHistoryTest } from "./prompt-assembly.service";

describe("native reasoning prompt history", () => {
  test("does not expose persisted provider reasoning carriers to prompt history", () => {
    const message = {
      is_user: false,
      extra: {
        reasoningCarrier: {
          type: "reasoning_details",
          details: [{ type: "reasoning.text", text: "Native reasoning" }],
        },
      },
    } as any;

    expect(__reasoningHistoryTest).not.toHaveProperty("getStoredReasoningCarrier");
    expect(message.extra.reasoningCarrier).toBeDefined();
  });

  test("keepInHistory removes old native carriers without converting them to CoT", () => {
    const messages: LlmMessage[] = [
      { role: "assistant", content: "Older", reasoning_content: "old native" },
      {
        role: "assistant",
        content: "Newest",
        thinking_blocks: [{ type: "thinking", thinking: "new native", signature: "sig" }],
      },
    ];

    __reasoningHistoryTest.stripReasoningFromChatHistory(messages, 0, 2, {
      keepInHistory: 1,
    });

    expect(messages[0]).toEqual({ role: "assistant", content: "Older" });
    expect(messages[1].thinking_blocks).toEqual([
      { type: "thinking", thinking: "new native", signature: "sig" },
    ]);
  });
});
