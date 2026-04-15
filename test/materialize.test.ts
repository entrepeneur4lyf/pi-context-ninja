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

  it("preserves image blocks when rewriting tool results", () => {
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
      {
        role: "toolResult",
        content: [
          { type: "text", text: '{"status":"ok"}' },
          { type: "image", data: "img-data", mimeType: "image/png" },
        ],
        toolName: "bash",
        isError: false,
        toolCallId: "t1",
        _key: "t1",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: defaultConfig() });
    const toolMsg = result.messages?.[0] as any;

    expect(toolMsg.content).toHaveLength(2);
    expect(toolMsg.content[0]).toMatchObject({ type: "text", text: "[ok]" });
    expect(toolMsg.content[1]).toMatchObject({ type: "image", data: "img-data", mimeType: "image/png" });
  });

  it("preserves later text blocks when rewriting mixed tool results", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.truncation.headLines = 1;
    cfg.strategies.truncation.tailLines = 1;
    cfg.strategies.truncation.minLines = 2;
    cfg.strategies.truncation.enabled = true;

    const msgs = [
      {
        role: "toolResult",
        content: [
          { type: "text", text: "alpha\nbeta" },
          { type: "image", data: "img-data", mimeType: "image/png" },
          { type: "text", text: "gamma\ndelta" },
        ],
        toolName: "bash",
        isError: false,
        toolCallId: "t1",
        _key: "t1",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });
    const toolMsg = result.messages?.[0] as any;

    expect(toolMsg.content).toHaveLength(3);
    expect(toolMsg.content[0]).toMatchObject({ type: "text" });
    expect(toolMsg.content[1]).toMatchObject({ type: "image", data: "img-data", mimeType: "image/png" });
    expect(toolMsg.content[2]).toMatchObject({ type: "text" });
    expect(toolMsg.content[0].text).toBe(toolMsg.content[2].text);
    expect(toolMsg.content[0].text).toContain("[--- 2 lines omitted ---]");
  });
});
