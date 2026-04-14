export function fingerprintDedup(
  toolCallId: string,
  toolName: string,
  fingerprint: string,
  seen: Set<string>,
  protectedTools: string[] = ["write", "edit"],
): string | null {
  void toolCallId;

  if (protectedTools.includes(toolName)) {
    return null;
  }

  if (seen.has(fingerprint)) {
    return `[dedup: see latest ${toolName} result]`;
  }

  seen.add(fingerprint);
  return null;
}

export { normalizeContent } from "../normalizer.js";
