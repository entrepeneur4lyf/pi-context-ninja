import fs from "fs";
import os from "node:os";
import path from "path";

export interface IndexEntry {
  turnRange: string;
  topic: string;
  summary: string;
  timestamp: number;
  messageCount: number;
  indexedAt: number;
}

export function getIndexDir(): string {
  return path.resolve(process.env.PCN_INDEX_DIR ?? path.join(os.homedir(), ".pi-ninja", "index"));
}

export function getIndexPath(indexId: string): string {
  return path.join(getIndexDir(), `${encodeURIComponent(indexId)}.jsonl`);
}

export function appendIndexEntry(filePath: string, entry: IndexEntry): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

export function readIndexEntries(filePath: string): IndexEntry[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as IndexEntry);
}
