import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { appendIndexEntry, readIndexEntries } from "../src/persistence/index-store";

describe("index-store", () => {
  it("appends and reads", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-index-"));
    const filePath = path.join(tmpDir, "idx.jsonl");

    appendIndexEntry(filePath, {
      turnRange: "1-5",
      topic: "setup",
      summary: "initial setup",
      timestamp: "2026-04-14T18:00:00.000Z",
      messageCount: 5,
      indexedAt: "2026-04-14T18:05:00.000Z",
    });

    appendIndexEntry(filePath, {
      turnRange: "6-9",
      topic: "auth",
      summary: "authentication changes",
      timestamp: "2026-04-14T18:06:00.000Z",
      messageCount: 4,
      indexedAt: "2026-04-14T18:10:00.000Z",
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
});
