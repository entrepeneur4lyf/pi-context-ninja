import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSessionState } from "../src/state";

let stateDir = "";

async function loadStateStore() {
  vi.resetModules();
  return import("../src/persistence/state-store");
}

function cleanupStateDir() {
  if (stateDir) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("state store", () => {
  beforeEach(() => {
    cleanupStateDir();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-state-store-"));
    process.env.PCN_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.PCN_STATE_DIR;
    cleanupStateDir();
    stateDir = "";
  });

  it("saves and loads persisted session state", async () => {
    const { saveSessionState, loadSessionState } = await loadStateStore();
    const s = createSessionState("/tmp");
    s.currentTurn = 5;
    s.tokensKeptOutTotal = 1000;

    saveSessionState("s1", s);
    const loaded = loadSessionState("s1");

    expect(loaded).not.toBeNull();
    expect(loaded?.currentTurn).toBe(5);
    expect(loaded?.tokensKeptOutTotal).toBe(1000);
  });

  it("returns null when the state file is missing", async () => {
    const { loadSessionState } = await loadStateStore();

    expect(loadSessionState("missing")).toBeNull();
  });

  it("writes atomically without leaving a tmp file behind", async () => {
    const { saveSessionState, getStatePath } = await loadStateStore();
    const s = createSessionState("/tmp");

    saveSessionState("s1", s);

    const statePath = getStatePath("s1");
    expect(fs.existsSync(statePath)).toBe(true);
    expect(path.extname(statePath)).toBe(".json");
    expect(fs.readdirSync(stateDir).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });
});
