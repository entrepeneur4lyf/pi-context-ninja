import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  AnalyticsStore,
  AnalyticsStoreOptions,
  AnalyticsTurnRecord,
  AnalyticsTurnWrite,
  DashboardImpactEvent,
  DashboardSnapshot,
  LegacyAnalyticsSnapshot,
  AnalyticsTotals,
  AnalyticsScopeSummary,
  StrategyImpactTotals,
} from "./types.js";

interface AnalyticsRow {
  session_id: string;
  project_path: string;
  turn_index: number;
  tool_count: number;
  message_count_after_turn: number;
  timestamp: number;
  context_tokens: number | null;
  context_percent: number | null;
  context_window: number | null;
  tokens_saved_approx: number;
  tokens_kept_out_approx: number;
}

interface ImpactEventRow {
  session_id: string;
  project_path: string;
  timestamp: number;
  source: string;
  tool_name: string | null;
  strategy: string;
  tokens_saved_approx: number;
  tokens_kept_out_approx: number;
  context_percent: number | null;
  summary: string;
}

interface StrategyImpactTotalsRow {
  strategy: string;
  tokensSavedApprox: number;
  tokensKeptOutApprox: number;
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS turn_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    tool_count INTEGER NOT NULL,
    message_count_after_turn INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    context_tokens INTEGER,
    context_percent REAL,
    context_window INTEGER,
    tokens_saved_approx INTEGER NOT NULL,
    tokens_kept_out_approx INTEGER NOT NULL
  );
`;

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS turn_metrics_session_turn_idx
  ON turn_metrics(session_id, turn_index, timestamp);
`;

const CREATE_IMPACT_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS impact_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    source TEXT NOT NULL,
    tool_name TEXT,
    strategy TEXT NOT NULL,
    tokens_saved_approx INTEGER NOT NULL,
    tokens_kept_out_approx INTEGER NOT NULL,
    context_percent REAL,
    summary TEXT NOT NULL
  );
`;

const CREATE_IMPACT_EVENTS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS impact_events_session_timestamp_idx
  ON impact_events(session_id, timestamp, id);
`;

const CREATE_STRATEGY_TOTALS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS strategy_totals (
    session_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    tokens_saved_approx INTEGER NOT NULL,
    tokens_kept_out_approx INTEGER NOT NULL,
    PRIMARY KEY (session_id, strategy)
  );
`;

function toTurnRecord(row: AnalyticsRow): AnalyticsTurnRecord {
  return {
    sessionId: row.session_id,
    projectPath: row.project_path,
    turnIndex: row.turn_index,
    toolCount: row.tool_count,
    messageCountAfterTurn: row.message_count_after_turn,
    timestamp: row.timestamp,
    contextTokens: row.context_tokens,
    contextPercent: row.context_percent,
    contextWindow: row.context_window,
    tokensSavedApprox: row.tokens_saved_approx,
    tokensKeptOutApprox: row.tokens_kept_out_approx,
  };
}

function buildSnapshot(
  rows: AnalyticsRow[],
  sessionId: string,
): LegacyAnalyticsSnapshot {
  const recentTurns = rows.map(toTurnRecord);
  const latestTurn = recentTurns[0] ?? null;
  const totals: AnalyticsTotals = recentTurns.reduce(
    (acc, turn) => ({
      tokensSavedApprox: acc.tokensSavedApprox + turn.tokensSavedApprox,
      tokensKeptOutApprox: acc.tokensKeptOutApprox + turn.tokensKeptOutApprox,
    }),
    { tokensSavedApprox: 0, tokensKeptOutApprox: 0 },
  );

  return {
    generatedAt: Date.now(),
    sessionId,
    projectPath: latestTurn?.projectPath ?? null,
    totalTurns: recentTurns.length,
    totals,
    context: {
      tokens: latestTurn?.contextTokens ?? null,
      percent: latestTurn?.contextPercent ?? null,
      window: latestTurn?.contextWindow ?? null,
    },
    latestTurn,
    recentTurns,
  };
}

interface AnalyticsTotalsRow {
  totalTurns: number;
  tokensSavedApprox: number;
  tokensKeptOutApprox: number;
}

function emptyTotals(): AnalyticsTotals {
  return { tokensSavedApprox: 0, tokensKeptOutApprox: 0 };
}

function toImpactEvent(row: ImpactEventRow): DashboardImpactEvent {
  return {
    timestamp: row.timestamp,
    sessionId: row.session_id,
    projectPath: row.project_path,
    source: row.source,
    toolName: row.tool_name,
    strategy: row.strategy,
    tokensSavedApprox: row.tokens_saved_approx,
    tokensKeptOutApprox: row.tokens_kept_out_approx,
    contextPercent: row.context_percent,
    summary: row.summary,
  };
}

function buildScopeSummary(
  scope: AnalyticsScopeSummary["scope"],
  totals: AnalyticsTotalsRow,
): AnalyticsScopeSummary {
  return {
    scope,
    tokensSavedApprox: totals.tokensSavedApprox,
    tokensKeptOutApprox: totals.tokensKeptOutApprox,
    turnCount: totals.totalTurns,
  };
}

export function createAnalyticsStore(options: AnalyticsStoreOptions): AnalyticsStore {
  const dbPath = path.resolve(options.dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_TABLE_SQL);
  db.exec(CREATE_INDEX_SQL);
  db.exec(CREATE_IMPACT_EVENTS_TABLE_SQL);
  db.exec(CREATE_IMPACT_EVENTS_INDEX_SQL);
  db.exec(CREATE_STRATEGY_TOTALS_TABLE_SQL);

  const insertTurn = db.prepare(`
    INSERT INTO turn_metrics (
      session_id,
      project_path,
      turn_index,
      tool_count,
      message_count_after_turn,
      timestamp,
      context_tokens,
      context_percent,
      context_window,
      tokens_saved_approx,
      tokens_kept_out_approx
    ) VALUES (
      @sessionId,
      @projectPath,
      @turnIndex,
      @toolCount,
      @messageCountAfterTurn,
      @timestamp,
      @contextTokens,
      @contextPercent,
      @contextWindow,
      @tokensSavedApprox,
      @tokensKeptOutApprox
    )
  `);

  const selectRows = db.prepare<unknown[], AnalyticsRow>(`
    SELECT
      session_id,
      project_path,
      turn_index,
      tool_count,
      message_count_after_turn,
      timestamp,
      context_tokens,
      context_percent,
      context_window,
      tokens_saved_approx,
      tokens_kept_out_approx
    FROM turn_metrics
    WHERE session_id = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `);

  const selectSessionTotals = db.prepare<unknown[], AnalyticsTotalsRow>(`
    SELECT
      COUNT(*) AS totalTurns,
      COALESCE(SUM(tokens_saved_approx), 0) AS tokensSavedApprox,
      COALESCE(SUM(tokens_kept_out_approx), 0) AS tokensKeptOutApprox
    FROM turn_metrics
    WHERE session_id = ?
  `);

  const selectProjectTotals = db.prepare<unknown[], AnalyticsTotalsRow>(`
    SELECT
      COUNT(*) AS totalTurns,
      COALESCE(SUM(tokens_saved_approx), 0) AS tokensSavedApprox,
      COALESCE(SUM(tokens_kept_out_approx), 0) AS tokensKeptOutApprox
    FROM turn_metrics
    WHERE project_path = ?
  `);

  const selectLifetimeTotals = db.prepare<unknown[], AnalyticsTotalsRow>(`
    SELECT
      COUNT(*) AS totalTurns,
      COALESCE(SUM(tokens_saved_approx), 0) AS tokensSavedApprox,
      COALESCE(SUM(tokens_kept_out_approx), 0) AS tokensKeptOutApprox
    FROM turn_metrics
  `);

  const selectLatestSessionRow = db.prepare<unknown[], AnalyticsRow>(`
    SELECT
      session_id,
      project_path,
      turn_index,
      tool_count,
      message_count_after_turn,
      timestamp,
      context_tokens,
      context_percent,
      context_window,
      tokens_saved_approx,
      tokens_kept_out_approx
    FROM turn_metrics
    WHERE session_id = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
  `);

  const selectLatestProjectRow = db.prepare<unknown[], AnalyticsRow>(`
    SELECT
      session_id,
      project_path,
      turn_index,
      tool_count,
      message_count_after_turn,
      timestamp,
      context_tokens,
      context_percent,
      context_window,
      tokens_saved_approx,
      tokens_kept_out_approx
    FROM turn_metrics
    WHERE project_path = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
  `);

  const selectLatestLifetimeRow = db.prepare<unknown[], AnalyticsRow>(`
    SELECT
      session_id,
      project_path,
      turn_index,
      tool_count,
      message_count_after_turn,
      timestamp,
      context_tokens,
      context_percent,
      context_window,
      tokens_saved_approx,
      tokens_kept_out_approx
    FROM turn_metrics
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
  `);

  const insertImpactEvent = db.prepare(`
    INSERT INTO impact_events (
      session_id,
      project_path,
      timestamp,
      source,
      tool_name,
      strategy,
      tokens_saved_approx,
      tokens_kept_out_approx,
      context_percent,
      summary
    ) VALUES (
      @sessionId,
      @projectPath,
      @timestamp,
      @source,
      @toolName,
      @strategy,
      @tokensSavedApprox,
      @tokensKeptOutApprox,
      @contextPercent,
      @summary
    )
  `);

  const selectRecentImpactEvents = db.prepare<unknown[], ImpactEventRow>(`
    SELECT
      session_id,
      project_path,
      timestamp,
      source,
      tool_name,
      strategy,
      tokens_saved_approx,
      tokens_kept_out_approx,
      context_percent,
      summary
    FROM impact_events
    WHERE session_id = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `);

  const selectStrategyImpactTotals = db.prepare<unknown[], StrategyImpactTotalsRow>(`
    SELECT
      strategy,
      tokens_saved_approx AS tokensSavedApprox,
      tokens_kept_out_approx AS tokensKeptOutApprox
    FROM strategy_totals
    WHERE session_id = ?
  `);

  const upsertStrategyTotals = db.prepare(`
    INSERT INTO strategy_totals (
      session_id,
      strategy,
      tokens_saved_approx,
      tokens_kept_out_approx
    ) VALUES (
      @sessionId,
      @strategy,
      @tokensSavedApprox,
      @tokensKeptOutApprox
    )
    ON CONFLICT(session_id, strategy) DO UPDATE SET
      tokens_saved_approx = strategy_totals.tokens_saved_approx + excluded.tokens_saved_approx,
      tokens_kept_out_approx = strategy_totals.tokens_kept_out_approx + excluded.tokens_kept_out_approx
  `);

  const writeTurn = db.transaction((turn: AnalyticsTurnWrite) => {
    insertTurn.run(turn);
    for (const event of sanitizeImpactEvents(turn.impactEvents)) {
      insertImpactEvent.run(event);
      upsertStrategyTotals.run(event);
    }
  });

  function pruneExpiredRows(retentionDays?: number): void {
    if (!retentionDays || retentionDays <= 0) {
      return;
    }

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    db.prepare("DELETE FROM turn_metrics WHERE timestamp < ?").run(cutoff);
    db.prepare("DELETE FROM impact_events WHERE timestamp < ?").run(cutoff);
  }

  function getRows(sessionId: string, limit = 50): AnalyticsRow[] {
    return selectRows.all(sessionId, limit) as AnalyticsRow[];
  }

  function getTotals(
    scope: "session" | "project" | "lifetime",
    value?: string,
  ): AnalyticsTotalsRow {
    if (scope === "session") {
      return (selectSessionTotals.get(value) as AnalyticsTotalsRow | undefined) ?? {
        totalTurns: 0,
        ...emptyTotals(),
      };
    }

    if (scope === "project" && typeof value === "string") {
      return (selectProjectTotals.get(value) as AnalyticsTotalsRow | undefined) ?? {
        totalTurns: 0,
        ...emptyTotals(),
      };
    }

    return (selectLifetimeTotals.get() as AnalyticsTotalsRow | undefined) ?? {
      totalTurns: 0,
      ...emptyTotals(),
    };
  }

  function getLatestTurn(
    scope: "session" | "project" | "lifetime",
    value?: string,
  ): AnalyticsTurnRecord | null {
    const row =
      scope === "session"
        ? (selectLatestSessionRow.get(value) as AnalyticsRow | undefined)
        : scope === "project" && typeof value === "string"
          ? (selectLatestProjectRow.get(value) as AnalyticsRow | undefined)
          : (selectLatestLifetimeRow.get() as AnalyticsRow | undefined);

    return row ? toTurnRecord(row) : null;
  }

  function getImpactEvents(sessionId: string, limit = 50): DashboardImpactEvent[] {
    return (selectRecentImpactEvents.all(sessionId, limit) as ImpactEventRow[]).map(toImpactEvent);
  }

  function getStrategyImpactTotals(sessionId: string): Record<string, StrategyImpactTotals> {
    const rows = selectStrategyImpactTotals.all(sessionId) as StrategyImpactTotalsRow[];
    const totals: Record<string, StrategyImpactTotals> = {};
    for (const row of rows) {
      if (row.tokensSavedApprox > 0 || row.tokensKeptOutApprox > 0) {
        totals[row.strategy] = {
          tokensSavedApprox: row.tokensSavedApprox,
          tokensKeptOutApprox: row.tokensKeptOutApprox,
        };
      }
    }
    return totals;
  }

  function readDashboardSnapshot(
    sessionId: string,
    projectPath: string | null,
    limit = 50,
  ): DashboardSnapshot {
    const rows = getRows(sessionId, limit);
    const snapshot = buildSnapshot(rows, sessionId);
    const sessionLatestTurn = snapshot.latestTurn;
    const effectiveProjectPath = sessionLatestTurn?.projectPath ?? projectPath ?? null;

    const sessionTotals = getTotals("session", sessionId);
    const projectTotals =
      typeof effectiveProjectPath === "string"
        ? getTotals("project", effectiveProjectPath)
        : { totalTurns: 0, ...emptyTotals() };
    const lifetimeTotals = getTotals("lifetime");

    const scopes = {
      session: buildScopeSummary("session", sessionTotals),
      project: buildScopeSummary("project", projectTotals),
      lifetime: buildScopeSummary("lifetime", lifetimeTotals),
    };

    const strategyImpactTotals = getStrategyImpactTotals(sessionId);

    return {
      generatedAt: snapshot.generatedAt,
      sessionId,
      projectPath: effectiveProjectPath,
      context: snapshot.context,
      scopes,
      strategyTotals: Object.fromEntries(
        Object.entries(strategyImpactTotals).map(([strategy, totals]) => [strategy, totals.tokensSavedApprox]),
      ),
      recentImpactEvents: getImpactEvents(sessionId, limit),
    };
  }

  function readLegacySnapshot(sessionId: string, limit = 50): LegacyAnalyticsSnapshot {
    const rows = getRows(sessionId, limit);
    const totals = getTotals("session", sessionId);
    const snapshot = buildSnapshot(rows, sessionId);

    return {
      ...snapshot,
      totalTurns: totals.totalTurns,
      totals: {
        tokensSavedApprox: totals.tokensSavedApprox,
        tokensKeptOutApprox: totals.tokensKeptOutApprox,
      },
    };
  }

  const store: AnalyticsStore = {
    recordTurn(turn: AnalyticsTurnWrite): DashboardSnapshot {
      writeTurn(turn);
      pruneExpiredRows(options.retentionDays);
      return readDashboardSnapshot(turn.sessionId, turn.projectPath);
    },
    getDashboardSnapshot(sessionId: string, projectPath: string, limit = 50): DashboardSnapshot {
      return readDashboardSnapshot(sessionId, projectPath, limit);
    },
    getSnapshot(sessionId: string, limit = 50): LegacyAnalyticsSnapshot {
      return readLegacySnapshot(sessionId, limit);
    },
    getStrategyImpactTotals(sessionId: string): Record<string, StrategyImpactTotals> {
      return getStrategyImpactTotals(sessionId);
    },
    close(): void {
      db.close();
    },
  };

  return store;
}

function sanitizeImpactEvents(events: DashboardImpactEvent[] | undefined): DashboardImpactEvent[] {
  if (!Array.isArray(events)) {
    return [];
  }

  return events.filter((event) =>
    (event.tokensSavedApprox > 0 || event.tokensKeptOutApprox > 0)
    && typeof event.sessionId === "string"
    && typeof event.projectPath === "string"
    && typeof event.source === "string"
    && typeof event.strategy === "string"
    && typeof event.summary === "string"
  );
}
