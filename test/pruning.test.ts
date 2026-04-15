import { describe, expect, it } from "vitest";
import { applyPruneTargets } from "../src/strategies/pruning";

describe("pruning", () => {
  it("rewrites only targeted tool results and preserves conversation messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "need file status" }] },
      { role: "assistant", content: "running read" },
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "very long file body" }],
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

  it("collapses targeted mixed-content tool results to prune text while preserving conversation messages", () => {
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
    expect((result[2] as any).content).toEqual([
      { type: "text", text: "[pruned: indexed read result 1-1]" },
    ]);
  });
});
