import type { IndexEntry } from "../persistence/index-store.js";

export function buildIndexEntry(
  start: number,
  end: number,
  topic: string,
  count: number
): IndexEntry {
  return {
    turnRange: `${start}-${end}`,
    topic,
    summary: "",
    timestamp: Date.now(),
    messageCount: count,
    indexedAt: Date.now(),
  };
}

export function formatTOC(entries: IndexEntry[]): string {
  const header = `${entries.length} completed phase(s) indexed:`;
  const lines = entries.map((e) => `  - [${e.turnRange}] ${e.topic}`);
  return [header, ...lines].join("\n");
}
