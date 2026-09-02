import { describe, expect, it } from "bun:test";
import { createPiMock } from "./helpers";
import { createSessionState } from "../src/state";
import {
  SESSION_STATE_ENTRY_TYPE,
  appendSessionState,
  readSessionStateFromBranch,
} from "../src/persistence/session-entries";

describe("session entries", () => {
  it("round-trips session state through a custom entry", () => {
    const { pi, entries } = createPiMock();
    const state = createSessionState("/tmp/project");
    state.currentTurn = 4;
    state.tokensKeptOutTotal = 120;
    state.tokensKeptOutByType.dedup = 120;
    state.countedSavingsIds.add("c1:dedup");
    state.systemHintState = { appliedOnce: true, lastAppliedText: "hint" };

    appendSessionState(pi, state);

    expect(entries).toHaveLength(1);
    expect(entries[0].customType).toBe(SESSION_STATE_ENTRY_TYPE);
    const loaded = readSessionStateFromBranch(entries);
    expect(loaded?.currentTurn).toBe(4);
    expect(loaded?.tokensKeptOutTotal).toBe(120);
    expect(loaded?.countedSavingsIds).toEqual(["c1:dedup"]);
    expect(loaded?.systemHintState).toEqual({ appliedOnce: true, lastAppliedText: "hint" });
    expect(loaded?.projectPath).toBe("/tmp/project");
  });

  it("returns the newest PCN entry on the branch", () => {
    const { pi, entries } = createPiMock();
    const first = createSessionState("/tmp/project");
    first.currentTurn = 1;
    appendSessionState(pi, first);
    entries.push({ type: "custom", id: "other", customType: "com.example.other", data: { currentTurn: 99 }, timestamp: 0 });
    const second = createSessionState("/tmp/project");
    second.currentTurn = 2;
    appendSessionState(pi, second);

    expect(readSessionStateFromBranch(entries)?.currentTurn).toBe(2);
  });

  it("returns null when the branch has no PCN entry", () => {
    expect(readSessionStateFromBranch([])).toBeNull();
    expect(readSessionStateFromBranch([{ type: "message", id: "m1" }])).toBeNull();
  });

  it("returns null when the newest PCN entry carries invalid data", () => {
    const entries = [
      { type: "custom", id: "bad", customType: SESSION_STATE_ENTRY_TYPE, data: { currentTurn: "wrong", projectPath: 42, turnHistory: "no" }, timestamp: 0 },
    ];
    expect(readSessionStateFromBranch(entries)).toBeNull();
  });

  it("does not throw when the host offers no appendEntry", () => {
    const state = createSessionState("/tmp/project");
    expect(() => appendSessionState({} as never, state)).not.toThrow();
  });
});
