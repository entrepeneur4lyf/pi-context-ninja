import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { PCNConfig } from "../config.js";
import type { SessionState } from "../types.js";
import { extractTextContent, isToolResultMessage, replaceToolContent } from "../messages.js";
import { creditSavings } from "../state.js";
import { shortCircuit } from "./short-circuit.js";
import { codeFilter, detectLanguage } from "./code-filter.js";
import { headTailTruncate } from "./truncation.js";
import { fingerprintDedup, normalizeContent } from "./dedup.js";
import { shouldPurgeError, makeErrorTombstone } from "./error-purge.js";
import { applyOmitRanges } from "./pruning.js";

export interface MaterializeOptions {
  state: SessionState;
  config: PCNConfig;
}

export function materializeContext(
  messages: AgentMessage[],
  options: MaterializeOptions,
): { messages?: AgentMessage[] } {
  const { state, config } = options;
  const seen = new Map<string, number>();

  const processed = messages.map((msg) => {
    if (!isToolResultMessage(msg)) {
      return msg;
    }

    const originalText = extractTextContent(msg);
    const toolName = (msg as any).toolName ?? "";
    const toolCallId = (msg as any).toolCallId ?? "";
    const isErr = !!(msg as any).isError;
    const isProtectedTool = config.strategies.deduplication.protectedTools.includes(toolName);
    if (isProtectedTool && !isErr) {
      return msg;
    }

    let currentText = originalText;
    let newText: string | null = null;

    if (config.strategies.shortCircuit.enabled && !isErr) {
      const candidate = shortCircuit(currentText, isErr, config.strategies.shortCircuit.minTokens);
      if (candidate !== null) {
        creditSavings(
          state,
          toolCallId,
          "short_circuit",
          Math.max(0, currentText.length - candidate.length),
          Math.max(0, currentText.length - candidate.length),
        );
        currentText = candidate;
        newText = candidate;
      }
    }

    if (config.strategies.codeFilter.enabled && !isErr) {
      const lang = detectLanguage(currentText);
      if (lang) {
        const candidate = codeFilter(
          currentText,
          lang,
          config.strategies.codeFilter,
        );
        if (candidate !== null) {
          creditSavings(
            state,
            toolCallId,
            "code_filter",
            Math.max(0, currentText.length - candidate.length),
            Math.max(0, currentText.length - candidate.length),
          );
          currentText = candidate;
          newText = candidate;
        }
      }
    }

    if (config.strategies.truncation.enabled) {
      const candidate = headTailTruncate(currentText, config.strategies.truncation);
      if (candidate !== null) {
        creditSavings(
          state,
          toolCallId,
          "truncation",
          Math.max(0, currentText.length - candidate.length),
          Math.max(0, currentText.length - candidate.length),
        );
        currentText = candidate;
        newText = candidate;
      }
    }

    if (config.strategies.deduplication.enabled) {
      const fingerprint =
        (msg as any).__pcnFingerprint ?? `${toolName}::${normalizeContent(currentText)}`;
      const candidate = fingerprintDedup(
        toolCallId,
        toolName,
        fingerprint,
        seen,
        config.strategies.deduplication.maxOccurrences,
        config.strategies.deduplication.protectedTools,
      );
      if (candidate !== null) {
        creditSavings(
          state,
          toolCallId,
          "dedup",
          Math.max(0, currentText.length - candidate.length),
          Math.max(0, currentText.length - candidate.length),
        );
        currentText = candidate;
        newText = candidate;
      }
    }

    if (config.strategies.errorPurge.enabled && isErr) {
      const rec = state.toolCalls.get(toolCallId);
      const errorTurnIndex = rec?.turnIndex ?? state.currentTurn;
      if (
        shouldPurgeError(
          errorTurnIndex,
          state.currentTurn,
          config.strategies.errorPurge.maxTurnsAgo,
        )
      ) {
        const candidate = makeErrorTombstone(config.strategies.errorPurge.maxTurnsAgo);
        creditSavings(
          state,
          toolCallId,
          "error_purge",
          Math.max(0, currentText.length - candidate.length),
          Math.max(0, currentText.length - candidate.length),
        );
        currentText = candidate;
        newText = candidate;
      }
    }

    if (newText !== null) {
      return replaceToolContent(msg, newText);
    }

    return msg;
  });

  const final = applyOmitRanges(processed, state.omitRanges);
  return { messages: final };
}
