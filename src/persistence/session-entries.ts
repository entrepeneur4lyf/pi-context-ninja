import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { PersistedSessionState, SessionState } from "../types.js";
import { normalizePersistedSessionState, serializeSessionState } from "../state.js";

/**
 * Session state travels with the host session as a custom entry, so a
 * branch, fork, or resume carries PCN's bookkeeping with the
 * conversation (01-host-integration.md HOST-040 to HOST-042).
 */
export const SESSION_STATE_ENTRY_TYPE = "com.pcn.session-state";

type EntryAppender = Pick<ExtensionAPI, "appendEntry">;

/** Appends the current state. A host without `appendEntry` is tolerated (PCN-002). */
export function appendSessionState(pi: EntryAppender, state: SessionState): void {
  if (typeof pi.appendEntry !== "function") {
    return;
  }
  pi.appendEntry(SESSION_STATE_ENTRY_TYPE, serializeSessionState(state));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Returns the state carried by the newest PCN entry on the branch, or null
 * when there is none or its data fails validation.
 */
export function readSessionStateFromBranch(entries: readonly unknown[]): PersistedSessionState | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SESSION_STATE_ENTRY_TYPE) {
      continue;
    }
    return normalizePersistedSessionState(entry.data);
  }
  return null;
}
