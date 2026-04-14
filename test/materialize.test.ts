import { describe, it, expect } from "vitest";
import { defaultConfig } from "../src/config";
import { createSessionState } from "../src/state";
import { materializeContext } from "../src/strategies/materialize";

describe("materialize", () => {
  it("short-circuits successful JSON tool result", () => {
    const state = createSessionState("/tmp");
    state.currentTurn = 2;
    state.toolCalls.set("t1", {
      toolCallId: "t1",
      toolName: "bash",
      inputArgs: {},
      inputFingerprint: "bash::{}",
      isError: false,
      turnIndex: 1,
      timestamp: Date.now(),
      tokenEstimate: 10,
    });

    const msgs = [
      { role: "user", content: [{ type: "text", text: "run" }], _key: "u1" },
      { role: "assistant", content: "bash", _key: "a1" },
      {
        role: "toolResult",
        content: [{ type: "text", text: '{"status":"ok"}' }],
        toolName: "bash",
        isError: false,
        toolCallId: "t1",
        _key: "t1",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: defaultConfig() });
    const toolMsg = result.messages?.find((m: any) => m.role === "toolResult") as any;

    expect(toolMsg.content[0].text).toBe("[ok]");
  });

  it("preserves protected write results", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    const msgs = [
      {
        role: "toolResult",
        content: [{ type: "text", text: '{"status":"ok"}' }],
        toolName: "write",
        isError: false,
        toolCallId: "t1",
        _key: "t1",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });

    expect(result.messages?.length).toBe(1);
    expect((result.messages as any)[0].content[0].text).toBe('{"status":"ok"}');
  });
});
