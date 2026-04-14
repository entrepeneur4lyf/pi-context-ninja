import type { ExtensionContext } from "@mariozechner/pi-agent-core";
import type { SessionState, OmitRange } from "../types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const STATE_DIR = path.resolve(process.env.PCN_STATE_DIR ?? path.join(os.homedir(), ".pi-ninja", "state"));

export interface PersistedState {
  omitRanges: OmitRange[];
  currentTurn: number;
  tokensKeptOutTotal: number;
  tokensSaved: number;
  tokensKeptOutByType: Record<string, number>;
  tokensSavedByType: Record<string, number>;
  turnHistory: SessionState["turnHistory"];
  projectPath: string;
}

interface SessionEntryLike {
  id?: string;
  path?: string;
}

interface SessionManagerLike {
  getCurrentEntry?: () => SessionEntryLike | null | undefined;
}

export function resolveSessionId(ctx: ExtensionContext): string {
  const sessionManager = (ctx as ExtensionContext & { sessionManager?: SessionManagerLike }).sessionManager;
  const entry = sessionManager?.getCurrentEntry?.();
  return entry?.id ?? entry?.path ?? "default";
}

export function getStatePath(sessionId: string): string {
  return path.join(STATE_DIR, `${encodeURIComponent(sessionId)}.json`);
}

export function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

export function saveSessionState(sessionId: string, state: SessionState): void {
  ensureStateDir();

  const persisted: PersistedState = {
    omitRanges: state.omitRanges,
    currentTurn: state.currentTurn,
    tokensKeptOutTotal: state.tokensKeptOutTotal,
    tokensSaved: state.tokensSaved,
    tokensKeptOutByType: state.tokensKeptOutByType,
    tokensSavedByType: state.tokensSavedByType,
    turnHistory: state.turnHistory,
    projectPath: state.projectPath,
  };

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

export function loadSessionState(sessionId: string): PersistedState | null {
  const statePath = getStatePath(sessionId);

  try {
    const raw = fs.readFileSync(statePath, "utf8");
    return JSON.parse(raw) as PersistedState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
