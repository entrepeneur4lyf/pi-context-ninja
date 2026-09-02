import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { PCNConfig } from "../config.js";
import type { SessionState } from "../types.js";
import {
  countToolTextBlocks,
  extractTextContent,
  isToolResultMessage,
  replaceSingleToolTextContent,
} from "../messages.js";
import { creditKeptOut } from "../state.js";
import { hasHashlineHeader, isHostPruned, isProtectedTool, isReadResult } from "./protection.js";
import { shortCircuit } from "./short-circuit.js";
import { codeFilter, detectLanguage } from "./code-filter.js";
import { headTailTruncate } from "./truncation.js";
import { fingerprintDedup, normalizeContent } from "./dedup.js";
import { shouldPurgeError, makeErrorTombstone } from "./error-purge.js";

export interface MaterializeOptions {
  state: SessionState;
  config: PCNConfig;
}

/** Kept-out tokens are approximate: characters divided by four. */
function approxTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
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

    const toolName = (msg as any).toolName ?? "";
    if (isHostPruned(msg) || isProtectedTool(toolName, config)) {
      return msg;
    }

    const textBlockCount = countToolTextBlocks(msg);
    const canRewriteText = textBlockCount === 1;
    const originalText = extractTextContent(msg);
    const toolCallId = (msg as any).toolCallId ?? "";
    const toolRecord = state.toolCalls.get(toolCallId);
    const isErr = !!(msg as any).isError;

    if (!isErr && (isReadResult(toolName) || hasHashlineHeader(originalText))) {
      return msg;
    }

    if (isErr) {
      if (config.strategies.errorPurge.enabled) {
        const errorTurnIndex =
          toolRecord && toolRecord.turnIndex >= 0 && !toolRecord.awaitingAuthoritativeTurn
            ? toolRecord.turnIndex
            : state.currentTurn;
        if (
          shouldPurgeError(
            errorTurnIndex,
            state.currentTurn,
            config.strategies.errorPurge.maxTurnsAgo,
          )
        ) {
          if (!canRewriteText) {
            return msg;
          }

          const candidate = makeErrorTombstone(config.strategies.errorPurge.maxTurnsAgo);
          creditKeptOut(state, toolCallId, "error_purge", approxTokens(originalText.length - candidate.length));
          return replaceSingleToolTextContent(msg, candidate);
        }
      }

      return msg;
    }

    let dedupText = originalText;
    let rewriteText: string | null = null;

    if (config.strategies.shortCircuit.enabled && !isErr) {
      const candidate = shortCircuit(dedupText, isErr, config.strategies.shortCircuit.maxTokens);
      if (candidate !== null) {
        if (canRewriteText) {
          creditKeptOut(state, toolCallId, "short_circuit", approxTokens(dedupText.length - candidate.length));
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
            creditKeptOut(state, toolCallId, "code_filter", approxTokens(dedupText.length - candidate.length));
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
          creditKeptOut(state, toolCallId, "truncation", approxTokens(dedupText.length - candidate.length));
        }
        dedupText = candidate;
        if (canRewriteText) {
          rewriteText = candidate;
        }
      }
    }

    if (config.strategies.deduplication.enabled) {
      const normalizedFingerprint = `${toolName}::${normalizeContent(dedupText)}`;
      const inputFingerprint = typeof toolRecord?.inputFingerprint === "string"
        ? toolRecord.inputFingerprint.trim()
        : "";
      const messageFingerprint = (msg as any).__pcnFingerprint;
      const lacksRebuildProvenance =
        Boolean(toolRecord?.inferredFromContext) && !inputFingerprint && !messageFingerprint;

      if (!lacksRebuildProvenance) {
        const fingerprint =
          messageFingerprint
          ?? (inputFingerprint ? `${normalizedFingerprint}::${inputFingerprint}` : normalizedFingerprint);
        const candidate = fingerprintDedup(
          toolCallId,
          toolName,
          fingerprint,
          seen,
          config.strategies.deduplication.maxOccurrences,
          config.shaping.protectedTools,
        );
        if (candidate !== null) {
          if (canRewriteText) {
            creditKeptOut(state, toolCallId, "dedup", approxTokens(dedupText.length - candidate.length));
            rewriteText = candidate;
          }
        }
      }
    }

    if (rewriteText !== null) {
      return replaceSingleToolTextContent(msg, rewriteText);
    }

    return msg;
  });

  return { messages: processed };
}
