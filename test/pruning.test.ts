import { describe, expect, it } from "vitest";
import { applyPruneTargets } from "../src/strategies/pruning";
import { createSessionState } from "../src/state";

describe("pruning", () => {
  const longBody = "very long file body ".repeat(10);

  it("rewrites only targeted tool results and preserves conversation messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "need file status" }] },
      { role: "assistant", content: "running read" },
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: longBody }],
      },
    ] as any;

    const result = applyPruneTargets(messages, [
      {
        toolCallId: "read-1",
        turnIndex: 1,
        indexedAt: 123,
        summaryRef: "1-1",
        replacementText: "[pruned: indexed read result 1-1]",
      },
    ]);

    expect(result).toHaveLength(3);
    expect((result[0] as any).role).toBe("user");
    expect((result[1] as any).role).toBe("assistant");
    expect((result[2] as any).content[0].text).toBe("[pruned: indexed read result 1-1]");
  });

  it("skips prune targets when the tool result is absent from the current context", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }] as any;

    expect(
      applyPruneTargets(messages, [
        {
          toolCallId: "missing",
          turnIndex: 3,
          indexedAt: 123,
          summaryRef: "2-3",
          replacementText: "[pruned]",
        },
      ]),
    ).toEqual(messages);
  });

  it("rewrites safe single-text mixed-content tool results without dropping non-text payloads", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "need file status" }] },
      { role: "assistant", content: "running read" },
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        isError: false,
        content: [
          { type: "image", data: "img-data", mimeType: "image/png" },
          { type: "text", text: longBody },
        ],
      },
    ] as any;

    const result = applyPruneTargets(messages, [
      {
        toolCallId: "read-1",
        turnIndex: 1,
        indexedAt: 123,
        summaryRef: "1-1",
        replacementText: "[pruned: indexed read result 1-1]",
      },
    ]);

    expect(result).toHaveLength(3);
    expect((result[0] as any).role).toBe("user");
    expect((result[1] as any).role).toBe("assistant");
    expect((result[2] as any).content).toEqual([
      { type: "image", data: "img-data", mimeType: "image/png" },
      { type: "text", text: "[pruned: indexed read result 1-1]" },
    ]);
  });

  it("skips targeted multi-text mixed-content tool results to avoid dropping payloads", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "need file status" }] },
      { role: "assistant", content: "running read" },
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        isError: false,
        content: [
          { type: "text", text: "very long file body" },
          { type: "image", data: "img-data", mimeType: "image/png" },
          { type: "text", text: "more file body" },
        ],
      },
    ] as any;

    const result = applyPruneTargets(messages, [
      {
        toolCallId: "read-1",
        turnIndex: 1,
        indexedAt: 123,
        summaryRef: "1-1",
        replacementText: "[pruned: indexed read result 1-1]",
      },
    ]);

    expect(result).toHaveLength(3);
    expect((result[0] as any).role).toBe("user");
    expect((result[1] as any).role).toBe("assistant");
    expect(result).toEqual(messages);
  });

  it("leaves already-shortened tool results unchanged when the prune tombstone would expand them", () => {
    const state = createSessionState("project");
    const messages = [
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "[ok]" }],
      },
    ] as any;

    const result = applyPruneTargets(
      messages,
      [
        {
          toolCallId: "read-1",
          turnIndex: 1,
          indexedAt: 123,
          summaryRef: "0-8",
          replacementText: "[pruned: indexed read result 0-8]",
        },
      ],
      state,
    );

    expect(result).toEqual(messages);
    expect(state.tokensSavedByType.background_index ?? 0).toBe(0);
    expect(state.tokensKeptOutByType.background_index ?? 0).toBe(0);
    expect(state.tokensSaved).toBe(0);
    expect(state.tokensKeptOutTotal).toBe(0);
  });
});
