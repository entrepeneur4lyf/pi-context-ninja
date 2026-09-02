import { describe, expect, it } from "bun:test";
import type { DashboardSnapshot } from "../src/analytics/types";
import {
  APPROXIMATION_NOTE,
  formatPercent,
  formatTokens,
  plainPaint,
  renderOverlayLines,
  renderStatusText,
  type OverlayModel,
  type Paint,
} from "../src/dashboard/render";

const EVENT_TIMESTAMP = Date.parse("2026-09-01T12:03:45");

function localTime(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function snapshotFixture(): DashboardSnapshot {
  return {
    generatedAt: 0,
    sessionId: "session-1",
    projectPath: "/tmp/project",
    context: { tokens: 420, percent: 42, window: 1000 },
    scopes: {
      session: { scope: "session", tokensSavedApprox: 12_345, tokensKeptOutApprox: 12_345, turnCount: 3 },
      project: { scope: "project", tokensSavedApprox: 45_600, tokensKeptOutApprox: 45_600, turnCount: 9 },
      lifetime: { scope: "lifetime", tokensSavedApprox: 1_200_000, tokensKeptOutApprox: 1_200_000, turnCount: 90 },
    },
    live: { turnCount: 3, toolCallCount: 7 },
    strategyTotals: { short_circuit: 3000, error_purge: 8100 },
    recentImpactEvents: [
      {
        timestamp: EVENT_TIMESTAMP,
        sessionId: "session-1",
        projectPath: "/tmp/project",
        source: "runtime.materialize",
        toolName: "bash",
        strategy: "short_circuit",
        tokensSavedApprox: 1200,
        tokensKeptOutApprox: 1200,
        contextPercent: 42,
        summary: "Shortened oversized bash output",
      },
    ],
  };
}

function model(overrides: Partial<OverlayModel> = {}): OverlayModel {
  return { snapshot: snapshotFixture(), degradedReason: null, ...overrides };
}

describe("formatting", () => {
  it("formats token counts in k and M units", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });

  it("formats percent as a rounded whole number or n/a", () => {
    expect(formatPercent(null)).toBe("n/a");
    expect(formatPercent(42.4)).toBe("42%");
    expect(formatPercent(Number.NaN)).toBe("n/a");
  });

  it("renders the status-line text with the session's kept-out tokens", () => {
    expect(renderStatusText(12_345)).toBe("pcn 12.3k kept out");
    expect(renderStatusText(0)).toBe("pcn 0 kept out");
  });
});

describe("renderOverlayLines", () => {
  it("renders context usage, scope totals, strategy totals, and recent impact events", () => {
    const lines = renderOverlayLines(model(), 80);

    expect(lines[0]).toStartWith(" PCN dashboard ");
    expect(lines[0]).toEndWith(" esc closes");
    expect(lines).toContain("Context     42% of 1k (420 tokens)");
    expect(lines).toContain("Kept out    session 12.3k   project 45.6k   lifetime 1.2M");
    expect(lines).toContain(APPROXIMATION_NOTE);
    expect(lines).toContain("Strategies");

    const errorPurge = lines.findIndex((line) => line.startsWith("  error_purge"));
    const shortCircuit = lines.findIndex((line) => line.startsWith("  short_circuit"));
    expect(errorPurge).toBeGreaterThan(-1);
    expect(shortCircuit).toBeGreaterThan(errorPurge);
    expect(lines[errorPurge]).toMatch(/^ {2}error_purge\s+8\.1k {2}█+$/);
    expect(lines[shortCircuit]).toMatch(/^ {2}short_circuit\s+3k {2}█+$/);
    expect(lines[errorPurge].length).toBeGreaterThan(lines[shortCircuit].length);

    const recent = lines.indexOf("Recent");
    expect(recent).toBeGreaterThan(shortCircuit);
    const event = lines[recent + 1];
    expect(event).toContain(localTime(EVENT_TIMESTAMP));
    expect(event).toContain("short_circuit");
    expect(event).toContain("bash");
    expect(event).toContain("1.2k");
    expect(event).toContain("Shortened oversized bash output");
  });

  it("keeps every rendered line within the width", () => {
    for (const width of [30, 60, 120]) {
      const lines = renderOverlayLines(model(), width);
      expect(lines.length).toBeGreaterThan(5);
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
      expect(lines[0].length).toBe(width);
    }
  });

  it("shows the degraded reason and live counters only when analytics is unavailable", () => {
    const degraded = model({ degradedReason: "database is locked" });
    degraded.snapshot.recentImpactEvents = [];
    const lines = renderOverlayLines(degraded, 100);

    expect(lines).toContain("Analytics unavailable: database is locked. Live session counters only.");
    expect(lines).toContain("Kept out    session 12.3k   project n/a   lifetime n/a");
    expect(lines).toContain("  (no impact events; analytics unavailable)");
  });

  it("renders placeholders when there are no strategies or events", () => {
    const empty = model();
    empty.snapshot.strategyTotals = {};
    empty.snapshot.recentImpactEvents = [];
    empty.snapshot.context = { tokens: null, percent: null, window: null };
    const lines = renderOverlayLines(empty, 80);

    expect(lines).toContain("Context     n/a");
    expect(lines).toContain("  (none yet)");
    expect(lines).toContain("  (no impact events yet)");
  });

  it("paints segments through the painter after truncation", () => {
    const paint: Paint = (role, text) => `<${role}>${text}</${role}>`;
    const lines = renderOverlayLines(model(), 100, paint);

    expect(lines[0]).toContain("<accent> PCN dashboard </accent>");
    expect(lines[0]).toContain("<dim> esc closes</dim>");
    expect(lines).toContain(`<dim>${APPROXIMATION_NOTE}</dim>`);
    expect(renderOverlayLines(model(), 100, plainPaint)[0]).not.toContain("<accent>");

    const narrow = renderOverlayLines(model(), 20, paint);
    expect(narrow).toContain(`<dim>${APPROXIMATION_NOTE.slice(0, 20)}</dim>`);
  });

  it("caps the recent list at ten events, newest first as given", () => {
    const many = model();
    many.snapshot.recentImpactEvents = Array.from({ length: 15 }, (_, index) => ({
      ...snapshotFixture().recentImpactEvents[0],
      summary: `event ${index}`,
    }));
    const lines = renderOverlayLines(many, 120);
    const eventLines = lines.filter((line) => line.includes("event "));

    expect(eventLines).toHaveLength(10);
    expect(eventLines[0]).toContain("event 0");
    expect(eventLines[9]).toContain("event 9");
  });
});
