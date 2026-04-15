import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { buildIndexEntry } from "../compression/index-entry.js";
import { extractTopicFromRange } from "../compression/summarizer.js";
import { selectStaleRanges } from "../compression/range-selection.js";
import { appendIndexEntry, getIndexPath } from "../persistence/index-store.js";
import type { PCNConfig } from "../config.js";
import type { OmitRange, SessionState } from "../types.js";

export function refreshRangeIndex(
  messages: AgentMessage[],
  state: SessionState,
  config: PCNConfig,
): OmitRange | null {
  if (!config.backgroundIndexing.enabled) {
    return null;
  }

  const lastIndexedTurn = state.omitRanges.at(-1)?.endTurn ?? -1;
  const stale = selectStaleRanges(
    state.currentTurn,
    lastIndexedTurn,
    config.backgroundIndexing.minRangeTurns,
  );

  if (!stale) {
    return null;
  }

  const offsets = resolveTurnOffsets(state, stale.startTurn, stale.endTurn);
  if (!offsets) {
    return null;
  }

  const slice = messages.slice(offsets.startOffset, offsets.endOffset + 1);
  if (slice.length === 0) {
    return null;
  }

  const topic = extractTopicFromRange(slice);
  const entry = buildIndexEntry(stale.startTurn, stale.endTurn, topic, slice.length);
  appendIndexEntry(getIndexPath(state.projectPath || "default"), entry);

  const range: OmitRange = {
    startTurn: stale.startTurn,
    endTurn: stale.endTurn,
    startOffset: offsets.startOffset,
    endOffset: offsets.endOffset,
    indexedAt: entry.indexedAt,
    summaryRef: entry.turnRange,
    messageCount: slice.length,
  };

  state.omitRanges.push(range);
  return range;
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
