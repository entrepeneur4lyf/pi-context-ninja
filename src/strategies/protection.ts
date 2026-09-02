import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { PCNConfig } from "../config.js";

/**
 * Results PCN never rewrites (02-shaping.md SHAPE-010 to SHAPE-012,
 * 01-host-integration.md HOST-070).
 */

/** The host's `read` tool. Its output carries the anchors the next `edit` needs. */
export function isReadResult(toolName: string): boolean {
  return toolName === "read";
}

/** A hashline section header on its own line: `[PATH#HASH]`. */
const HASHLINE_HEADER = /^\[[^\]\n]+#[0-9a-f]+\]$/m;

export function hasHashlineHeader(text: string): boolean {
  return HASHLINE_HEADER.test(text);
}

export function isProtectedTool(toolName: string, config: PCNConfig): boolean {
  return config.shaping.protectedTools.includes(toolName);
}

/** The host stamps `prunedAt` on a result it has already replaced with a notice. */
export function isHostPruned(message: AgentMessage): boolean {
  return typeof (message as { prunedAt?: unknown }).prunedAt === "number";
}
