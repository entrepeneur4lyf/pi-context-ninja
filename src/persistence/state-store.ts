import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PersistedSessionState, SessionState } from "../types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { normalizePersistedSessionState, serializeSessionState } from "../state.js";

export function getStateDir(): string {
  return path.resolve(process.env.PCN_STATE_DIR ?? path.join(os.homedir(), ".pi-ninja", "state"));
}

export function resolveSessionId(ctx: Pick<ExtensionContext, "sessionManager">): string {
  return ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager.getSessionFile?.() ?? "default";
}

export function getStatePath(sessionId: string): string {
  return path.join(getStateDir(), `${encodeURIComponent(sessionId)}.json`);
}

export function ensureStateDir(): void {
  fs.mkdirSync(getStateDir(), { recursive: true });
}

export function saveSessionState(sessionId: string, state: SessionState): void {
  ensureStateDir();

  const persisted: PersistedSessionState = serializeSessionState(state);

  const statePath = getStatePath(sessionId);
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(persisted, null, 2);

  try {
    fs.writeFileSync(tmpPath, payload, "utf8");
    fs.renameSync(tmpPath, statePath);
  } catch (error) {
    if (fs.existsSync(tmpPath)) {
      fs.rmSync(tmpPath, { force: true });
    }
    throw error;
  }
}

export function loadSessionState(sessionId: string): PersistedSessionState | null {
  const statePath = getStatePath(sessionId);

  try {
    const raw = fs.readFileSync(statePath, "utf8");
    return normalizePersistedSessionState(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
