import { describe, it, expect } from "bun:test";
import { defaultConfig } from "../src/config";
import { createSessionState, getOrCreateToolRecord } from "../src/state";
import { materializeContext } from "../src/strategies/materialize";

describe("materialize", () => {
  it("short-circuits successful JSON tool result", () => {
    const state = createSessionState("/tmp");
    state.currentTurn = 2;
    const cfg = defaultConfig();
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

  it("skips short circuit for results above shortCircuit.maxTokens", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.shortCircuit.maxTokens = 1;
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

  it("never rewrites results of protected tools", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
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
    expect((result.messages as any)[0].content[0].text).toBe('{"status":"ok"}');
    expect((result.messages as any)[1].content[0].text).toBe('{"status":"ok"}');
    expect(state.tokensKeptOutTotal).toBe(0);
  });

  it("never rewrites a read result, even a repeated one", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.deduplication.maxOccurrences = 1;
    const text = '{"status":"ok"}';
    const msgs = [
      { role: "toolResult", content: [{ type: "text", text }], toolName: "read", isError: false, toolCallId: "r1" },
      { role: "toolResult", content: [{ type: "text", text }], toolName: "read", isError: false, toolCallId: "r2" },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });

    expect((result.messages as any)[0].content[0].text).toBe(text);
    expect((result.messages as any)[1].content[0].text).toBe(text);
  });

  it("never rewrites a result that carries a hashline header", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.truncation.minLines = 5;
    const text = ["[src/a.ts#ab12cd]", ...Array.from({ length: 20 }, (_, i) => `${i + 1}:line ${i + 1}`)].join("\n");
    const msgs = [
      { role: "toolResult", content: [{ type: "text", text }], toolName: "grep", isError: false, toolCallId: "g1" },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });

    expect((result.messages as any)[0].content[0].text).toBe(text);
  });

  it("leaves host-pruned results alone and does not count them as dedup occurrences", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.deduplication.maxOccurrences = 1;
    cfg.strategies.shortCircuit.enabled = false;
    const text = "[Superseded by a newer read of this file]";
    const msgs = [
      { role: "toolResult", content: [{ type: "text", text }], toolName: "grep", isError: false, toolCallId: "p1", prunedAt: 1 },
      { role: "toolResult", content: [{ type: "text", text }], toolName: "grep", isError: false, toolCallId: "p2", prunedAt: 2 },
      { role: "toolResult", content: [{ type: "text", text }], toolName: "grep", isError: false, toolCallId: "p3" },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });

    expect((result.messages as any).map((m: any) => m.content[0].text)).toEqual([text, text, text]);
    expect(state.tokensKeptOutTotal).toBe(0);
  });

  it("preserves image blocks when rewriting tool results", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
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

  it("leaves recent multi-line error tool results unchanged even when truncation is enabled", () => {
    const state = createSessionState("/tmp");
    state.currentTurn = 2;
    state.toolCalls.set("t1", {
      toolCallId: "t1",
      toolName: "bash",
      inputArgs: {},
      inputFingerprint: "bash::{}",
      isError: true,
      turnIndex: 2,
      timestamp: Date.now(),
      tokenEstimate: 10,
    });

    const cfg = defaultConfig();
    cfg.strategies.truncation.enabled = true;
    cfg.strategies.truncation.headLines = 1;
    cfg.strategies.truncation.tailLines = 1;
    cfg.strategies.truncation.minLines = 2;
    cfg.strategies.errorPurge.enabled = false;

    const msgs = [
      {
        role: "toolResult",
        content: [{ type: "text", text: "line 1\nline 2\nline 3" }],
        toolName: "bash",
        isError: true,
        toolCallId: "t1",
        _key: "t1",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });

    expect(result.messages?.[0]).toEqual(msgs[0]);
  });

  it("declines stale-error purge for mixed-content tool results with multiple text blocks", () => {
    const state = createSessionState("/tmp");
    state.currentTurn = 10;
    state.toolCalls.set("t1", {
      toolCallId: "t1",
      toolName: "bash",
      inputArgs: {},
      inputFingerprint: "bash::{}",
      isError: true,
      turnIndex: 2,
      timestamp: Date.now(),
      tokenEstimate: 10,
    });

    const cfg = defaultConfig();
    cfg.strategies.errorPurge.enabled = true;
    cfg.strategies.errorPurge.maxTurnsAgo = 3;
    cfg.strategies.shortCircuit.enabled = false;
    cfg.strategies.codeFilter.enabled = false;
    cfg.strategies.truncation.enabled = false;
    cfg.strategies.deduplication.enabled = false;

    const msgs = [
      {
        role: "toolResult",
        content: [
          { type: "text", text: "error line 1" },
          { type: "image", data: "img-data", mimeType: "image/png" },
          { type: "text", text: "error line 2" },
        ],
        toolName: "bash",
        isError: true,
        toolCallId: "t1",
        _key: "t1",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });
    const toolMsg = result.messages?.[0] as any;

    expect(toolMsg.content).toEqual(msgs[0].content);
  });

  it("purges stale mixed-content error results with a single text block while preserving non-text content", () => {
    const state = createSessionState("/tmp");
    state.currentTurn = 10;
    state.toolCalls.set("t1", {
      toolCallId: "t1",
      toolName: "bash",
      inputArgs: {},
      inputFingerprint: "bash::{}",
      isError: true,
      turnIndex: 2,
      timestamp: Date.now(),
      tokenEstimate: 10,
    });

    const cfg = defaultConfig();
    cfg.strategies.errorPurge.enabled = true;
    cfg.strategies.errorPurge.maxTurnsAgo = 3;
    cfg.strategies.truncation.enabled = false;

    const msgs = [
      {
        role: "toolResult",
        content: [
          { type: "image", data: "img-data", mimeType: "image/png" },
          { type: "text", text: Array.from({ length: 20 }, (_, index) => `error line ${index + 1}`).join("\n") },
        ],
        toolName: "bash",
        isError: true,
        toolCallId: "t1",
        _key: "t1",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });
    const toolMsg = result.messages?.[0] as any;

    expect(toolMsg.content).toEqual([
      { type: "image", data: "img-data", mimeType: "image/png" },
      {
        type: "text",
        text: "[Error output removed -- tool failed more than 3 turns ago]",
      },
    ]);
    expect(state.tokensKeptOutByType.error_purge ?? 0).toBeGreaterThan(0);
    expect(state.tokensKeptOutByType.error_purge ?? 0).toBeGreaterThan(0);
  });

  it("declines stale-error purge for larger mixed-content tool results with multiple text blocks", () => {
    const state = createSessionState("/tmp");
    state.currentTurn = 10;
    state.toolCalls.set("t1", {
      toolCallId: "t1",
      toolName: "bash",
      inputArgs: {},
      inputFingerprint: "bash::{}",
      isError: true,
      turnIndex: 2,
      timestamp: Date.now(),
      tokenEstimate: 10,
    });

    const cfg = defaultConfig();
    cfg.strategies.errorPurge.enabled = true;
    cfg.strategies.errorPurge.maxTurnsAgo = 3;
    cfg.strategies.truncation.enabled = true;
    cfg.strategies.truncation.headLines = 1;
    cfg.strategies.truncation.tailLines = 1;
    cfg.strategies.truncation.minLines = 2;

    const msgs = [
      {
        role: "toolResult",
        content: [
          { type: "text", text: ["error line 1", "error line 2", "error line 3", "error line 4", "error line 5"].join("\n") },
          { type: "image", data: "img-data", mimeType: "image/png" },
          { type: "text", text: ["error line 6", "error line 7", "error line 8", "error line 9", "error line 10"].join("\n") },
        ],
        toolName: "bash",
        isError: true,
        toolCallId: "t1",
        _key: "t1",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });
    const toolMsg = result.messages?.[0] as any;

    expect(toolMsg.content).toEqual(msgs[0].content);
    expect(state.tokensKeptOutByType.error_purge ?? 0).toBe(0);
    expect(state.tokensKeptOutByType.error_purge ?? 0).toBe(0);
  });

  it("still advances dedup tracking for mixed-content tool results", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.deduplication.maxOccurrences = 1;
    cfg.strategies.codeFilter.enabled = true;
    cfg.strategies.codeFilter.maxBodyLines = 1;
    cfg.strategies.shortCircuit.enabled = false;
    cfg.strategies.truncation.enabled = false;
    cfg.strategies.errorPurge.enabled = false;

    const mixedPayload = [
      "function demo() {",
      "  const a = 1;",
      "  const b = 2;",
      "  return a + b;",
      "}",
    ].join("\n");
    const msgs = [
      {
        role: "toolResult",
        content: [
          { type: "text", text: "function demo() {" },
          { type: "image", data: "img-data", mimeType: "image/png" },
          { type: "text", text: "  const a = 1;\n  const b = 2;\n  return a + b;\n}" },
        ],
        toolName: "typescript",
        isError: false,
        toolCallId: "t1",
        _key: "t1",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: mixedPayload }],
        toolName: "typescript",
        isError: false,
        toolCallId: "t2",
        _key: "t2",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });

    expect(result.messages?.[0]).toEqual(msgs[0]);
    expect((result.messages as any)[1].content[0].text).toBe("[dedup: see earlier typescript result x1]");
  });

  it("advances dedup bookkeeping for mixed-content duplicates without crediting savings", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.deduplication.maxOccurrences = 1;
    cfg.strategies.shortCircuit.enabled = false;
    cfg.strategies.codeFilter.enabled = false;
    cfg.strategies.truncation.enabled = false;
    cfg.strategies.errorPurge.enabled = false;

    const msgs = [
      {
        role: "toolResult",
        content: [
          { type: "text", text: "alpha" },
          { type: "image", data: "img-data", mimeType: "image/png" },
          { type: "text", text: "beta" },
        ],
        toolName: "grep",
        isError: false,
        toolCallId: "t1",
        _key: "t1",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "alpha\nbeta" }],
        toolName: "grep",
        isError: false,
        toolCallId: "t2",
        _key: "t2",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });

    expect(result.messages?.[0]).toEqual(msgs[0]);
    expect((result.messages as any)[1].content[0].text).toBe("[dedup: see earlier grep result x1]");
    expect(state.tokensKeptOutByType.dedup ?? 0).toBe(0);
    expect(state.tokensKeptOutByType.dedup ?? 0).toBe(0);
  });

  it("does not deduplicate normalized content from different read inputs", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.deduplication.maxOccurrences = 1;

    getOrCreateToolRecord(state, "t1", "read", { path: "a.log" }, false, 0);
    getOrCreateToolRecord(state, "t2", "read", { path: "b.log" }, false, 0);

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
    expect((result.messages as any)[1].content[0].text).toContain("build");
  });

  it("deduplicates repeated normalized content from the same grep input fingerprint", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.deduplication.maxOccurrences = 1;

    getOrCreateToolRecord(state, "t1", "grep", { path: "a.log" }, false, 0);
    getOrCreateToolRecord(state, "t2", "grep", { path: "a.log" }, false, 0);

    const msgs = [
      {
        role: "toolResult",
        content: [{ type: "text", text: "build 2026-04-14T10:11:12Z abcdefab-cdef-4123-89ab-abcdefabcdef" }],
        toolName: "grep",
        isError: false,
        toolCallId: "t1",
        _key: "t1",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "build 2026-04-15T11:12:13Z 12345678-1234-4123-8234-1234567890ab" }],
        toolName: "grep",
        isError: false,
        toolCallId: "t2",
        _key: "t2",
      },
    ] as any;

    const result = materializeContext(msgs, { state, config: cfg });

    expect((result.messages as any)[0].content[0].text).toContain("build");
    expect((result.messages as any)[1].content[0].text).toBe("[dedup: see earlier grep result x1]");
  });

  it("does not crash when a rebuilt tool record has an undefined fingerprint", () => {
    const state = createSessionState("/tmp");
    const cfg = defaultConfig();
    cfg.strategies.deduplication.maxOccurrences = 1;

    getOrCreateToolRecord(state, "t1", "read", undefined, false, 0);

    const msgs = [
      {
        role: "toolResult",
        content: [{ type: "text", text: "build 2026-04-16T10:11:12Z abcdefab-cdef-4123-89ab-abcdefabcdef" }],
        toolName: "read",
        isError: false,
        toolCallId: "t1",
        _key: "t1",
      },
    ] as any;

    expect(() => materializeContext(msgs, { state, config: cfg })).not.toThrow();
    expect(state.toolCalls.get("t1")?.inputFingerprint).toBe("");
  });
});
