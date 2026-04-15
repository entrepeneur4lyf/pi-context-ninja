import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { PruneTarget } from "../types.js";
import {
  countToolTextBlocks,
  isToolResultMessage,
  replaceSingleToolTextContent,
} from "../messages.js";

export function canApplyPruneTarget(message: AgentMessage): boolean {
  return isToolResultMessage(message) && countToolTextBlocks(message) === 1;
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
    if (typeof toolCallId !== "string" || !canApplyPruneTarget(message)) {
      return message;
    }

    const replacementText = replacements.get(toolCallId);
    if (replacementText === undefined) {
      return message;
    }

    return replaceSingleToolTextContent(message, replacementText);
  });
}

export function createTombstone(strategy: string): string {
  return `[pruned by ${strategy}]`;
}
