import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OmitRange, PruneTarget } from "../types.js";
import { isToolResultMessage, replaceToolContentWithText } from "../messages.js";

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

export function applyPruneTargets(
  messages: AgentMessage[],
  pruneTargets: PruneTarget[],
): AgentMessage[] {
  if (pruneTargets.length === 0) {
    return [...messages];
  }

  const replacements = new Map(pruneTargets.map((target) => [target.toolCallId, target.replacementText]));

  return messages.map((message) => {
    if (!isToolResultMessage(message)) {
      return message;
    }

    const toolCallId = (message as any).toolCallId;
    if (typeof toolCallId !== "string") {
      return message;
    }

    const replacementText = replacements.get(toolCallId);
    if (replacementText === undefined) {
      return message;
    }

    return replaceToolContentWithText(message, replacementText);
  });
}

export function createTombstone(strategy: string): string {
  return `[pruned by ${strategy}]`;
}
