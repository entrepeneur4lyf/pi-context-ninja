import { describe, it, expect } from "vitest";
import { defaultConfig } from "../src/config";
import { createSessionState } from "../src/state";
import { materializeContext } from "../src/strategies/materialize";

describe("materialize", () => {
  it("short-circuits successful JSON tool result", () => {
    const state = createSessionState("/tmp");
    state.currentTurn = 2;
    const cfg = defaultConfig();
    cfg.strategies.shortCircuit.minTokens = 4;
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

    const result = materializeContext(msgs, { state, config: cfg });
    const toolMsg = result.messages?.find((m: any) => m.role === "toolResult") as any;

    expect(toolMsg.content[0].text).toBe("[ok]");
  });

  it("respects shortCircuit.minTokens during materialization", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.shortCircuit.minTokens = 9999;
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
        content: [{ type: "text", text: '{"status":"ok"}' }],
        toolName: "bash",
        isError: false,
        toolCallId: "t1",
        _key: "t1",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });

    expect((result.messages as any)[0].content[0].text).toBe('{"status":"ok"}');
  });

  it("still shapes protected tools but skips deduplication", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.shortCircuit.minTokens = 4;
    cfg.strategies.deduplication.maxOccurrences = 1;
    const msgs = [
      {
        role: "toolResult",
        content: [{ type: "text", text: '{"status":"ok"}' }],
        toolName: "write",
        isError: false,
        toolCallId: "t1",
        _key: "t1",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: '{"status":"ok"}' }],
        toolName: "write",
        isError: false,
        toolCallId: "t2",
        _key: "t2",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });

    expect(result.messages?.length).toBe(2);
    expect((result.messages as any)[0].content[0].text).toBe("[ok]");
    expect((result.messages as any)[1].content[0].text).toBe("[ok]");
  });

  it("preserves image blocks when rewriting tool results", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.shortCircuit.minTokens = 4;
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

    const result = materializeContext(msgs, { state, config: cfg });
    const toolMsg = result.messages?.[0] as any;

    expect(toolMsg.content).toHaveLength(2);
    expect(toolMsg.content[0]).toMatchObject({ type: "text", text: "[ok]" });
    expect(toolMsg.content[1]).toMatchObject({ type: "image", data: "img-data", mimeType: "image/png" });
  });

  it("skips rewriting mixed tool results with multiple text blocks", () => {
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

    expect(toolMsg.content).toEqual(msgs[0].content);
  });

  it("still advances dedup tracking for mixed-content tool results", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.deduplication.maxOccurrences = 1;
    cfg.strategies.shortCircuit.enabled = false;
    cfg.strategies.codeFilter.enabled = false;
    cfg.strategies.truncation.enabled = false;
    cfg.strategies.errorPurge.enabled = false;

    const mixedPayload = "alpha\nbeta";
    const msgs = [
      {
        role: "toolResult",
        content: [
          { type: "text", text: "alpha" },
          { type: "image", data: "img-data", mimeType: "image/png" },
          { type: "text", text: "beta" },
        ],
        toolName: "read",
        isError: false,
        toolCallId: "t1",
        _key: "t1",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: mixedPayload }],
        toolName: "read",
        isError: false,
        toolCallId: "t2",
        _key: "t2",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });

    expect(result.messages?.[0]).toEqual(msgs[0]);
    expect((result.messages as any)[1].content[0].text).toBe("[dedup: see earlier read result x1]");
  });

  it("deduplicates normalized content across distinct tool calls", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.deduplication.maxOccurrences = 1;

    const msgs = [
      {
        role: "toolResult",
        content: [{ type: "text", text: "build 2026-04-14T10:11:12Z abcdefab-cdef-4123-89ab-abcdefabcdef" }],
        toolName: "read",
        isError: false,
        toolCallId: "t1",
        _key: "t1",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "build 2026-04-15T11:12:13Z 12345678-1234-4123-8234-1234567890ab" }],
        toolName: "read",
        isError: false,
        toolCallId: "t2",
        _key: "t2",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });

    expect((result.messages as any)[0].content[0].text).toContain("build");
    expect((result.messages as any)[1].content[0].text).toBe("[dedup: see earlier read result x1]");
  });
});
