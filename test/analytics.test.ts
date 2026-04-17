import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAnalyticsStore } from "../src/analytics/store.js";

describe("analytics store", () => {
  it("returns the planned dashboard snapshot contract from recordTurn without synthetic impact events", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-analytics-"));
    const dbPath = path.join(tmpDir, "analytics.sqlite");
    const timestamp = Date.now();

    try {
      const store = createAnalyticsStore({ dbPath, retentionDays: 30 });

      const snapshot = store.recordTurn({
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

      expect(snapshot).toMatchObject({
        generatedAt: expect.any(Number),
        sessionId: "session-a",
        projectPath: "/tmp/project",
        context: {
          tokens: 420,
          percent: 0.42,
          window: 1000,
        },
        scopes: {
          session: {
            scope: "session",
            tokensSavedApprox: 88,
            tokensKeptOutApprox: 144,
            turnCount: 1,
          },
          project: {
            scope: "project",
            tokensSavedApprox: 88,
            tokensKeptOutApprox: 144,
            turnCount: 1,
          },
          lifetime: {
            scope: "lifetime",
            tokensSavedApprox: 88,
            tokensKeptOutApprox: 144,
            turnCount: 1,
          },
        },
        strategyTotals: {},
      });
      expect(snapshot.recentImpactEvents).toEqual([]);

      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("persists only nonzero impact events and exposes session-scoped strategy totals", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-analytics-"));
    const dbPath = path.join(tmpDir, "analytics.sqlite");
    const timestamp = Date.now();

    try {
      const store = createAnalyticsStore({ dbPath, retentionDays: 30 });

      store.recordTurn({
        sessionId: "session-impact",
        projectPath: "/tmp/project-impact",
        turnIndex: 1,
        toolCount: 2,
        messageCountAfterTurn: 5,
        timestamp,
        contextTokens: 420,
        contextPercent: 0.42,
        contextWindow: 1000,
        tokensSavedApprox: 13,
        tokensKeptOutApprox: 31,
        impactEvents: [
          {
            timestamp,
            sessionId: "session-impact",
            projectPath: "/tmp/project-impact",
            source: "runtime.materialize",
            toolName: "read",
            strategy: "short_circuit",
            tokensSavedApprox: 8,
            tokensKeptOutApprox: 16,
            contextPercent: 0.42,
            summary: "short_circuit on read kept a known-success payload out of context",
          },
          {
            timestamp: timestamp + 1,
            sessionId: "session-impact",
            projectPath: "/tmp/project-impact",
            source: "runtime.materialize",
            toolName: "read",
            strategy: "dedup",
            tokensSavedApprox: 5,
            tokensKeptOutApprox: 15,
            contextPercent: 0.42,
            summary: "dedup on read collapsed repeated output",
          },
          {
            timestamp: timestamp + 2,
            sessionId: "session-impact",
            projectPath: "/tmp/project-impact",
            source: "runtime.materialize",
            toolName: "read",
            strategy: "truncation",
            tokensSavedApprox: 0,
            tokensKeptOutApprox: 0,
            contextPercent: 0.42,
            summary: "zero effect should not persist",
          },
        ],
      });

      const snapshot = store.getDashboardSnapshot("session-impact", "/tmp/project-impact");

      expect(snapshot.strategyTotals).toEqual({
        short_circuit: 8,
        dedup: 5,
      });
      expect(snapshot.recentImpactEvents).toEqual([
        expect.objectContaining({
          strategy: "dedup",
          tokensSavedApprox: 5,
          tokensKeptOutApprox: 15,
          summary: "dedup on read collapsed repeated output",
        }),
        expect.objectContaining({
          strategy: "short_circuit",
          tokensSavedApprox: 8,
          tokensKeptOutApprox: 16,
          summary: "short_circuit on read kept a known-success payload out of context",
        }),
      ]);

      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves context percent without double scaling in persisted dashboard impact events", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-analytics-"));
    const dbPath = path.join(tmpDir, "analytics.sqlite");
    const timestamp = Date.now();

    try {
      const store = createAnalyticsStore({ dbPath, retentionDays: 30 });

      const snapshot = store.recordTurn({
        sessionId: "session-percent",
        projectPath: "/tmp/project-percent",
        turnIndex: 7,
        toolCount: 1,
        messageCountAfterTurn: 4,
        timestamp,
        contextTokens: 375,
        contextPercent: 0.375,
        contextWindow: 1000,
        tokensSavedApprox: 12,
        tokensKeptOutApprox: 24,
        impactEvents: [
          {
            timestamp,
            sessionId: "session-percent",
            projectPath: "/tmp/project-percent",
            source: "runtime.materialize",
            toolName: "read",
            strategy: "short_circuit",
            tokensSavedApprox: 12,
            tokensKeptOutApprox: 24,
            contextPercent: 0.375,
            summary: "short_circuit on read preserved percent",
          },
        ],
      });

      expect(snapshot.context.percent).toBe(0.375);
      expect(snapshot.recentImpactEvents[0].contextPercent).toBe(0.375);

      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps authoritative strategy totals after pruning old impact-event history", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-analytics-"));
    const dbPath = path.join(tmpDir, "analytics.sqlite");
    const now = vi.spyOn(Date, "now");
    const oneDayMs = 24 * 60 * 60 * 1000;

    try {
      const store = createAnalyticsStore({ dbPath, retentionDays: 1 });

      now.mockImplementation(() => 1_000);
      store.recordTurn({
        sessionId: "session-retention",
        projectPath: "/tmp/project-retention",
        turnIndex: 1,
        toolCount: 1,
        messageCountAfterTurn: 3,
        timestamp: 1_000,
        contextTokens: 100,
        contextPercent: 0.1,
        contextWindow: 1000,
        tokensSavedApprox: 8,
        tokensKeptOutApprox: 16,
        impactEvents: [
          {
            timestamp: 1_000,
            sessionId: "session-retention",
            projectPath: "/tmp/project-retention",
            source: "runtime.materialize",
            toolName: "read",
            strategy: "short_circuit",
            tokensSavedApprox: 8,
            tokensKeptOutApprox: 16,
            contextPercent: 0.1,
            summary: "first turn impact",
          },
        ],
      });

      now.mockImplementation(() => (2 * oneDayMs) + 1_000);
      const snapshot = store.recordTurn({
        sessionId: "session-retention",
        projectPath: "/tmp/project-retention",
        turnIndex: 2,
        toolCount: 0,
        messageCountAfterTurn: 4,
        timestamp: 2 * oneDayMs,
        contextTokens: 120,
        contextPercent: 0.12,
        contextWindow: 1000,
        tokensSavedApprox: 8,
        tokensKeptOutApprox: 16,
        impactEvents: [],
      });

      expect(snapshot.recentImpactEvents).toEqual([]);
      expect(snapshot.strategyTotals).toEqual({
        short_circuit: 8,
      });

      store.close();
    } finally {
      now.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exposes distinct session, project, and lifetime scopes from getDashboardSnapshot", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-analytics-"));
    const dbPath = path.join(tmpDir, "analytics.sqlite");
    const timestamp = Date.now();

    try {
      const store = createAnalyticsStore({ dbPath, retentionDays: 30 });

      store.recordTurn({
        sessionId: "session-a",
        projectPath: "/tmp/project-alpha",
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
        sessionId: "session-a",
        projectPath: "/tmp/project-alpha",
        turnIndex: 2,
        toolCount: 2,
        messageCountAfterTurn: 5,
        timestamp: timestamp + 1,
        contextTokens: 120,
        contextPercent: 0.12,
        contextWindow: 1000,
        tokensSavedApprox: 5,
        tokensKeptOutApprox: 15,
      });

      store.recordTurn({
        sessionId: "session-b",
        projectPath: "/tmp/project-alpha",
        turnIndex: 1,
        toolCount: 1,
        messageCountAfterTurn: 2,
        timestamp: timestamp + 2,
        contextTokens: 200,
        contextPercent: 0.2,
        contextWindow: 1000,
        tokensSavedApprox: 30,
        tokensKeptOutApprox: 40,
      });

      store.recordTurn({
        sessionId: "session-c",
        projectPath: "/tmp/project-beta",
        turnIndex: 1,
        toolCount: 1,
        messageCountAfterTurn: 2,
        timestamp: timestamp + 3,
        contextTokens: 300,
        contextPercent: 0.3,
        contextWindow: 1000,
        tokensSavedApprox: 50,
        tokensKeptOutApprox: 60,
      });

      const snapshot = store.getDashboardSnapshot("session-a", "/tmp/project-alpha");

      expect(snapshot.sessionId).toBe("session-a");
      expect(snapshot.projectPath).toBe("/tmp/project-alpha");
      expect(snapshot.scopes).toEqual({
        session: {
          scope: "session",
          tokensSavedApprox: 15,
          tokensKeptOutApprox: 35,
          turnCount: 2,
        },
        project: {
          scope: "project",
          tokensSavedApprox: 45,
          tokensKeptOutApprox: 75,
          turnCount: 3,
        },
        lifetime: {
          scope: "lifetime",
          tokensSavedApprox: 95,
          tokensKeptOutApprox: 135,
          turnCount: 4,
        },
      });
      expect(snapshot.strategyTotals).toEqual({});
      expect(snapshot.recentImpactEvents).toEqual([]);

      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses one resolved project path for both top-level projectPath and project scope totals", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-analytics-"));
    const dbPath = path.join(tmpDir, "analytics.sqlite");
    const timestamp = Date.now();

    try {
      const store = createAnalyticsStore({ dbPath, retentionDays: 30 });

      store.recordTurn({
        sessionId: "session-switch",
        projectPath: "/tmp/project-old",
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
        sessionId: "session-switch",
        projectPath: "/tmp/project-new",
        turnIndex: 2,
        toolCount: 1,
        messageCountAfterTurn: 4,
        timestamp: timestamp + 1,
        contextTokens: 200,
        contextPercent: 0.2,
        contextWindow: 1000,
        tokensSavedApprox: 5,
        tokensKeptOutApprox: 15,
      });

      const snapshot = store.getDashboardSnapshot("session-switch", "/tmp/project-old");

      expect(snapshot.projectPath).toBe("/tmp/project-new");
      expect(snapshot.scopes.project).toEqual({
        scope: "project",
        tokensSavedApprox: 5,
        tokensKeptOutApprox: 15,
        turnCount: 1,
      });

      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns an empty dashboard snapshot with the requested project path when no rows exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-analytics-"));
    const dbPath = path.join(tmpDir, "analytics.sqlite");

    try {
      const store = createAnalyticsStore({ dbPath, retentionDays: 30 });

      const snapshot = store.getDashboardSnapshot("session-empty", "/tmp/project-empty");

      expect(snapshot).toMatchObject({
        generatedAt: expect.any(Number),
        sessionId: "session-empty",
        projectPath: "/tmp/project-empty",
        context: {
          tokens: null,
          percent: null,
          window: null,
        },
        scopes: {
          session: {
            scope: "session",
            tokensSavedApprox: 0,
            tokensKeptOutApprox: 0,
            turnCount: 0,
          },
          project: {
            scope: "project",
            tokensSavedApprox: 0,
            tokensKeptOutApprox: 0,
            turnCount: 0,
          },
          lifetime: {
            scope: "lifetime",
            tokensSavedApprox: 0,
            tokensKeptOutApprox: 0,
            turnCount: 0,
          },
        },
        strategyTotals: {},
        recentImpactEvents: [],
      });

      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps getSnapshot as a compatibility alias for the legacy session snapshot", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-analytics-"));
    const dbPath = path.join(tmpDir, "analytics.sqlite");
    const timestamp = Date.now();

    try {
      const store = createAnalyticsStore({ dbPath, retentionDays: 30 });

      store.recordTurn({
        sessionId: "session-compat",
        projectPath: "/tmp/project-compat",
        turnIndex: 4,
        toolCount: 1,
        messageCountAfterTurn: 3,
        timestamp,
        contextTokens: 100,
        contextPercent: 0.1,
        contextWindow: 1000,
        tokensSavedApprox: 10,
        tokensKeptOutApprox: 20,
      });

      const snapshot = store.getSnapshot("session-compat");

      expect(snapshot).toMatchObject({
        sessionId: "session-compat",
        projectPath: "/tmp/project-compat",
        totalTurns: 1,
        totals: {
          tokensSavedApprox: 10,
          tokensKeptOutApprox: 20,
        },
        context: {
          tokens: 100,
          percent: 0.1,
          window: 1000,
        },
        latestTurn: {
          sessionId: "session-compat",
          projectPath: "/tmp/project-compat",
          turnIndex: 4,
          contextTokens: 100,
          contextPercent: 0.1,
          contextWindow: 1000,
          tokensSavedApprox: 10,
          tokensKeptOutApprox: 20,
        },
      });

      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
