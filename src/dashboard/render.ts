import type { DashboardImpactEvent, DashboardSnapshot } from "../analytics/types.js";

/**
 * Pure rendering for the two dashboard surfaces
 * (04-analytics-and-dashboard.md DASH-020, DASH-031). Lines are built as
 * plain segments, truncated to the width, and painted last, so the
 * visible width never depends on the host's ANSI-aware helpers.
 */

export type PaintRole = "accent" | "dim" | "muted" | "warning" | "success";
export type Paint = (role: PaintRole, text: string) => string;

export const plainPaint: Paint = (_role, text) => text;

export interface OverlayModel {
  snapshot: DashboardSnapshot;
  /** Why analytics data is missing; null when the snapshot came from the store. */
  degradedReason: string | null;
}

export const APPROXIMATION_NOTE = "Figures are approximate (chars/4) until the host tokenizer lands.";

const HEADER_LABEL = " PCN dashboard ";
const HEADER_HINT = " esc closes";
const LABEL_WIDTH = 12;
const MAX_BAR_WIDTH = 20;
const MAX_RECENT_EVENTS = 10;
const STRATEGY_INDENT = "  ";

type Segment = [PaintRole | null, string];

export function formatTokens(value: number): string {
  const tokens = Number.isFinite(value) && value > 0 ? value : 0;
  if (tokens < 1000) {
    return String(Math.round(tokens));
  }
  if (tokens < 999_950) {
    return `${trimZero((tokens / 1000).toFixed(1))}k`;
  }
  return `${trimZero((tokens / 1_000_000).toFixed(1))}M`;
}

function trimZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

export function formatPercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) {
    return "n/a";
  }
  return `${Math.round(percent)}%`;
}

export function renderStatusText(sessionKeptOut: number): string {
  return `pcn ${formatTokens(sessionKeptOut)} kept out`;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function paintLine(segments: Segment[], width: number, paint: Paint): string {
  let remaining = Math.max(0, width);
  let line = "";
  for (const [role, text] of segments) {
    if (remaining <= 0) {
      break;
    }
    const slice = text.length > remaining ? text.slice(0, remaining) : text;
    remaining -= slice.length;
    line += role === null ? slice : paint(role, slice);
  }
  return line;
}

function renderHeader(width: number): Segment[] {
  const fill = Math.max(0, width - HEADER_LABEL.length - HEADER_HINT.length);
  return [
    ["accent", HEADER_LABEL],
    ["dim", "─".repeat(fill)],
    ["dim", HEADER_HINT],
  ];
}

function renderContext(snapshot: DashboardSnapshot): string {
  const { percent, window, tokens } = snapshot.context;
  const parts: string[] = [];
  if (percent !== null && Number.isFinite(percent)) {
    parts.push(formatPercent(percent));
  }
  if (window !== null && Number.isFinite(window)) {
    parts.push(`of ${formatTokens(window)}`);
  }
  if (tokens !== null && Number.isFinite(tokens)) {
    parts.push(`(${formatTokens(tokens)} tokens)`);
  }
  return parts.length === 0 ? "n/a" : parts.join(" ");
}

function renderScopes(model: OverlayModel): string {
  const { session, project, lifetime } = model.snapshot.scopes;
  const known = model.degradedReason === null;
  const projectText = known ? formatTokens(project.tokensKeptOutApprox) : "n/a";
  const lifetimeText = known ? formatTokens(lifetime.tokensKeptOutApprox) : "n/a";
  return `session ${formatTokens(session.tokensKeptOutApprox)}   project ${projectText}   lifetime ${lifetimeText}`;
}

function renderStrategies(snapshot: DashboardSnapshot, width: number): Segment[][] {
  const entries = Object.entries(snapshot.strategyTotals)
    .filter(([, tokens]) => Number.isFinite(tokens) && tokens > 0)
    .sort(([, a], [, b]) => b - a);
  if (entries.length === 0) {
    return [[["dim", `${STRATEGY_INDENT}(none yet)`]]];
  }

  const nameWidth = Math.max(8, ...entries.map(([name]) => name.length));
  const max = entries[0][1];
  const barWidth = Math.min(MAX_BAR_WIDTH, Math.max(0, width - (STRATEGY_INDENT.length + nameWidth + 2 + 6 + 2)));

  return entries.map(([name, tokens]) => {
    const cells = barWidth > 0 ? Math.max(1, Math.round((tokens / max) * barWidth)) : 0;
    return [
      [null, `${STRATEGY_INDENT}${name.padEnd(nameWidth)}  ${formatTokens(tokens).padStart(6)}  `],
      ["success", "█".repeat(cells)],
    ];
  });
}

function renderEvent(event: DashboardImpactEvent): Segment[] {
  return [
    ["dim", `  ${formatTime(event.timestamp)}  `],
    ["accent", event.strategy.padEnd(14)],
    [null, ` ${(event.toolName ?? "-").padEnd(12)} `],
    [null, formatTokens(event.tokensKeptOutApprox).padStart(6)],
    ["muted", `  ${event.summary}`],
  ];
}

function renderRecent(model: OverlayModel): Segment[][] {
  const events = model.snapshot.recentImpactEvents.slice(0, MAX_RECENT_EVENTS);
  if (events.length === 0) {
    const placeholder = model.degradedReason === null
      ? "  (no impact events yet)"
      : "  (no impact events; analytics unavailable)";
    return [[["dim", placeholder]]];
  }
  return events.map(renderEvent);
}

export function renderOverlayLines(model: OverlayModel, width: number, paint: Paint = plainPaint): string[] {
  const rows: Segment[][] = [renderHeader(width)];

  if (model.degradedReason !== null) {
    rows.push([["warning", `Analytics unavailable: ${model.degradedReason}. Live session counters only.`]]);
  }

  rows.push([[null, "Context".padEnd(LABEL_WIDTH)], [null, renderContext(model.snapshot)]]);
  rows.push([[null, "Kept out".padEnd(LABEL_WIDTH)], [null, renderScopes(model)]]);
  rows.push([["dim", APPROXIMATION_NOTE]]);
  rows.push([]);
  rows.push([["accent", "Strategies"]]);
  rows.push(...renderStrategies(model.snapshot, width));
  rows.push([["accent", "Recent"]]);
  rows.push(...renderRecent(model));

  return rows.map((segments) => paintLine(segments, width, paint));
}
