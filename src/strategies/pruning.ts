import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OmitRange } from "../types.js";

export function applyOmitRanges(
  messages: AgentMessage[],
  omitRanges: OmitRange[],
): AgentMessage[] {
  if (omitRanges.length === 0) {
    return [...messages];
  }

  const keys = messages.map(msgKey);
  const keyToIndex = new Map<string, number>();

  keys.forEach((key, index) => {
    if (key && !keyToIndex.has(key)) {
      keyToIndex.set(key, index);
    }
  });

  const omitSet = new Set<string>();

  for (const range of omitRanges) {
    const startIndex = keyToIndex.get(range.startKey);
    const endIndex = keyToIndex.get(range.endKey);

    if (startIndex === undefined || endIndex === undefined) {
      continue;
    }

    const [from, to] = startIndex <= endIndex
      ? [startIndex, endIndex]
      : [endIndex, startIndex];

    for (let index = from; index <= to; index += 1) {
      const key = keys[index];
      if (key) {
        omitSet.add(key);
      }
    }
  }

  return messages.filter((message) => !omitSet.has(msgKey(message)));
}

export function createTombstone(strategy: string): string {
  return `[pruned by ${strategy}]`;
}

function msgKey(msg: AgentMessage): string {
  return (msg as any)._key ?? (msg as any).toolCallId ?? (msg as any).id ?? "";
}
