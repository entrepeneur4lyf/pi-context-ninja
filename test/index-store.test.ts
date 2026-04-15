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

  it("refreshes a stale transcript slice into a project-scoped index entry and omit range", () => {
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

    expect(state.omitRanges).toHaveLength(1);
    expect(state.omitRanges[0]).toMatchObject({
      startTurn: 0,
      endTurn: 3,
      startOffset: 0,
      endOffset: 11,
      messageCount: 12,
    });

    const entries = readIndexEntries(getIndexPath("/workspace/project-a"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.turnRange).toBe("0-3");
    expect(readIndexEntries(getIndexPath("session-1"))).toEqual([]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PCN_INDEX_DIR;
  });
});
