import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { PruneTarget, SessionState } from "../types.js";
import {
  countToolTextBlocks,
  extractTextContent,
  isToolResultMessage,
  replaceSingleToolTextContent,
} from "../messages.js";
import { creditSavings } from "../state.js";

export function canApplyPruneTarget(message: AgentMessage): boolean {
  return isToolResultMessage(message) && countToolTextBlocks(message) === 1;
}

export function applyPruneTargets(
  messages: AgentMessage[],
  pruneTargets: PruneTarget[],
  state?: SessionState,
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

    const currentText = extractTextContent(message);
    if (currentText.length <= replacementText.length) {
      return message;
    }

    if (state) {
      const omittedLength = currentText.length - replacementText.length;
      creditSavings(state, toolCallId, "background_index", omittedLength, omittedLength);
    }

    return replaceSingleToolTextContent(message, replacementText);
  });
}

export function createTombstone(strategy: string): string {
  return `[pruned by ${strategy}]`;
}
