import type { TruncationConfig } from "../config.js";

export function headTailTruncate(
  text: string,
  cfg: TruncationConfig,
): string | null {
  const lines = text.split("\n");
  if (lines.length < cfg.minLines) {
    return null;
  }
  const head = lines.slice(0, cfg.headLines);
  const tail = lines.slice(-cfg.tailLines);
  const omitted = lines.length - cfg.headLines - cfg.tailLines;
  return [...head, `[--- ${omitted} lines omitted ---]`, ...tail].join("\n");
}
