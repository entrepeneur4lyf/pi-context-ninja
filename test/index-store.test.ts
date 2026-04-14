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
});
