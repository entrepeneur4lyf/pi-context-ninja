import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAnalyticsStore } from "../src/analytics/store.js";

describe("analytics store", () => {
  it("persists turn snapshots with exact context usage and approximate savings", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-analytics-"));
    const dbPath = path.join(tmpDir, "analytics.sqlite");
    const timestamp = Date.now();

    try {
      const store = createAnalyticsStore({ dbPath, retentionDays: 30 });

      const firstSnapshot = store.recordTurn({
        sessionId: "session-a",
        projectPath: "/tmp/project",
        turnIndex: 3,
        toolCount: 2,
        messageCountAfterTurn: 7,
        timestamp,
        contextTokens: 420,
        contextPercent: 0.42,
        contextWindow: 1000,
        tokensSavedApprox: 88,
        tokensKeptOutApprox: 144,
      });

      expect(firstSnapshot.totalTurns).toBe(1);
      expect(firstSnapshot.totals.tokensSavedApprox).toBe(88);
      expect(firstSnapshot.totals.tokensKeptOutApprox).toBe(144);
      expect(firstSnapshot.context.tokens).toBe(420);
      expect(firstSnapshot.context.percent).toBe(0.42);
      expect(firstSnapshot.context.window).toBe(1000);
      expect(firstSnapshot.latestTurn).toMatchObject({
        sessionId: "session-a",
        turnIndex: 3,
        toolCount: 2,
        messageCountAfterTurn: 7,
        contextTokens: 420,
        contextPercent: 0.42,
        contextWindow: 1000,
        tokensSavedApprox: 88,
        tokensKeptOutApprox: 144,
      });

      store.close();

      const reopened = createAnalyticsStore({ dbPath, retentionDays: 30 });
      const snapshot = reopened.getSnapshot("session-a");

      expect(snapshot.totalTurns).toBe(1);
      expect(snapshot.latestTurn).toMatchObject({
        sessionId: "session-a",
        turnIndex: 3,
        contextTokens: 420,
        contextPercent: 0.42,
        contextWindow: 1000,
      });
      expect(snapshot.recentTurns).toHaveLength(1);
      expect(snapshot.recentTurns[0]).toMatchObject({
        sessionId: "session-a",
        tokensSavedApprox: 88,
        tokensKeptOutApprox: 144,
      });

      reopened.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns snapshots scoped to the requested session", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-analytics-"));
    const dbPath = path.join(tmpDir, "analytics.sqlite");
    const timestamp = Date.now();

    try {
      const store = createAnalyticsStore({ dbPath, retentionDays: 30 });

      store.recordTurn({
        sessionId: "session-a",
        projectPath: "/tmp/project-a",
        turnIndex: 1,
        toolCount: 1,
        messageCountAfterTurn: 3,
        timestamp,
        contextTokens: 100,
        contextPercent: 0.1,
        contextWindow: 1000,
        tokensSavedApprox: 10,
        tokensKeptOutApprox: 20,
      });

      store.recordTurn({
        sessionId: "session-b",
        projectPath: "/tmp/project-b",
        turnIndex: 1,
        toolCount: 1,
        messageCountAfterTurn: 2,
        timestamp: timestamp + 1,
        contextTokens: 300,
        contextPercent: 0.3,
        contextWindow: 1000,
        tokensSavedApprox: 30,
        tokensKeptOutApprox: 40,
      });

      const snapshot = store.getSnapshot("session-a");

      expect(snapshot.sessionId).toBe("session-a");
      expect(snapshot.projectPath).toBe("/tmp/project-a");
      expect(snapshot.totalTurns).toBe(1);
      expect(snapshot.context.tokens).toBe(100);
      expect(snapshot.totals.tokensSavedApprox).toBe(10);
      expect(snapshot.totals.tokensKeptOutApprox).toBe(20);
      expect(snapshot.recentTurns).toHaveLength(1);
      expect(snapshot.recentTurns[0]).toMatchObject({
        sessionId: "session-a",
        projectPath: "/tmp/project-a",
        contextTokens: 100,
      });

      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
