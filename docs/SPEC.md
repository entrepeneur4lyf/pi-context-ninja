# Pi Context Ninja — Full Spec

Silent-first context optimization extension for Pi, informed by HMC (Hermes Context Manager) but aligned to Pi's real extension/runtime model.

## Origin

HMC was built after watching visible compression machinery create its own failure mode:
re-injected summaries, stale bundles, and model-visible compression artifacts that the
model could not control.

Pi Context Ninja exists to keep the model's working context shorter and cleaner without
turning compression into part of the conversation.

## Core Principle

Silent-first.

The model should see:
- a shorter, cleaner request context
- optionally a tiny passive system hint
- never a visible compression workflow
- never compression tags or "bundle" messages added as ordinary conversation

## Pi-Aligned Design Stance

PCN is NOT a line-by-line port of Hermes hook behavior.

It is a semantic port of HMC's pruning strategies onto Pi's actual runtime model.
The biggest architectural difference is this:

- Hermes mutates shared conversation dicts in place and must restore them later.
- Pi runs request-time context transformation through `transformContext`, and the
  extension runner clones messages before handing them to `context` handlers.

That means PCN should treat Pi as a view-layer pruning system first.

Default behavior in this spec:
- keep Pi session history raw on disk
- keep PCN pruning external and silent
- persist PCN state in sidecars/SQLite
- re-materialize the pruned view on each request via Pi hooks

Optional behavior:
- integrate with Pi native compaction through `session_before_compact`
- produce model-visible compaction entries only when that mode is explicitly enabled

That optional mode is NOT the default silent-first path.

## Real Pi Extension / Runtime Surface

The relevant Pi surfaces are:

- `tool_call`
- `tool_result`
- `context`
- `before_provider_request`
- `before_agent_start`
- `turn_end`
- `agent_end`
- `session_shutdown`
- `session_before_compact` (optional / hybrid mode)

Pi wiring details that matter:
- `sdk.ts` wires `transformContext` to `extensionRunner.emitContext(messages)`
- `runner.emitContext()` uses `structuredClone(messages)` before invoking handlers
- `sdk.ts` wires provider payload interception through `onPayload -> before_provider_request`
- `agent-session.ts` installs `tool_call` and `tool_result` hooks on the live agent
- `agent-session.ts` exposes `agent_end`, `turn_start`, `turn_end`, and native compaction events

## Hook Mapping

### Required default hooks

| Hermes concept | Pi hook/event | PCN responsibility |
|---|---|---|
| `pre_tool_call` | `tool_call` | Fingerprint args, record tool metadata, track turn association |
| `post_tool_call` | `tool_result` | Immediate shaping for successful outputs, telemetry, token estimate update |
| `pre_llm_call` | `context` | Main materialization pipeline over cloned `AgentMessage[]` |
| injected passive context note | `before_agent_start` | Append a tiny system-prompt hint when enabled |
| provider payload observation | `before_provider_request` | Observe or pass through the provider payload without mutating it by default |
| turn accounting | `turn_end` | Record exact Pi context usage and approximate savings for the dashboard/analytics layer |
| final accounting / tail cleanup | `agent_end` and `session_shutdown` | Final index refresh, persistence, analytics cleanup, resource shutdown |

### Optional hooks

| Pi hook/event | Use |
|---|---|
| `session_before_compact` | Optional native compaction path that can return a Pi-shaped `CompactionResult` when enabled |

## Critical Differences from Hermes and Pi Native Compaction

### Difference 1: No shared-message mutation model

Hermes required backup/restore logic because it mutated the shared live conversation.
Pi `context` handlers receive cloned messages, so PCN does not need HMC's `_active_mutations`
restore machinery for normal request-time pruning.

### Difference 2: Pi tool result role is `toolResult`

Hermes worked over `tool` messages.
Pi request/session messages use `toolResult`.
Any pruning, role filtering, or token accounting logic must use Pi's role names.

### Difference 3: Built-in tool names are different

Hermes protected tools included `write_file` and `patch`.
In Pi, built-ins are typically `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`.

Default protected tools in PCN should therefore start with:
- `write`
- `edit`

Custom protected tool names remain configurable.

### Difference 4: Error tool results cannot be fully handled in `tool_result`

In Pi, `tool_result` can modify successful outputs, but `agent-session.ts` ignores the
replacement payload for error results when `isError` is true.

Implication:
- immediate error shaping is limited
- stale error purging must happen in `context`, not only in `tool_result`

### Difference 5: Native compaction is model-visible

Pi native compaction creates `compaction` entries that become part of future context.
That is useful, but it is not silent-first in the HMC sense.

Default PCN mode therefore keeps native compaction disabled. When `nativeCompactionIntegration.enabled` is turned on, PCN may return a native `CompactionResult` through `session_before_compact`; otherwise it stays out of Pi compaction entirely.

## Silent-First Model in Pi

PCN's silent-first model is:

1. Pi session history remains raw
2. PCN stores pruning/index state externally
3. Each `context` call filters or rewrites the cloned message list
4. `before_agent_start` may add a minimal passive note
5. The model sees only the pruned view, not the raw history and not the pruning machinery

This means PCN can behave like "deletion" from the model's perspective without rewriting
Pi's session file.

## Architecture

```text
pi-context-ninja/
  src/
    index.ts                    # Extension entry point + hook wiring
    state.ts                    # SessionState, ToolRecord, omit ranges, fingerprinting
    config.ts                   # Config loading + defaults
    normalizer.ts               # Content normalization for dedup
    messages.ts                 # Pi role/tool normalization helpers
    strategies/
      short-circuit.ts          # Pattern matching -> one-liner replacements
      code-filter.ts            # Code-aware body stripping
      truncation.ts             # Head/tail windowing with gap marker
      dedup.ts                  # Fingerprint + normalized-content dedup
      error-purge.ts            # Stale error removal by turn age
      pruning.ts                # Tombstone replacement / omit-range filtering
      materialize.ts            # Main Pi context materialization pipeline
    code-filter/
      line-scanner.ts
      python-filter.ts
      brace-filter.ts
      jsx-detection.ts
      language-detection.ts
    compression/
      range-selection.ts        # Identify stale historical ranges
      summarizer.ts             # Auxiliary-model summarization helpers
      index-entry.ts            # Index row + TOC text building
    persistence/
      state-store.ts            # JSON sidecars (~/.pi-ninja/state/)
      index-store.ts            # JSONL range index
    analytics/
      store.ts                  # SQLite-backed cumulative savings
      types.ts
    dashboard/
      server.ts                 # HTTP + SSE server
      event-bus.ts
      page.ts
  package.json
  tsconfig.json
  README.md
```

## Message Model Assumptions

PCN operates over Pi `AgentMessage[]` and must handle at least:
- `user`
- `assistant`
- `toolResult`
- custom/summary messages defensively if present

Important rules:
- Never split an assistant tool call from the corresponding `toolResult` view semantics
- Never assume Hermes-style `tool_call_id` field names without adapting to Pi message shape
- Never use Python/Hermes field names in the TypeScript implementation unless they are explicitly normalized first

## Six Compression Strategies

All strategies remain silent-first.

### Strategy 1: Short-Circuit Pattern Matching

Replace known-success tool outputs with one-liners.

Examples:
- JSON success -> `[ok]`
- test summaries -> `[tests: N passed]`
- git already-up-to-date -> `[git: up to date]`
- file write confirmations -> `[file written]`

Rules:
- apply in `tool_result` for immediate successful-output shaping
- re-apply in `context` as a safety net
- never short-circuit error content

### Strategy 2: Code-Aware Compression

Strip bodies from source code while preserving:
- signatures
- imports
- top-level constants
- docstrings where configured

Language support target:
- Python
- JavaScript
- TypeScript
- Rust
- Go

JSX/TSX handling:
- keep HMC's bailout philosophy
- do not mis-detect TypeScript generics as JSX

Detection order:
- tool args / filename when available
- fenced markdown language tag
- content sniffing

### Strategy 3: Head/Tail Truncation

Large text outputs keep the first N and last M lines with a gap marker.

Pi note:
- Pi already has truncation utilities in its codebase
- PCN still needs explicit head+tail behavior and its own guards

### Strategy 4: Deduplication

Two passes:

1. Fingerprint dedup
   - fingerprint = `toolName::stableStringify(sortedArgs)`
   - repeated identical tool invocations collapse to a tombstone that points to the latest result

2. Normalized-content dedup
   - normalize timestamps, UUIDs, hashes, and other unstable tokens
   - collapse near-identical outputs that differ only in volatile values

Default protected tools:
- `write`
- `edit`

Configurable additional protected tools:
- any built-in or custom tool names

### Strategy 5: Error Purging

Old tool errors are replaced with:
`[Error output removed — tool failed more than N turns ago]`

Pi-specific rule:
- recent errors remain untouched
- stale error purging runs in `context`
- do not rely on `tool_result` for error rewriting

### Strategy 6: Background Compression / External Indexing

This is the most Pi-specific adaptation.

Default silent-first behavior:
1. identify stale historical ranges from the raw session-derived context
2. summarize them via an auxiliary model or Pi-compatible summarization helper
3. store summaries in an external JSONL index
4. persist omit-ranges in PCN sidecar state
5. on future `context` calls, filter omitted ranges out of the cloned message list
6. expose only a tiny table-of-contents style reference to the model if enabled

Important:
- this is logically persistent for PCN because omit-ranges are stored in sidecars
- but it does NOT rewrite Pi session history by default
- from the model's perspective, the range is gone

### Optional hybrid compaction mode

If enabled explicitly, PCN may use `session_before_compact` to return a native
`CompactionResult` and participate in Pi's built-in compaction pipeline when the
current context has crossed `nativeCompactionIntegration.maxContextSize`.

That mode is:
- model-visible
- useful for users who want native Pi session compaction semantics
- gated by the configured max-context threshold
- allowed to fall back to Pi's native compaction when the index path fails and `fallbackOnFailure` is true
- not the default silent-first mode

## Index Presentation

When PCN exposes completed-work references, it should use a table-of-contents style view,
not raw summaries injected as ordinary conversation turns.

Example:

```text
3 completed phase(s) indexed:
  - [1-8] project setup: Created initial project structure
  - [9-15] auth system: Implemented OAuth flow
  - [16-22] dashboard: Built SSE-based metrics dashboard
```

The TOC should stay compact and stable.
It must not become a new form of visible compression noise.

## State Management

### SessionState

Per-session runtime tracking:
- `toolCalls: Map<string, ToolRecord>`
- `prunedToolIds: Set<string>`
- `omitRanges: OmitRange[]` — persisted historical ranges hidden from future contexts
- `tokensKeptOutTotal: number`
- `tokensSaved: number`
- `tokensKeptOutByType: Record<string, number>`
- `tokensSavedByType: Record<string, number>`
- `currentTurn: number`
- `countedSavingsIds: Set<string>` — gate keys `${toolCallId}::${strategy}`
- `turnHistory: TurnSnapshot[]`
- `projectPath: string`
- `lastContextTokens: number | null`
- `lastContextPercent: number | null`
- `lastContextWindow: number | null`

### ToolRecord

Per-tool-call metadata:
- `toolCallId: string`
- `toolName: string`
- `inputArgs: unknown`
- `inputFingerprint: string`
- `isError: boolean`
- `turnIndex: number`
- `timestamp: number`
- `tokenEstimate: number`

### OmitRange

Represents a historical region that PCN hides from future request contexts.

Actual fields:
- `startTurn: number`
- `endTurn: number`
- `startOffset: number`
- `endOffset: number`
- `indexedAt: number`
- `summaryRef: string`
- `messageCount: number`

The keying scheme should be based on Pi-stable message/entry correlation where possible,
not Hermes positional assumptions.

## Credit System

Keep HMC's two-counter model:

- `tokensKeptOutTotal`
  - un-gated
  - credits every real per-request savings event
  - primary dashboard/status metric

- `tokensSaved`
  - gated by `(toolCallId, strategy)`
  - diagnostic only

Background indexing credits both counters when a range becomes omitted from future contexts.

## Token Accounting

Two different token concepts must stay separate:

1. Provider/session context usage
   - prefer Pi's own usage-aware logic
   - `getContextUsage()` may return `tokens: null` after compaction until a fresh assistant reply exists
   - telemetry must tolerate unknown post-compaction token counts

2. PCN local savings estimates
   - estimate only what PCN itself rewrites or omits
   - count API-visible message shape only
   - do not count internal analytics/state metadata

Do not mix Hermes's naive length heuristics with Pi's usage-derived context accounting when
reporting session usage.

## Passive System Hint

The passive one-line note should be attached through `before_agent_start`, not by pretending
the `context` hook can edit the system prompt.

Default text:
`Context management is handled automatically in the background. You do not need to manage context yourself.`

This hint should be:
- optional
- stable
- short
- not a description of PCN internals

Hint frequency is tracked in-memory per session only; the hint-application state is not persisted.

## Analytics (SQLite)

SQLite store at `~/.pi-ninja/analytics.db`:
- exact Pi context usage from `getContextUsage()`
- approximate savings from PCN rewrite and omit counters
- WAL mode
- busy timeout
- retention TTL
- one row per `(session, strategy)` at session end or final flush

Dependency:
- `better-sqlite3`

Schema can remain close to HMC, but session identifiers and project-path derivation should
follow Pi runtime/session semantics.

## Dashboard (HTTP + SSE)

Node `http` server, localhost only.

Suggested events:
- `hello`
- `ping`
- `turn`
- `tool`
- `session_end`

Panels:
- current session saved tokens / context % / turns
- lifetime totals
- per-strategy bars
- recent sessions
- live event log

Pi-specific note:
- dashboard cards should display exact context usage separately from approximate savings
- do not invent Hermes phantom-session heuristics unless Pi actually exhibits equivalent noise
- if Pi auxiliary flows do create low-signal sessions or events, filter them based on evidence, not cargo-culted Hermes thresholds

## Config

Config file at `~/.pi-ninja/config.yaml`.

Major blocks:
- `strategies.shortCircuit`
- `strategies.codeFilter`
- `strategies.truncation`
- `strategies.deduplication`
- `strategies.errorPurge`
- `backgroundIndexing`
- `analytics`
- `dashboard`
- `systemHint`
- `nativeCompactionIntegration`

Key defaults:
- `nativeCompactionIntegration.enabled = false`
- `nativeCompactionIntegration.fallbackOnFailure = true`
- `nativeCompactionIntegration.maxContextSize = 0`
- `systemHint.enabled = true`
- `systemHint.frequency = once_per_session`
- `backgroundIndexing.enabled = true`

## Persistence

### Sidecar state

Path:
- `~/.pi-ninja/state/{session}.json`

Requirements:
- atomic writes
- temp-file cleanup on failure
- persist `turnHistory`
- persist `omitRanges`
- persist strategy counters

### Index store

Path:
- `~/.pi-ninja/index/{project}.jsonl`

Requirements:
- append-only JSONL
- one entry per indexed range
- schema roughly:
  `{ turnRange, topic, summary, timestamp, messageCount, indexedAt }`

## Pi-Aligned Execution Pipeline

### Tier 1: immediate hooks

`tool_call`
- fingerprint args
- initialize/update `ToolRecord`
- capture turn association

`tool_result`
- update `ToolRecord` final metadata
- run immediate safe shaping for successful outputs only
- publish telemetry

### Tier 2: full request materialization

`context`
- rebuild current turn index from Pi messages
- apply single-message strategies as safety net
- apply full-list strategies: dedup, stale error purge, omit-range filtering
- compute request-local savings
- return modified `AgentMessage[]`

### Tier 3: request metadata

`before_agent_start`
- append passive system hint when enabled

`before_provider_request`
- observe or pass through provider payloads without mutating them by default

### Tier 4: finalization

`turn_end`
- record exact context usage from Pi
- record approximate savings for analytics/dashboard

`agent_end`
- final telemetry flush
- persist session counters
- record analytics rows

`session_shutdown`
- cleanup, final persistence, dashboard/session closeout

### Optional tier 5: hybrid compaction

`session_before_compact`
- only when `nativeCompactionIntegration.enabled`
- may provide custom `CompactionResult` when the context usage crosses `nativeCompactionIntegration.maxContextSize`
- falls back to Pi native compaction when configured to do so

## Key Design Decisions

1. No backup/restore machinery in the default path.
   Pi cloned-context handling makes Hermes-style shared-message restoration unnecessary.

2. Session history stays raw by default.
   PCN hides history from the model through external omit-ranges and context rewriting,
   not by rewriting Pi session files.

3. `tool_result` is not enough for stale error handling.
   Error purging belongs in `context`.

4. Passive hint belongs in `before_agent_start`.
   `context` modifies messages, not the system prompt.

5. Native compaction integration is optional, not foundational.
   Silent-first PCN should not depend on model-visible compaction entries unless the mode is explicitly enabled.

6. Tool names and roles must be Pi-native.
   Use `toolResult`, `write`, `edit`, and Pi message semantics throughout.

7. Use Pi-aware context usage semantics.
   Treat `tokens: null` after compaction as a valid state, not a bug, and keep exact context usage separate from approximate savings.

## NOT in scope (this version)

- remote MCP server mode
- shared Python/TypeScript source generation
- Hermes ACP bridge mode
- model-specific per-provider compression tuning
- rewriting Pi session history on disk outside explicit hybrid/native-compaction mode

## What Already Exists in Pi (Reusable)

- extension event system in `docs/extensions.md`
- native compaction helpers and summary prompts in `docs/compaction.md` and `src/core/compaction/`
- `custom-compaction.ts` example
- provider payload interception in `sdk.ts`
- `context` cloning behavior in `extensions/runner.ts`
- context-usage estimation / usage-aware accounting in Pi compaction/session code

## Implementation Order

1. Extension shell in `index.ts`
2. `state.ts` with `SessionState`, `ToolRecord`, `OmitRange`
3. `messages.ts` role/tool normalization helpers
4. `strategies/short-circuit.ts`
5. `strategies/truncation.ts`
6. `strategies/dedup.ts`
7. `strategies/error-purge.ts`
8. `normalizer.ts`
9. `code-filter/`
10. `strategies/materialize.ts`
11. `compression/range-selection.ts`
12. `compression/index-entry.ts`
13. `compression/summarizer.ts`
14. `persistence/`
15. `config.ts`
16. `analytics/`
17. `dashboard/`
18. optional `session_before_compact` hybrid integration
19. README + config example
20. full test pass

## Test Plan

- `test/short-circuit.test.ts`
- `test/code-filter.test.ts`
- `test/truncation.test.ts`
- `test/dedup.test.ts`
- `test/error-purge.test.ts`
- `test/materialize.test.ts`
- `test/state.test.ts`
- `test/normalizer.test.ts`
- `test/persistence.test.ts`
- `test/analytics.test.ts`
- `test/dashboard.test.ts`
- `test/pi-hook-mapping.test.ts` — `tool_call`, `tool_result`, `context`, `before_agent_start`
- `test/native-compaction-hybrid.test.ts` — optional mode only
- `test/integration.test.ts` — end-to-end pruned-view behavior across multiple turns

High-value edge cases:
- `tool_result` error outputs remain raw immediately, then purge later in `context`
- repeated `read` / `grep` collapse correctly
- `write` and `edit` are protected
- omit-ranges persist across reloads
- post-compaction `getContextUsage()` unknown state does not break telemetry
- JSX bailout does not trigger on TS generics

## Dependencies

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "@mariozechner/pi-coding-agent": "workspace:*",
    "@types/better-sqlite3": "^7.6.0",
    "vitest": "^2.0.0",
    "typescript": "^5.5.0"
  }
}
```

## Author

Shawn McAllister <https://x.com/entrepeneur4lyf>
