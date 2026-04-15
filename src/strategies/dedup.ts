export function fingerprintDedup(
  toolCallId: string,
  toolName: string,
  fingerprint: string,
  seen: Map<string, number>,
  maxOccurrences = 1,
  protectedTools: string[] = ["write", "edit"],
): string | null {
  void toolCallId;

  if (protectedTools.includes(toolName)) {
    return null;
  }

  const limit = Math.max(1, maxOccurrences);
  const nextCount = (seen.get(fingerprint) ?? 0) + 1;
  seen.set(fingerprint, nextCount);

  if (nextCount > limit) {
    return `[dedup: see earlier ${toolName} result x${limit}]`;
  }

  return null;
}

export { normalizeContent } from "../normalizer.js";
