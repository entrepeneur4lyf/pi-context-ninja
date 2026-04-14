import fs from "fs";
import path from "path";

export interface IndexEntry {
  turnRange: string;
  topic: string;
  summary: string;
  timestamp: string;
  messageCount: number;
  indexedAt: string;
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
