import type { PCNConfig } from "../config.js";
import { codeFilter, detectLanguage } from "./code-filter.js";
import { shortCircuit } from "./short-circuit.js";
import { headTailTruncate } from "./truncation.js";

export function applySafeToolTextShaping(text: string, config: PCNConfig): string | null {
  let next = text;
  let changed = false;

  if (config.strategies.shortCircuit.enabled) {
    const candidate = shortCircuit(next, false, config.strategies.shortCircuit.minTokens);
    if (candidate !== null) {
      next = candidate;
      changed = true;
    }
  }

  if (config.strategies.codeFilter.enabled) {
    const language = detectLanguage(next);
    if (language) {
      const candidate = codeFilter(next, language, config.strategies.codeFilter);
      if (candidate !== null) {
        next = candidate;
        changed = true;
      }
    }
  }

  if (config.strategies.truncation.enabled) {
    const candidate = headTailTruncate(next, config.strategies.truncation);
    if (candidate !== null) {
      next = candidate;
      changed = true;
    }
  }

  return changed ? next : null;
}
