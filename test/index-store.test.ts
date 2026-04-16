import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { appendIndexEntry, getIndexPath, readIndexEntries } from "../src/persistence/index-store";
import { refreshRangeIndex } from "../src/runtime/index-manager";
import { defaultConfig } from "../src/config";
import { createSessionState } from "../src/state";

describe("index-store", () => {
  it("appends and reads", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-index-"));
    const filePath = path.join(tmpDir, "idx.jsonl");

    appendIndexEntry(filePath, {
      turnRange: "1-5",
      topic: "setup",
      summary: "initial setup",
      timestamp: Date.now(),
      messageCount: 5,
      indexedAt: Date.now(),
    });

    appendIndexEntry(filePath, {
      turnRange: "6-9",
      topic: "auth",
      summary: "authentication changes",
      timestamp: Date.now(),
      messageCount: 4,
      indexedAt: Date.now(),
    });

    const entries = readIndexEntries(filePath);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.turnRange).toBe("1-5");
    expect(entries[1]?.topic).toBe("auth");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty for missing file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-index-"));
    const filePath = path.join(tmpDir, "idx.jsonl");

    expect(readIndexEntries(filePath)).toEqual([]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips malformed JSONL lines while keeping valid entries on both sides", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-index-"));
    const filePath = path.join(tmpDir, "idx.jsonl");

    const firstEntry = {
      turnRange: "1-2",
      topic: "setup",
      summary: "first",
      timestamp: 1,
      messageCount: 2,
      indexedAt: 11,
      pruneTargets: [
        {
          toolCallId: "call-1",
          turnIndex: 1,
          replacementText: "[pruned: call-1]",
        },
        {
          toolCallId: "bad-target",
          turnIndex: "nope",
          replacementText: "[pruned: bad-target]",
        },
      ],
    };
    const secondEntry = {
      turnRange: "3-4",
      topic: "auth",
      summary: "second",
      timestamp: 2,
      messageCount: 2,
      indexedAt: 22,
    };

    fs.writeFileSync(
      filePath,
      `${JSON.stringify(firstEntry)}\n{"turnRange":\n${JSON.stringify(secondEntry)}\n`,
      "utf8",
    );

    expect(() => readIndexEntries(filePath)).not.toThrow();
    expect(readIndexEntries(filePath)).toEqual([
      {
        ...firstEntry,
        pruneTargets: [
          {
            toolCallId: "call-1",
            turnIndex: 1,
            replacementText: "[pruned: call-1]",
          },
        ],
      },
      {
        ...secondEntry,
        pruneTargets: [],
      },
    ]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips parseable but invalid JSONL object lines while keeping valid entries on both sides", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-index-"));
    const filePath = path.join(tmpDir, "idx.jsonl");

    const firstEntry = {
      turnRange: "1-2",
      topic: "setup",
      summary: "first",
      timestamp: 1,
      messageCount: 2,
      indexedAt: 11,
    };
    const invalidEntry = {
      turnRange: "2-3",
      topic: "broken",
      summary: "missing numeric fields",
    };
    const secondEntry = {
      turnRange: "3-4",
      topic: "auth",
      summary: "second",
      timestamp: 2,
      messageCount: 2,
      indexedAt: 22,
    };

    fs.writeFileSync(
      filePath,
      `${JSON.stringify(firstEntry)}\n${JSON.stringify(invalidEntry)}\n${JSON.stringify(secondEntry)}\n`,
      "utf8",
    );

    expect(() => readIndexEntries(filePath)).not.toThrow();
    expect(readIndexEntries(filePath)).toEqual([
      {
        ...firstEntry,
        pruneTargets: [],
      },
      {
        ...secondEntry,
        pruneTargets: [],
      },
    ]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not create prune targets when no tool results are present", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-index-manager-"));
    process.env.PCN_INDEX_DIR = tmpDir;

    const state = createSessionState("session-1");
    state.currentTurn = 7;
    state.turnHistory.push(
      {
        turnIndex: 0,
        toolCount: 1,
        messageCountAfterTurn: 2,
        tokensKeptOutDelta: 0,
        tokensSavedDelta: 0,
        timestamp: 1,
      },
      {
        turnIndex: 1,
        toolCount: 1,
        messageCountAfterTurn: 5,
        tokensKeptOutDelta: 0,
        tokensSavedDelta: 0,
        timestamp: 2,
      },
      {
        turnIndex: 2,
        toolCount: 1,
        messageCountAfterTurn: 9,
        tokensKeptOutDelta: 0,
        tokensSavedDelta: 0,
        timestamp: 3,
      },
      {
        turnIndex: 3,
        toolCount: 1,
        messageCountAfterTurn: 12,
        tokensKeptOutDelta: 0,
        tokensSavedDelta: 0,
        timestamp: 4,
      },
    );

    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: "assistant",
      content: `message ${index}`,
    })) as any;

    const config = defaultConfig();
    config.backgroundIndexing.enabled = true;
    config.backgroundIndexing.minRangeTurns = 2;

    refreshRangeIndex(messages, state, config, "/workspace/project-a");

    expect(state.pruneTargets).toHaveLength(0);

    const entries = readIndexEntries(getIndexPath("/workspace/project-a"));
    expect(entries).toHaveLength(0);
    expect(readIndexEntries(getIndexPath("session-1"))).toEqual([]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PCN_INDEX_DIR;
  });

  it("indexes only tool results with a safe single text block", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-index-manager-"));
    process.env.PCN_INDEX_DIR = tmpDir;

    const state = createSessionState("session-1");
    state.currentTurn = 4;
    state.toolCalls.set("safe", {
      toolCallId: "safe",
      toolName: "read",
      inputArgs: { path: "a.ts" },
      inputFingerprint: "{\"path\":\"a.ts\"}",
      isError: false,
      turnIndex: 0,
      timestamp: 1,
      tokenEstimate: 10,
    });
    state.toolCalls.set("unsafe", {
      toolCallId: "unsafe",
      toolName: "read",
      inputArgs: { path: "b.ts" },
      inputFingerprint: "{\"path\":\"b.ts\"}",
      isError: false,
      turnIndex: 0,
      timestamp: 2,
      tokenEstimate: 10,
    });

    const messages = [
      {
        role: "toolResult",
        toolCallId: "safe",
        toolName: "read",
        isError: false,
        content: [
          { type: "image", data: "img-data", mimeType: "image/png" },
          { type: "text", text: "safe file body" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "unsafe",
        toolName: "read",
        isError: false,
        content: [
          { type: "text", text: "first block" },
          { type: "image", data: "img-data", mimeType: "image/png" },
          { type: "text", text: "second block" },
        ],
      },
    ] as any;

    const config = defaultConfig();
    config.backgroundIndexing.enabled = true;
    config.backgroundIndexing.minRangeTurns = 1;

    const pruneTargets = refreshRangeIndex(messages, state, config, "/workspace/project-a");

    expect(pruneTargets).toEqual([
      expect.objectContaining({
        toolCallId: "safe",
      }),
    ]);
    expect(state.pruneTargets).toHaveLength(1);
    expect(state.pruneTargets[0]?.toolCallId).toBe("safe");
    expect(readIndexEntries(getIndexPath("/workspace/project-a"))[0]?.pruneTargets).toEqual([
      expect.objectContaining({
        toolCallId: "safe",
      }),
    ]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PCN_INDEX_DIR;
  });

  it("tracks stale-range progress by indexed window end turn so successive refreshes do not overlap", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-index-manager-"));
    process.env.PCN_INDEX_DIR = tmpDir;

    const state = createSessionState("session-1");
    state.currentTurn = 8;
    state.toolCalls.set("call-0", {
      toolCallId: "call-0",
      toolName: "read",
      inputArgs: { path: "0.ts" },
      inputFingerprint: "{\"path\":\"0.ts\"}",
      isError: false,
      turnIndex: 0,
      timestamp: 1,
      tokenEstimate: 10,
    });
    state.toolCalls.set("call-1", {
      toolCallId: "call-1",
      toolName: "read",
      inputArgs: { path: "1.ts" },
      inputFingerprint: "{\"path\":\"1.ts\"}",
      isError: false,
      turnIndex: 2,
      timestamp: 2,
      tokenEstimate: 10,
    });
    state.toolCalls.set("call-2", {
      toolCallId: "call-2",
      toolName: "read",
      inputArgs: { path: "5.ts" },
      inputFingerprint: "{\"path\":\"5.ts\"}",
      isError: false,
      turnIndex: 5,
      timestamp: 3,
      tokenEstimate: 10,
    });
    state.toolCalls.set("call-3", {
      toolCallId: "call-3",
      toolName: "read",
      inputArgs: { path: "6.ts" },
      inputFingerprint: "{\"path\":\"6.ts\"}",
      isError: false,
      turnIndex: 6,
      timestamp: 4,
      tokenEstimate: 10,
    });

    const config = defaultConfig();
    config.backgroundIndexing.enabled = true;
    config.backgroundIndexing.minRangeTurns = 1;

    refreshRangeIndex([
      {
        role: "toolResult",
        toolCallId: "call-0",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "turn 0" }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "turn 2" }],
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "turn 5" }],
      },
    ] as any, state, config, "/workspace/project-b");

    state.currentTurn = 10;
    refreshRangeIndex([
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "turn 5" }],
      },
      {
        role: "toolResult",
        toolCallId: "call-3",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "turn 6" }],
      },
    ] as any, state, config, "/workspace/project-b");

    const entries = readIndexEntries(getIndexPath("/workspace/project-b"));
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.turnRange)).toEqual(["0-4", "5-6"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PCN_INDEX_DIR;
  });
});
