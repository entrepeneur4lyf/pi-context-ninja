import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { buildIndexEntry } from "../compression/index-entry.js";
import { extractTopicFromRange } from "../compression/summarizer.js";
import { selectStaleRanges } from "../compression/range-selection.js";
import { appendIndexEntry, getIndexPath } from "../persistence/index-store.js";
import type { PCNConfig } from "../config.js";
import type { PruneTarget, SessionState } from "../types.js";
import { isToolResultMessage } from "../messages.js";
import { canApplyPruneTarget } from "../strategies/pruning.js";

export function refreshRangeIndex(
  messages: AgentMessage[],
  state: SessionState,
  config: PCNConfig,
  projectPath = state.projectPath,
): PruneTarget[] {
  if (!config.backgroundIndexing.enabled) {
    return [];
  }

  const stale = selectStaleRanges(
    state.currentTurn,
    state.lastIndexedTurn,
    config.backgroundIndexing.minRangeTurns,
  );

  if (!stale) {
    return [];
  }

  const toolResults = messages.filter(isToolResultMessage).filter((message) => {
    const record = state.toolCalls.get(message.toolCallId);
    return (
      record !== undefined &&
      !record.awaitingAuthoritativeTurn &&
      !record.isError &&
      !(message as any).isError &&
      canApplyPruneTarget(message) &&
      record.turnIndex >= stale.startTurn &&
      record.turnIndex <= stale.endTurn
    );
  });

  if (toolResults.length === 0) {
    return [];
  }

  const indexedAt = Date.now();
  const summaryRef = `${stale.startTurn}-${stale.endTurn}`;

  const pruneTargets: PruneTarget[] = toolResults.map((message) => {
    const record = state.toolCalls.get(message.toolCallId);
    const turnIndex = record?.turnIndex ?? stale.startTurn;
    return {
      toolCallId: message.toolCallId,
      turnIndex,
      indexedAt,
      summaryRef,
      replacementText: `[pruned: indexed ${message.toolName} result ${summaryRef}]`,
    };
  });

  const topic = extractTopicFromRange(toolResults);
  const entry = buildIndexEntry(
    stale.startTurn,
    stale.endTurn,
    topic,
    toolResults.length,
    pruneTargets.map(({ toolCallId, turnIndex, replacementText }) => ({
      toolCallId,
      turnIndex,
      replacementText,
    })),
  );
  appendIndexEntry(getIndexPath(projectPath || "default"), entry);

  state.pruneTargets.push(...pruneTargets);
  state.lastIndexedTurn = stale.endTurn;

  return pruneTargets;
}
