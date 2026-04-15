import { describe, it, expect } from "vitest";
import { buildIndexEntry, formatTOC } from "../src/compression/index-entry";
import type { IndexEntry } from "../src/persistence/index-store";
describe("index entry", () => {
  it("builds entry", () => {
    const e = buildIndexEntry(0, 10, "setup", 15);
    expect(e.turnRange).toBe("0-10");
    expect(e.topic).toBe("setup");
  });

  it("builds index entries with explicit prune target descriptors", () => {
    const entry = buildIndexEntry(0, 2, "read output", 1, [
      {
        toolCallId: "read-1",
        turnIndex: 0,
        replacementText: "[pruned: indexed read result 0-0]",
      },
    ]);

    expect(entry.pruneTargets).toEqual([
      {
        toolCallId: "read-1",
        turnIndex: 0,
        replacementText: "[pruned: indexed read result 0-0]",
      },
    ]);
  });

  it("formats TOC", () => {
    const entries: IndexEntry[] = [
      {
        turnRange: "0-10",
        topic: "a",
        summary: "a",
        timestamp: 1,
        messageCount: 11,
        indexedAt: 1,
      },
      {
        turnRange: "11-20",
        topic: "b",
        summary: "b",
        timestamp: 2,
        messageCount: 10,
        indexedAt: 2,
      },
    ];
    const toc = formatTOC(entries);
    expect(toc).toContain("0-10");
  });
});
