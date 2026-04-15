import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSessionState } from "../src/state";

let stateDir = "";

async function loadStateStore() {
  vi.resetModules();
  return import("../src/persistence/state-store");
}

function cleanupStateDir() {
  if (stateDir) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("state store", () => {
  beforeEach(() => {
    cleanupStateDir();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-state-store-"));
    process.env.PCN_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.PCN_STATE_DIR;
    cleanupStateDir();
    stateDir = "";
  });

  it("saves and loads persisted session state", async () => {
    const { saveSessionState, loadSessionState, getStatePath } = await loadStateStore();
    const s = createSessionState("/tmp");
    s.currentTurn = 5;
    s.lastIndexedTurn = 4;
    s.tokensKeptOutTotal = 1000;
    s.pruneTargets.push({
      toolCallId: "call-2",
      turnIndex: 4,
      indexedAt: 999,
      summaryRef: "2-4",
      replacementText: "[pruned: indexed call-2]",
    });
    s.toolCalls.set("call-1", {
      toolCallId: "call-1",
      toolName: "read",
      inputArgs: { path: "a.ts" },
      inputFingerprint: "{\"path\":\"a.ts\"}",
      isError: false,
      turnIndex: 4,
      timestamp: 123,
      tokenEstimate: 42,
    });
    s.systemHintState.appliedOnce = true;
    s.systemHintState.lastAppliedText = "Keep the context small.";
    s.countedSavingsIds.add("call-1:dedup");
    s.prunedToolIds.add("call-2");
    s.turnHistory.push({
      turnIndex: 5,
      toolCount: 1,
      messageCountAfterTurn: 9,
      tokensKeptOutDelta: 500,
      tokensSavedDelta: 500,
      timestamp: 456,
    });

    saveSessionState("s1", s);
    const persistedJson = JSON.parse(fs.readFileSync(getStatePath("s1"), "utf8"));
    const loaded = loadSessionState("s1");

    expect(loaded).not.toBeNull();
    expect(loaded?.currentTurn).toBe(5);
    expect(loaded?.lastIndexedTurn).toBe(4);
    expect(loaded?.tokensKeptOutTotal).toBe(1000);
    expect(persistedJson).not.toHaveProperty("omitRanges");
    expect(loaded?.toolCalls).toEqual([
      [
        "call-1",
        expect.objectContaining({
          toolCallId: "call-1",
          toolName: "read",
        }),
      ],
    ]);
    expect(loaded?.prunedToolIds).toEqual(["call-2"]);
    expect((loaded as any)?.omitRanges).toBeUndefined();
    expect(loaded?.pruneTargets).toEqual([
      {
        toolCallId: "call-2",
        turnIndex: 4,
        indexedAt: 999,
        summaryRef: "2-4",
        replacementText: "[pruned: indexed call-2]",
      },
    ]);
    expect(loaded?.countedSavingsIds).toEqual(["call-1:dedup"]);
    expect(loaded?.turnHistory[0]).toMatchObject({ messageCountAfterTurn: 9 });
    expect(loaded?.systemHintState).toEqual({
      appliedOnce: true,
      lastAppliedText: "Keep the context small.",
    });
  });

  it("returns null when the state file is missing", async () => {
    const { loadSessionState } = await loadStateStore();

    expect(loadSessionState("missing")).toBeNull();
  });

  it("writes atomically without leaving a tmp file behind", async () => {
    const { saveSessionState, getStatePath } = await loadStateStore();
    const s = createSessionState("/tmp");

    saveSessionState("s1", s);

    const statePath = getStatePath("s1");
    expect(fs.existsSync(statePath)).toBe(true);
    expect(path.extname(statePath)).toBe(".json");
    expect(fs.readdirSync(stateDir).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("drops legacy omit ranges on load instead of rehydrating them", async () => {
    const { loadSessionState, getStatePath } = await loadStateStore();
    const statePath = getStatePath("legacy");
    const legacy = {
      omitRanges: [
        {
          startKey: "a",
          endKey: "b",
          turnRange: "1-2",
          indexedAt: 111,
          summaryRef: "sum-1",
          messageCount: 2,
        },
        {
          startKey: "c",
          endKey: "d",
          indexedAt: 222,
          summaryRef: "sum-2",
          messageCount: 1,
        },
      ],
      currentTurn: 7,
      lastIndexedTurn: 6,
      tokensKeptOutTotal: 111,
      tokensSaved: 222,
      tokensKeptOutByType: { dedup: 11 },
      tokensSavedByType: { dedup: 22 },
      turnHistory: [
        {
          turnIndex: 0,
          toolCount: 1,
          messageCountAfterTurn: 2,
          tokensKeptOutDelta: 0,
          tokensSavedDelta: 0,
          timestamp: 111,
        },
        {
          turnIndex: 2,
          toolCount: 1,
          messageCountAfterTurn: 9,
          tokensKeptOutDelta: 33,
          tokensSavedDelta: 44,
          timestamp: 555,
        },
      ],
      projectPath: "/tmp/project",
      systemHintState: {
        appliedOnce: true,
        lastAppliedText: "Keep the context small.",
      },
    };

    fs.writeFileSync(statePath, JSON.stringify(legacy, null, 2), "utf8");

    expect(() => loadSessionState("legacy")).not.toThrow();
    const loaded = loadSessionState("legacy");

    expect(loaded).not.toBeNull();
    expect(loaded?.currentTurn).toBe(7);
    expect(loaded?.lastIndexedTurn).toBe(6);
    expect(loaded?.tokensKeptOutTotal).toBe(111);
    expect(loaded?.tokensSaved).toBe(222);
    expect(loaded?.projectPath).toBe("/tmp/project");
    expect((loaded as any)?.omitRanges).toBeUndefined();
    expect(loaded?.pruneTargets).toEqual([]);
    expect(loaded?.turnHistory[0]).toMatchObject({
      turnIndex: 0,
      toolCount: 1,
      messageCountAfterTurn: 2,
    });
    expect(loaded?.toolCalls).toEqual([]);
    expect(loaded?.prunedToolIds).toEqual([]);
    expect(loaded?.countedSavingsIds).toEqual([]);
    expect(loaded?.lastContextTokens).toBeNull();
    expect(loaded?.lastContextPercent).toBeNull();
    expect(loaded?.lastContextWindow).toBeNull();
    expect(loaded?.systemHintState).toEqual({
      appliedOnce: true,
      lastAppliedText: "Keep the context small.",
    });
  });
});
