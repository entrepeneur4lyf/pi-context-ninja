export function renderDashboardPage(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>PCN Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: rgba(10, 23, 40, 0.86);
      --panel-strong: rgba(14, 31, 52, 0.95);
      --border: rgba(122, 162, 203, 0.2);
      --text: #e7f0fa;
      --muted: #93a9bf;
      --accent: #7dd3fc;
      --accent-strong: #22d3ee;
      --good: #86efac;
      --scope-session: linear-gradient(90deg, #22d3ee 0%, #38bdf8 100%);
      --scope-project: linear-gradient(90deg, #818cf8 0%, #38bdf8 100%);
      --scope-lifetime: linear-gradient(90deg, #34d399 0%, #86efac 100%);
      --track: rgba(122, 162, 203, 0.14);
      --strategy-1: linear-gradient(90deg, #fb7185 0%, #f97316 100%);
      --strategy-2: linear-gradient(90deg, #f59e0b 0%, #facc15 100%);
      --strategy-3: linear-gradient(90deg, #22d3ee 0%, #38bdf8 100%);
      --strategy-4: linear-gradient(90deg, #a78bfa 0%, #818cf8 100%);
      --strategy-5: linear-gradient(90deg, #34d399 0%, #2dd4bf 100%);
      --strategy-6: linear-gradient(90deg, #c084fc 0%, #e879f9 100%);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(34, 211, 238, 0.18), transparent 35%),
        radial-gradient(circle at top right, rgba(125, 211, 252, 0.16), transparent 32%),
        linear-gradient(180deg, #081220 0%, #050b14 100%);
      color: var(--text);
    }

    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 2rem 1.25rem 3rem;
    }

    .hero {
      display: grid;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
    }

    .eyebrow {
      margin: 0;
      color: var(--accent);
      font-size: 0.82rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      font-size: clamp(2rem, 4vw, 3.25rem);
      line-height: 1;
    }

    .hero-copy {
      margin: 0;
      max-width: 52rem;
      color: var(--muted);
      line-height: 1.5;
    }

    .meta-strip {
      display: grid;
      gap: 0.75rem;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      margin: 1rem 0 1.25rem;
    }

    .meta-chip {
      border: 1px solid var(--border);
      background: rgba(8, 18, 32, 0.62);
      border-radius: 14px;
      padding: 0.8rem 0.95rem;
      min-width: 0;
    }

    .meta-label {
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 0.35rem;
    }

    .meta-value {
      font-size: 0.98rem;
      font-weight: 600;
      word-break: break-word;
    }

    .summary-band {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      margin-bottom: 1.5rem;
    }

    .card,
    .panel {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 18px;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(18px);
    }

    .card {
      padding: 1rem 1.1rem;
    }

    .card-label {
      color: var(--muted);
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .card-value {
      margin-top: 0.5rem;
      font-size: clamp(1.5rem, 3vw, 2.3rem);
      font-weight: 700;
      color: var(--accent-strong);
      word-break: break-word;
    }

    .card-value.subtle {
      color: var(--text);
      font-size: 1rem;
      line-height: 1.4;
      font-weight: 600;
    }

    .layout {
      display: grid;
      gap: 1rem;
      grid-template-columns: minmax(0, 1.25fr) minmax(0, 0.95fr);
    }

    .chart-grid {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      margin-bottom: 1rem;
    }

    .panel {
      padding: 1.1rem;
    }

    .panel h2 {
      margin: 0 0 0.8rem;
      font-size: 1.1rem;
    }

    .panel-copy {
      margin: -0.2rem 0 1rem;
      color: var(--muted);
      font-size: 0.92rem;
      line-height: 1.45;
    }

    .stream {
      display: grid;
      gap: 0.75rem;
      white-space: pre-wrap;
      line-height: 1.45;
      color: var(--text);
    }

    .stream.empty {
      color: var(--muted);
    }

    .stream.live {
      max-height: 340px;
      overflow-y: auto;
      padding-right: 0.2rem;
    }

    .stream.ledger-scroll {
      max-height: 420px;
      overflow-y: auto;
      padding-right: 0.2rem;
    }

    .impact-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
    }

    .impact-table th,
    .impact-table td {
      padding: 0.72rem 0.45rem;
      text-align: left;
      border-bottom: 1px solid rgba(122, 162, 203, 0.12);
      vertical-align: top;
    }

    .impact-table th {
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 700;
    }

    .impact-table td {
      color: var(--text);
      font-variant-numeric: tabular-nums;
    }

    .metric {
      color: var(--good);
      font-weight: 600;
    }

    .chart-shell {
      display: grid;
      gap: 0.9rem;
    }

    .chart-shell.empty {
      color: var(--muted);
    }

    .chart-row {
      display: grid;
      gap: 0.5rem;
    }

    .chart-topline {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      align-items: baseline;
      font-size: 0.95rem;
    }

    .chart-label {
      font-weight: 700;
      color: var(--text);
    }

    .chart-value {
      color: var(--accent-strong);
      font-weight: 700;
    }

    .chart-detail {
      color: var(--muted);
      font-size: 0.82rem;
      line-height: 1.4;
    }

    .chart-track {
      position: relative;
      overflow: hidden;
      height: 0.7rem;
      border-radius: 999px;
      background: var(--track);
      border: 1px solid rgba(122, 162, 203, 0.08);
    }

    .chart-fill {
      height: 100%;
      border-radius: inherit;
      min-width: 0;
    }

    .scope-session {
      background: var(--scope-session);
    }

    .scope-project {
      background: var(--scope-project);
    }

    .scope-lifetime {
      background: var(--scope-lifetime);
    }

    .strategy-1 {
      background: var(--strategy-1);
    }

    .strategy-2 {
      background: var(--strategy-2);
    }

    .strategy-3 {
      background: var(--strategy-3);
    }

    .strategy-4 {
      background: var(--strategy-4);
    }

    .strategy-5 {
      background: var(--strategy-5);
    }

    .strategy-6 {
      background: var(--strategy-6);
    }

    @media (max-width: 860px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main>
    <header class="hero">
      <p class="eyebrow">Pi Context Ninja</p>
      <h1>Control Tower</h1>
      <p class="hero-copy">Refresh-safe runtime telemetry for the current operator session. Rehydrate the latest snapshot and impact history first, then layer live updates on top.</p>
    </header>

    <section class="summary-band" aria-label="Summary Band">
      <article class="card">
        <div class="card-label">Current Context</div>
        <div id="ctx-pct" class="card-value">--%</div>
      </article>
      <article class="card">
        <div class="card-label">Context Tokens / Window</div>
        <div id="ctx-window" class="card-value subtle">-- / --</div>
      </article>
      <article class="card">
        <div class="card-label">Session Saved</div>
        <div id="session-saved" class="card-value">--</div>
      </article>
      <article class="card">
        <div class="card-label">Project Saved</div>
        <div id="project-saved" class="card-value">--</div>
      </article>
      <article class="card">
        <div class="card-label">Lifetime Saved</div>
        <div id="lifetime-saved" class="card-value">--</div>
      </article>
      <article class="card">
        <div class="card-label">Recent Impacts</div>
        <div id="impact-count" class="card-value">--</div>
      </article>
    </section>

    <section class="meta-strip" aria-label="Session Metadata">
      <article class="meta-chip">
        <div class="meta-label">Session</div>
        <div id="session-id" class="meta-value">--</div>
      </article>
      <article class="meta-chip">
        <div class="meta-label">Project Path</div>
        <div id="project-path" class="meta-value">--</div>
      </article>
    </section>

    <section class="chart-grid" aria-label="Dashboard Charts">
      <article class="panel">
        <h2>Scope Comparison</h2>
        <p class="panel-copy">Session, project, and lifetime savings stay side by side so the current run never gets mistaken for the whole campaign.</p>
        <div id="scope-chart" class="chart-shell empty">No scope comparison yet.</div>
      </article>

      <article class="panel">
        <h2>Strategy Payoff</h2>
        <p class="panel-copy">Backend strategy totals rank which pruning moves are actually paying off, without dragging operator attention into transport detail.</p>
        <div id="strategy-chart" class="chart-shell empty">No strategy payoff yet.</div>
      </article>
    </section>

    <section class="layout">
      <article class="panel">
        <h2>Impact Ledger</h2>
        <p class="panel-copy">Recent operator-visible interventions, rendered as readable summaries instead of transport payloads.</p>
        <div id="impact-ledger" class="stream empty">No recent impact yet.</div>
      </article>

      <article class="panel">
        <h2>Live Feed</h2>
        <p class="panel-copy">Fresh impact events arrive here after bootstrap. Snapshot updates keep the summary band in sync.</p>
        <div id="live-feed" class="stream live empty">Waiting for live updates.</div>
      </article>
    </section>
  </main>

  <script>
    const sessionIdEl = document.getElementById('session-id');
    const projectPathEl = document.getElementById('project-path');
    const contextPctEl = document.getElementById('ctx-pct');
    const contextWindowEl = document.getElementById('ctx-window');
    const sessionSavedEl = document.getElementById('session-saved');
    const projectSavedEl = document.getElementById('project-saved');
    const lifetimeSavedEl = document.getElementById('lifetime-saved');
    const impactCountEl = document.getElementById('impact-count');
    const scopeChartEl = document.getElementById('scope-chart');
    const strategyChartEl = document.getElementById('strategy-chart');
    const impactLedgerEl = document.getElementById('impact-ledger');
    const liveFeedEl = document.getElementById('live-feed');

    let currentSessionId = new URLSearchParams(window.location.search).get('sessionId');
    let source;
    let liveFeedEntries = [];
    let latestHistoryImpactKey = null;

    function formatNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '--';
    }

    function formatPercent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '--%';
      }

      return (value * 100).toFixed(1) + '%';
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function resolveScope(snapshot, scopeName) {
      if (snapshot?.scopes?.[scopeName]) {
        return snapshot.scopes[scopeName];
      }

      if (scopeName === 'session') {
        return {
          tokensSavedApprox: snapshot?.totals?.tokensSavedApprox ?? null,
          tokensKeptOutApprox: snapshot?.totals?.tokensKeptOutApprox ?? null,
          turnCount: snapshot?.totalTurns ?? null,
        };
      }

      return {
        tokensSavedApprox: null,
        tokensKeptOutApprox: null,
        turnCount: null,
      };
    }

    function humanizeLabel(value) {
      return String(value)
        .split('_')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
    }

    function humanizeToolName(value) {
      return String(value).replaceAll('_', ' ').trim();
    }

    function formatCompactNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '--';
      }

      const absValue = Math.abs(value);
      if (absValue >= 1000000) {
        return (value / 1000000).toFixed(absValue >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'm';
      }
      if (absValue >= 1000) {
        return (value / 1000).toFixed(absValue >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'k';
      }

      return Math.round(value).toString();
    }

    function describeImpactSource(value) {
      if (value === 'runtime.materialize') {
        return 'Context Update';
      }

      return humanizeLabel(value);
    }

    function describeImpactStrategy(value) {
      if (value === 'background_index') {
        return 'Older Output';
      }

      return humanizeLabel(value);
    }

    function buildReadableImpactSummary(entry) {
      if (entry == null || typeof entry !== 'object') {
        return 'Context impact recorded.';
      }

      const toolName = typeof entry.toolName === 'string' && entry.toolName.length > 0
        ? humanizeToolName(entry.toolName)
        : 'tool';

      if (entry.strategy === 'background_index') {
        return 'Indexed older ' + toolName + ' output';
      }

      if (typeof entry.summary === 'string' && entry.summary.length > 0) {
        return entry.summary;
      }

      return describeImpactStrategy(entry.strategy || 'impact') + ' on ' + toolName;
    }

    function getChartWidth(value, maxValue) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || maxValue <= 0) {
        return '0%';
      }

      return Math.max(8, Math.round((value / maxValue) * 100)) + '%';
    }

    function formatTimestamp(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '--';
      }

      return new Date(value).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }

    function getImpactEventKey(entry) {
      if (entry == null || typeof entry !== 'object') {
        return null;
      }

      return [
        entry.timestamp,
        entry.sessionId,
        entry.projectPath,
        entry.source,
        entry.toolName ?? '',
        entry.strategy,
        entry.tokensSavedApprox,
        entry.tokensKeptOutApprox,
        entry.contextPercent ?? '',
        entry.summary,
      ].join('\u0000');
    }

    function buildSnapshotUrl() {
      if (typeof currentSessionId !== 'string' || currentSessionId.length === 0) {
        return '/snapshot';
      }

      return '/snapshot?sessionId=' + encodeURIComponent(currentSessionId);
    }

    function buildHistoryUrl() {
      if (typeof currentSessionId !== 'string' || currentSessionId.length === 0) {
        return '/history';
      }

      return '/history?sessionId=' + encodeURIComponent(currentSessionId);
    }

    function buildEventUrl() {
      const params = new URLSearchParams();

      if (typeof currentSessionId === 'string' && currentSessionId.length > 0) {
        params.set('sessionId', currentSessionId);
      }
      if (typeof latestHistoryImpactKey === 'string') {
        params.set('after', latestHistoryImpactKey);
      }

      const query = params.toString();
      return query.length > 0 ? '/events?' + query : '/events';
    }

    function bindToSession(sessionId, reconnect) {
      if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId === currentSessionId) {
        return;
      }

      currentSessionId = sessionId;
      const params = new URLSearchParams(window.location.search);
      params.set('sessionId', sessionId);
      const nextSearch = params.toString();
      const nextUrl = window.location.pathname + (nextSearch.length > 0 ? '?' + nextSearch : '');
      window.history.replaceState(null, '', nextUrl);
      latestHistoryImpactKey = null;
      liveFeedEntries = [];
      renderLiveFeed();

      if (reconnect) {
        source?.close();
        connectEvents();
      }
    }

    function resetSnapshotStats() {
      sessionIdEl.textContent = '--';
      projectPathEl.textContent = '--';
      contextPctEl.textContent = '--%';
      contextWindowEl.textContent = '-- / --';
      sessionSavedEl.textContent = '--';
      projectSavedEl.textContent = '--';
      lifetimeSavedEl.textContent = '--';
      impactCountEl.textContent = '--';
    }

    function applySnapshotStats(snapshot) {
      if (snapshot == null) {
        resetSnapshotStats();
        latestHistoryImpactKey = null;
        liveFeedEntries = [];
        renderLiveFeed();
        return;
      }

      const sessionScope = resolveScope(snapshot, 'session');
      const projectScope = resolveScope(snapshot, 'project');
      const lifetimeScope = resolveScope(snapshot, 'lifetime');
      sessionIdEl.textContent = typeof snapshot.sessionId === 'string' && snapshot.sessionId.length > 0 ? snapshot.sessionId : '--';
      projectPathEl.textContent = typeof snapshot.projectPath === 'string' && snapshot.projectPath.length > 0 ? snapshot.projectPath : '--';
      contextPctEl.textContent = formatPercent(snapshot.context?.percent);
      contextWindowEl.textContent = formatNumber(snapshot.context?.tokens) + ' / ' + formatNumber(snapshot.context?.window);
      sessionSavedEl.textContent = formatNumber(sessionScope?.tokensSavedApprox);
      projectSavedEl.textContent = formatNumber(projectScope?.tokensSavedApprox);
      lifetimeSavedEl.textContent = formatNumber(lifetimeScope?.tokensSavedApprox);
      impactCountEl.textContent = formatNumber(Array.isArray(snapshot?.recentImpactEvents) ? snapshot.recentImpactEvents.length : 0);
    }

    function renderScopeChart(snapshot) {
      const scopeEntries = snapshot?.scopes
        ? [
            { label: 'Session', className: 'scope-session', data: snapshot.scopes.session },
            { label: 'Project', className: 'scope-project', data: snapshot.scopes.project },
            { label: 'Lifetime', className: 'scope-lifetime', data: snapshot.scopes.lifetime },
          ]
        : [];

      const maxSaved = Math.max(
        0,
        ...scopeEntries.map((entry) =>
          typeof entry.data?.tokensSavedApprox === 'number' && Number.isFinite(entry.data.tokensSavedApprox)
            ? entry.data.tokensSavedApprox
            : 0,
        ),
      );
      const maxKeptOut = Math.max(
        0,
        ...scopeEntries.map((entry) =>
          typeof entry.data?.tokensKeptOutApprox === 'number' && Number.isFinite(entry.data.tokensKeptOutApprox)
            ? entry.data.tokensKeptOutApprox
            : 0,
        ),
      );
      const primaryMetric = maxSaved > 0 ? 'saved' : 'kept out';
      const primaryMax = primaryMetric === 'saved' ? maxSaved : maxKeptOut;

      if (scopeEntries.length === 0 || primaryMax === 0) {
        scopeChartEl.innerHTML = 'No scope comparison yet.';
        scopeChartEl.className = 'chart-shell empty';
        return;
      }

      scopeChartEl.className = 'chart-shell';
      scopeChartEl.innerHTML = scopeEntries
        .map(({ label, className, data }) => {
          const saved = typeof data.tokensSavedApprox === 'number' ? data.tokensSavedApprox : 0;
          const keptOut = typeof data.tokensKeptOutApprox === 'number' ? data.tokensKeptOutApprox : 0;
          const turns = typeof data.turnCount === 'number' ? data.turnCount : 0;
          const primaryValue = primaryMetric === 'saved' ? saved : keptOut;
          const secondaryLabel = primaryMetric === 'saved' ? 'kept out' : 'saved';
          const secondaryValue = primaryMetric === 'saved' ? keptOut : saved;

          return [
            '<div class="chart-row">',
            '  <div class="chart-topline">',
            '    <span class="chart-label">' + label + '</span>',
            '    <span class="chart-value">' + formatNumber(primaryValue) + ' ' + primaryMetric + '</span>',
            '  </div>',
            '  <div class="chart-track"><div class="chart-fill ' +
              className +
              '" style="width: ' +
              getChartWidth(primaryValue, primaryMax) +
              ';"></div></div>',
            '  <div class="chart-detail">' + secondaryLabel + ' ' +
              formatNumber(secondaryValue) +
              ' · ' +
              formatNumber(turns) +
              ' turn' +
              (turns === 1 ? '' : 's') +
              '</div>',
            '</div>',
          ].join('');
        })
        .join('');
    }

    function renderStrategyChart(snapshot) {
      const strategyEntries = Object.entries(snapshot?.strategyTotals ?? {})
        .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 6);
      const maxSaved = strategyEntries.length === 0 ? 0 : strategyEntries[0][1];

      if (strategyEntries.length === 0 || maxSaved === 0) {
        strategyChartEl.innerHTML = 'No strategy payoff yet.';
        strategyChartEl.className = 'chart-shell empty';
        return;
      }

      strategyChartEl.className = 'chart-shell';
      strategyChartEl.innerHTML = strategyEntries
        .map(([strategy, saved], index) => {
          const colorClass = 'strategy-' + ((index % 6) + 1);

          return [
            '<div class="chart-row">',
            '  <div class="chart-topline">',
            '    <span class="chart-label">' + escapeHtml(humanizeLabel(strategy)) + '</span>',
            '    <span class="chart-value">' + formatNumber(saved) + ' saved</span>',
            '  </div>',
            '  <div class="chart-track"><div class="chart-fill ' +
              colorClass +
              '" style="width: ' +
              getChartWidth(saved, maxSaved) +
              ';"></div></div>',
            '  <div class="chart-detail">Backend strategyTotals signal</div>',
            '</div>',
          ].join('');
        })
        .join('');
    }

    function renderCharts(snapshot) {
      renderScopeChart(snapshot);
      renderStrategyChart(snapshot);
    }

    function formatImpactEntry(entry) {
      if (entry == null || typeof entry !== 'object') {
        return 'Unknown impact event';
      }

      const summary = buildReadableImpactSummary(entry);
      const details = [];

      if (typeof entry.tokensSavedApprox === 'number' && Number.isFinite(entry.tokensSavedApprox) && entry.tokensSavedApprox > 0) {
        details.push(formatCompactNumber(entry.tokensSavedApprox) + ' saved');
      }
      if (typeof entry.tokensKeptOutApprox === 'number' && Number.isFinite(entry.tokensKeptOutApprox) && entry.tokensKeptOutApprox > 0) {
        details.push(formatCompactNumber(entry.tokensKeptOutApprox) + ' kept out of context');
      }

      const contextPercent = entry.contextPercent ?? entry.context?.percent ?? null;
      if (typeof contextPercent === 'number' && Number.isFinite(contextPercent)) {
        details.push('ctx ' + formatPercent(contextPercent));
      }

      return details.length > 0 ? summary + ' [' + details.join(' | ') + ']' : summary;
    }

    function renderImpactLedger(events) {
      if (!Array.isArray(events) || events.length === 0) {
        latestHistoryImpactKey = null;
        impactLedgerEl.innerHTML = 'No recent impact yet.';
        impactLedgerEl.className = 'stream empty';
        return;
      }

      latestHistoryImpactKey = getImpactEventKey(events[0]);
      impactLedgerEl.innerHTML = [
        '<table class="impact-table">',
        '  <thead>',
        '    <tr>',
        '      <th>Time</th>',
        '      <th>Source</th>',
        '      <th>Tool</th>',
        '      <th>Strategy</th>',
        '      <th>Saved</th>',
        '      <th>Kept Out</th>',
        '      <th>Context</th>',
        '    </tr>',
        '  </thead>',
        '  <tbody>',
        events.map((entry) => {
          const toolName = typeof entry?.toolName === 'string' && entry.toolName.length > 0 ? humanizeToolName(entry.toolName) : '—';
          const strategy = typeof entry?.strategy === 'string' && entry.strategy.length > 0 ? describeImpactStrategy(entry.strategy) : '—';
          const sourceName = typeof entry?.source === 'string' && entry.source.length > 0 ? describeImpactSource(entry.source) : '—';

          return [
            '<tr>',
            '  <td>' + escapeHtml(formatTimestamp(entry?.timestamp)) + '</td>',
            '  <td>' + escapeHtml(sourceName) + '</td>',
            '  <td>' + escapeHtml(toolName) + '</td>',
            '  <td>' + escapeHtml(strategy) + '</td>',
            '  <td>' + escapeHtml(formatNumber(entry?.tokensSavedApprox)) + '</td>',
            '  <td>' + escapeHtml(formatNumber(entry?.tokensKeptOutApprox)) + '</td>',
            '  <td>' + escapeHtml(formatPercent(entry?.contextPercent)) + '</td>',
            '</tr>',
          ].join('');
        }).join(''),
        '  </tbody>',
        '</table>',
      ].join('');
      impactLedgerEl.className = 'stream ledger-scroll';
    }

    function renderLiveFeed() {
      if (liveFeedEntries.length === 0) {
        liveFeedEl.textContent = 'Waiting for live updates.';
        liveFeedEl.className = 'stream live empty';
        return;
      }

      liveFeedEl.textContent = liveFeedEntries.join('\\n');
      liveFeedEl.className = 'stream live';
      liveFeedEl.scrollTop = liveFeedEl.scrollHeight;
    }

    function pushLiveFeedEntry(entry) {
      liveFeedEntries.unshift(formatImpactEntry(entry));
      if (liveFeedEntries.length > 12) {
        liveFeedEntries = liveFeedEntries.slice(0, 12);
      }
      renderLiveFeed();
    }

    async function fetchJson(url) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Unexpected status for ' + url);
      }

      return response.json();
    }

    function connectEvents() {
      source = new EventSource(buildEventUrl());
      source.onmessage = handleMessage;
    }

    function handleMessage(event) {
      const payload = JSON.parse(event.data);

      if (payload.type === 'snapshot') {
        applySnapshotStats(payload.data);
        renderCharts(payload.data);
        renderImpactLedger(Array.isArray(payload.data?.recentImpactEvents) ? payload.data.recentImpactEvents : []);

        if (!currentSessionId && typeof payload.data?.sessionId === 'string' && payload.data.sessionId.length > 0) {
          bindToSession(payload.data.sessionId, true);
        }

        return;
      }

      if (payload.type === 'impact') {
        pushLiveFeedEntry(payload.data);
      }
    }

    async function bootstrap() {
      try {
        const snapshot = await fetchJson(buildSnapshotUrl());
        if (!currentSessionId && typeof snapshot?.sessionId === 'string' && snapshot.sessionId.length > 0) {
          bindToSession(snapshot.sessionId, false);
        }
        applySnapshotStats(snapshot);
        renderCharts(snapshot);
      } catch {
        resetSnapshotStats();
        renderCharts(null);
      }

      try {
        const history = await fetchJson(buildHistoryUrl());
        renderImpactLedger(history);
      } catch {
        renderImpactLedger([]);
      }

      renderLiveFeed();
      connectEvents();
    }

    bootstrap();
  </script>
</body>
</html>`;
}
