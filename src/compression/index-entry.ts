import type { IndexEntry, IndexedPruneTarget } from "../persistence/index-store.js";

export function buildIndexEntry(
  start: number,
  end: number,
  topic: string,
  count: number,
  pruneTargets: IndexedPruneTarget[] = [],
): IndexEntry {
  return {
    turnRange: `${start}-${end}`,
    topic,
    summary: "",
    timestamp: Date.now(),
    messageCount: count,
    indexedAt: Date.now(),
    pruneTargets,
  };
}

export function formatTOC(entries: IndexEntry[]): string {
  const header = `${entries.length} completed phase(s) indexed:`;
  const lines = entries.map((e) => `  - [${e.turnRange}] ${e.topic}`);
  return [header, ...lines].join("\n");
}

export function buildCompactionSummary(entries: IndexEntry[], maxChars = 4096): string {
  const header = `${entries.length} completed phase(s) indexed:`;
  let summary = header;
  let included = 0;

  for (const entry of entries) {
    const line = `  - [${entry.turnRange}] ${entry.topic}`;
    const candidate = `${summary}\n${line}`;
    if (candidate.length > maxChars) {
      break;
    }
    summary = candidate;
    included += 1;
  }

  if (included < entries.length) {
    const marker = `\n  - ... (${entries.length - included} more)`;
    if (summary.length + marker.length <= maxChars) {
      return `${summary}${marker}`;
    }

    if (maxChars <= 3) {
      return "...".slice(0, maxChars);
    }

    return `${summary.slice(0, maxChars - 3)}...`;
  }

  return summary;
}
