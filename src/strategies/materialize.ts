import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { PCNConfig } from "../config.js";
import type { SessionState } from "../types.js";
import {
  countToolTextBlocks,
  extractTextContent,
  isToolResultMessage,
  replaceToolContentWithText,
  replaceSingleToolTextContent,
} from "../messages.js";
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

    const textBlockCount = countToolTextBlocks(msg);
    const canRewriteText = textBlockCount === 1;
    const originalText = extractTextContent(msg);
    const toolName = (msg as any).toolName ?? "";
    const toolCallId = (msg as any).toolCallId ?? "";
    const isErr = !!(msg as any).isError;
    let dedupText = originalText;
    let rewriteText: string | null = null;

    if (config.strategies.shortCircuit.enabled && !isErr) {
      const candidate = shortCircuit(dedupText, isErr, config.strategies.shortCircuit.minTokens);
      if (candidate !== null) {
        if (canRewriteText) {
          creditSavings(
            state,
            toolCallId,
            "short_circuit",
            Math.max(0, dedupText.length - candidate.length),
            Math.max(0, dedupText.length - candidate.length),
          );
        }
        dedupText = candidate;
        if (canRewriteText) {
          rewriteText = candidate;
        }
      }
    }

    if (config.strategies.codeFilter.enabled && !isErr) {
      const lang = detectLanguage(dedupText);
      if (lang) {
        const candidate = codeFilter(
          dedupText,
          lang,
          config.strategies.codeFilter,
        );
        if (candidate !== null) {
          if (canRewriteText) {
            creditSavings(
              state,
              toolCallId,
              "code_filter",
              Math.max(0, dedupText.length - candidate.length),
              Math.max(0, dedupText.length - candidate.length),
            );
          }
          dedupText = candidate;
          if (canRewriteText) {
            rewriteText = candidate;
          }
        }
      }
    }

    if (config.strategies.truncation.enabled) {
      const candidate = headTailTruncate(dedupText, config.strategies.truncation);
      if (candidate !== null) {
        if (canRewriteText) {
          creditSavings(
            state,
            toolCallId,
            "truncation",
            Math.max(0, dedupText.length - candidate.length),
            Math.max(0, dedupText.length - candidate.length),
          );
        }
        dedupText = candidate;
        if (canRewriteText) {
          rewriteText = candidate;
        }
      }
    }

    if (config.strategies.deduplication.enabled) {
      const fingerprint =
        (msg as any).__pcnFingerprint ?? `${toolName}::${normalizeContent(dedupText)}`;
      const candidate = fingerprintDedup(
        toolCallId,
        toolName,
        fingerprint,
        seen,
        config.strategies.deduplication.maxOccurrences,
        config.strategies.deduplication.protectedTools,
      );
      if (candidate !== null) {
        if (canRewriteText) {
          creditSavings(
            state,
            toolCallId,
            "dedup",
            Math.max(0, dedupText.length - candidate.length),
            Math.max(0, dedupText.length - candidate.length),
          );
          rewriteText = candidate;
        }
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
          Math.max(0, dedupText.length - candidate.length),
          Math.max(0, dedupText.length - candidate.length),
        );
        return replaceToolContentWithText(msg, candidate);
      }
    }

    if (rewriteText !== null) {
      return replaceSingleToolTextContent(msg, rewriteText);
    }

    return msg;
  });

  const final = applyOmitRanges(processed, state.omitRanges);
  return { messages: final };
}
