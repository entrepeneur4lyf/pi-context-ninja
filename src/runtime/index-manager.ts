import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { buildIndexEntry } from "../compression/index-entry.js";
import { extractTopicFromRange } from "../compression/summarizer.js";
import { selectStaleRanges } from "../compression/range-selection.js";
import { appendIndexEntry, getIndexPath } from "../persistence/index-store.js";
import type { PCNConfig } from "../config.js";
import type { OmitRange, PruneTarget, SessionState } from "../types.js";
import { isToolResultMessage } from "../messages.js";

export function refreshRangeIndex(
  messages: AgentMessage[],
  state: SessionState,
  config: PCNConfig,
  projectPath = state.projectPath,
): PruneTarget[] {
  if (!config.backgroundIndexing.enabled) {
    return [];
  }

  const lastIndexedTurn = Math.max(
    state.pruneTargets.at(-1)?.turnIndex ?? -1,
    state.omitRanges.at(-1)?.endTurn ?? -1,
  );
  const stale = selectStaleRanges(
    state.currentTurn,
    lastIndexedTurn,
    config.backgroundIndexing.minRangeTurns,
  );

  if (!stale) {
    return [];
  }

  const toolResults = messages.filter(isToolResultMessage).filter((message) => {
    const record = state.toolCalls.get(message.toolCallId);
    return record !== undefined && record.turnIndex >= stale.startTurn && record.turnIndex <= stale.endTurn;
  });

  const indexedAt = Date.now();
  const summaryRef = `${stale.startTurn}-${stale.endTurn}`;
  const offsets = resolveTurnOffsets(state, stale.startTurn, stale.endTurn);

  if (toolResults.length === 0) {
    if (!offsets) {
      return [];
    }

    const slice = messages.slice(offsets.startOffset, offsets.endOffset + 1);
    if (slice.length === 0) {
      return [];
    }

    const entry = buildIndexEntry(stale.startTurn, stale.endTurn, extractTopicFromRange(slice), slice.length);
    appendIndexEntry(getIndexPath(projectPath || "default"), entry);

    state.omitRanges.push({
      startTurn: stale.startTurn,
      endTurn: stale.endTurn,
      startOffset: offsets.startOffset,
      endOffset: offsets.endOffset,
      indexedAt,
      summaryRef,
      messageCount: slice.length,
    });

    return [];
  }

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

  if (offsets) {
    const range: OmitRange = {
      startTurn: stale.startTurn,
      endTurn: stale.endTurn,
      startOffset: offsets.startOffset,
      endOffset: offsets.endOffset,
      indexedAt,
      summaryRef,
      messageCount: toolResults.length,
    };
    state.omitRanges.push(range);
  }

  return pruneTargets;
}

export function resolveTurnOffsets(
  state: SessionState,
  startTurn: number,
  endTurn: number,
): { startOffset: number; endOffset: number } | null {
  const previousTurn = state.turnHistory.find((entry) => entry.turnIndex === startTurn - 1);
  const endTurnEntry = state.turnHistory.find((entry) => entry.turnIndex === endTurn);

  const startOffset = previousTurn?.messageCountAfterTurn ?? 0;
  const endOffset = endTurnEntry ? endTurnEntry.messageCountAfterTurn - 1 : startOffset - 1;

  if (endOffset < startOffset) {
    return null;
  }

  return { startOffset, endOffset };
}
