import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OmitRange } from "../types.js";

export function applyOmitRanges(
  messages: AgentMessage[],
  omitRanges: OmitRange[],
): AgentMessage[] {
  if (omitRanges.length === 0) {
    return [...messages];
  }

  const omit = new Set<number>();

  for (const range of omitRanges) {
    const start = Math.max(0, Math.min(messages.length - 1, range.startOffset));
    const end = Math.max(0, Math.min(messages.length - 1, range.endOffset));
    if (end < start) {
      continue;
    }

    for (let index = start; index <= end; index += 1) {
      omit.add(index);
    }
  }

  return messages.filter((_, index) => !omit.has(index));
}

export function createTombstone(strategy: string): string {
  return `[pruned by ${strategy}]`;
}
