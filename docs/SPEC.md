# Pi Context Ninja — Full Spec

Silent-first context optimization extension for Pi, ported from HMC (Hermes Context Manager).

## Origin

HMC was designed after watching Pi Dynamic Context Pruning drive GLM 5.1 up
the wall — re-compressing already-compressed bundles, spamming tags into the
chat, making the model aware of compression it couldn't control. GLM said in
its thinking block: "Those stale bundles have been inserted AGAIN."

Pi Context Ninja exists so no model ever says that again.

## Core Principle

**Silent-first.** The model never sees compression happening. No tags in
content. No compression tools advertised. No stale bundles re-inserted.
Strategies are idempotent. The model sees a shorter, cleaner conversation
and a one-liner system hint. That's it.

## Pi Extension API Surface

Pi's extension system provides exactly the hooks needed:

| Hook | Pi Event | What PCN does | Return type |
|------|----------|---------------|-------------|
| pre_tool_call | `tool_call` | Fingerprint inputs, record metadata | `{ block?: boolean }` (passthrough) |
| post_tool_call | `tool_result` | Run single-message strategies, return compressed content | `{ content?: ..., isError?: boolean }` |
| pre_llm_call | `context` | Full materialize_view pipeline, return modified message list | `{ messages?: AgentMessage[] }` |
| compaction | `session_before_compact` | Replace default compaction with HMC's background compression | `{ compaction?: CompactionResult }` |

### Critical difference from Pi Dynamic Context Pruning

Pi DCP injected compressed bundles BACK INTO the conversation as messages.
PCN DELETES the compressed range and stores the summary EXTERNALLY in an
index file. Nothing is re-inserted. Nothing goes stale. The model sees a
table of contents, not the summaries:

```
3 completed phase(s) indexed:
  - [1-8] project setup: Created initial project structure
  - [9-15] auth system: Implemented OAuth flow
  - [16-22] dashboard: Built SSE-based metrics dashboard
```

## Architecture

```
pi-context-ninja/
  src/
    index.ts                    # Extension entry point + hook wiring
    state.ts                    # SessionState, ToolRecord, fingerprinting
    config.ts                   # Config loading (YAML or inline defaults)
    normalizer.ts               # Content normalization for dedup
    strategies/
      short-circuit.ts          # Pattern matching → one-liner replacements
      code-filter.ts            # Code-aware body stripping (Python/Rust/Go/JS/TS)
      truncation.ts             # Head/tail windowing with gap marker
      dedup.ts                  # Fingerprint + content-hash dedup
      error-purge.ts            # Stale error removal by turn age
      pruning.ts                # Tombstone replacement (dedup + error items)
      index.ts                  # materialize_view pipeline orchestrator
    code-filter/
      line-scanner.ts           # String-aware brace counter
      python-filter.ts          # Indentation-aware Python body stripping
      brace-filter.ts           # Rust/Go/JS/TS body stripping
      jsx-detection.ts          # JSX bailout detection
      language-detection.ts     # File extension + content sniffing
    analytics/
      store.ts                  # SQLite-backed cumulative savings (better-sqlite3)
      types.ts                  # SavingsSummary, KNOWN_STRATEGIES
    dashboard/
      server.ts                 # HTTP+SSE server (Node http module)
      event-bus.ts              # Fan-out to SSE subscribers
      page.ts                   # Inline HTML dashboard (same dark theme)
    persistence/
      state-store.ts            # JSON sidecar persistence (~/.pi-ninja/state/)
      index-store.ts            # Phase index JSONL persistence
  package.json
  tsconfig.json
  README.md
```

## Six Compression Strategies

All strategies are silent-first. No model awareness. No tags. No bundles.

### Strategy 1: Short-Circuit Pattern Matching

Replaces tool outputs matching known success patterns with one-liners.

**Patterns (ported from HMC's short_circuits.py):**
- JSON success: `{"status": "ok", ...}` → `[ok]`
- Test results: `=== N passed ===` → `[tests: N passed]`
- Git output: `Already up to date` → `[git: up to date]`
- File write confirmations → `[file written: path]`

**Guard:** Global error indicator regex prevents short-circuiting error content.
Errors are NEVER short-circuited — preserve full detail for debugging.

### Strategy 2: Code-Aware Compression

Strips function/class/struct bodies from source code, preserving:
- Signatures (function names, parameters, return types)
- Imports
- Top-level constants
- Docstrings (optionally)

**Language support:**
- **Python:** Indentation-aware. Class doesn't enter body mode; methods
  individually filtered. Preserves triple-quote docstrings.
- **Rust/Go/JS/TS:** String-aware brace counter (`_LineScanner` port).
  `"hello {world}"` doesn't corrupt depth tracking. Multi-line signature
  handling (accumulate continuation lines until opening brace).
- **JSX/TSX:** Bailout when React components detected. Requires unambiguous
  markers: closing tag `</Component>`, self-close `<Component />`, or
  attribute `<Component prop=`. NOT triggered by TS generics like
  `Promise<Response>` or `Array<string>`.

**Detection order:** Tool-arg file extension (most reliable) → fenced markdown
tag → content sniffing.

**Config:** `min_lines: 30`, `preserve_docstrings: true`, `languages: [python, javascript, typescript, rust, go]`

### Strategy 3: Head/Tail Truncation

Long tool outputs keep first N and last M lines with a gap marker:

```
line 1
line 2
...
line N
... [X lines omitted] ...
line (total - M + 1)
...
line total
```

**Config:** `max_lines: 50`, `head_lines: 10`, `tail_lines: 10`, `min_content_length: 500`

**Note:** Pi has built-in `truncateHead`/`truncateTail` utilities. PCN needs
head+tail (both ends). Port HMC's implementation, can use Pi's utilities as
building blocks for each half.

### Strategy 4: Deduplication

**Pass 1 — Fingerprint dedup:** Tool calls fingerprinted as
`tool_name::JSON.stringify(sortedArgs)`. Repeated reads of the same file,
identical grep calls, etc. collapse to:
`[Output removed — tool called N× with same args, showing last result only]`

**Pass 2 — Content-hash dedup:** Normalized content hashing so near-identical
outputs (differing only in timestamps, UUIDs, hex hashes) also collapse.
Normalization replaces timestamps, UUIDs, and hex sequences with placeholders.

**Protected tools:** `write_file` and `patch` are ALWAYS protected from dedup.
User-configurable additional protected tools.

### Strategy 5: Error Purging

Tool errors older than N turns are replaced with:
`[Error output removed — tool failed more than N turns ago]`

**Config:** `turns: 4`, `protected_tools: []`

Errors within the last N turns are NEVER purged — preserve full detail for
active debugging.

### Strategy 6: Background Compression

Triggers when context crosses a configurable threshold (default 80%).
Uses Pi's `session_before_compact` hook to replace the default compaction.

1. Identify stale ranges (contiguous completed work, protecting recent turns)
2. Summarize via auxiliary model (or Pi's configured summarization model)
3. Store summary in external index file (`~/.pi-ninja/state/{session}_index.jsonl`)
4. DELETE the compressed range from the conversation (not re-insert as bundle)
5. System context references the index as a table of contents

**Config:** `max_context_percent: 0.8`, `protect_recent_turns: 3`

## State Management

### SessionState

Per-session runtime tracking:
- `toolCalls: Map<string, ToolRecord>` — per-tool-call metadata
- `prunedToolIds: Set<string>` — IDs marked for tombstoning
- `tokensKeptOutTotal: number` — un-gated real savings accumulator
- `tokensSaved: number` — gated per-(id, strategy) diagnostic counter
- `tokensKeptOutByType: Record<string, number>` — per-strategy breakdown
- `currentTurn: number` — rebuilt from messages each call
- `countedSavingsIds: Set<string>` — gate keys as `${toolCallId}::${strategy}`
- `turnHistory: TurnSnapshot[]` — bounded ring buffer (50 entries)
- `projectPath: string` — canonical cwd

### ToolRecord

Per-tool-call metadata:
- `toolCallId: string`
- `toolName: string`
- `inputFingerprint: string` — `tool_name::JSON.stringify(sortedArgs)`
- `isError: boolean`
- `turnIndex: number`
- `timestamp: number`
- `tokenEstimate: number`

### Credit System

Two accumulators, same design as HMC 0.3.1+:

- `tokensKeptOutTotal` (un-gated): Every strategy firing credits this.
  The dashboard and status surface lead with this number.
- `tokensSaved` (gated by `countedSavingsIds`): Each `(toolCallId, strategy)`
  pair credits at most once per session. Diagnostic only.

Both credited via a single `creditSavings(state, toolCallId, strategy, saved)`
helper, same as HMC's `_credit_savings`.

## Analytics (SQLite)

SQLite store at `~/.pi-ninja/analytics.db`:
- WAL journal mode (set on init, verified)
- `busy_timeout = 5000`, `synchronous = NORMAL` per connection
- On-write 90-day retention TTL
- One row per `(session, strategy)` at session end

**Dependency:** `better-sqlite3` (native, synchronous API, well-maintained).

Schema matches HMC:
```sql
CREATE TABLE IF NOT EXISTS pcn_savings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT    NOT NULL,
    session_id      TEXT    NOT NULL,
    project_path    TEXT    NOT NULL DEFAULT '',
    strategy        TEXT    NOT NULL,
    saved_tokens    INTEGER NOT NULL,
    session_input   INTEGER NOT NULL,
    session_output  INTEGER NOT NULL
);
```

Query API: `getSummary`, `getByDay`, `getByMonth`, `getRecentSessions`, `getByProject`.

## Dashboard (HTTP+SSE)

Stdlib-only HTTP server (Node `http` module). Same architecture as HMC:
- Localhost-only (`127.0.0.1`)
- Base port 48900 with rotation (avoid collision with HMC at 48800)
- SSE events: `hello`, `ping`, `turn`, `tool`, `session_end`
- Safety-net poll every 10s
- Dark theme, inline CSS/JS, no external deps
- All dynamic values via `textContent` + `createElement` (no innerHTML)

**Panels:**
- Current session: saved, context %, turns
- Lifetime: all-time saved, sessions, % of input
- Savings by strategy: per-strategy bars
- Recent sessions (workhorses): table with short ID, time, ctx%, tools, saved, breakdown
- Live events: streaming log

## Config

YAML config file at `~/.pi-ninja/config.yaml` (or inline defaults).
Uses same structure as HMC's `config.yaml.example`.

Auto-discovery: on first load, copies `config.yaml.example` from the
extension directory if no config exists.

## Persistence

JSON sidecars at `~/.pi-ninja/state/{session}.json`:
- Atomic writes via temp file + rename
- Temp-file cleanup on exception
- Turn history persisted (learned lesson from HMC 0.3.3)

Phase index at `~/.pi-ninja/state/{session}_index.jsonl`:
- Append-only JSONL
- One entry per compressed range
- Schema: `{ turnRange, topic, summary, timestamp, messageCount }`

## Two-Tier Compression

Same architecture as HMC 0.3.4+:

| Hook | Strategies that run | When it fires |
|------|--------------------|---------------|
| `tool_result` | short_circuit, code_filter, truncation | After each tool call |
| `context` | short_circuit, code_filter, truncation, dedup, error_purge, pruning | Before each LLM call |
| `session_before_compact` | background_compression | When Pi triggers compaction |

Single-message strategies fire on BOTH `tool_result` (immediate, per-tool) AND
`context` (safety net, full conversation). Full-list strategies (dedup,
error_purge) need the whole conversation and fire on `context` only.

## Key Design Decisions (from HMC's bug history)

1. **No message-ID tags in content.** HMC 0.3.2 removed these after verifying
   that GLM-5.1 echoed them at the start of 32% of assistant replies. PCN
   never introduces them.

2. **Turn history persisted in state sidecars.** HMC 0.3.3 learned this the
   hard way — delta_saved was reporting cumulative as per-turn delta because
   the ring buffer was lost on state reload.

3. **Empty session_id guard.** HMC 0.3.3 found phantom `.json` files from
   hooks called with empty session_id. Guard early, return throwaway state.

4. **Phantom session filter.** Auxiliary workers (title gen, compression)
   have tiny contexts and no tools. Don't promote them to active_session_id,
   don't publish their events to the dashboard.

5. **Lazy content backup.** HMC 0.3.6 switched from upfront backup of all
   messages to copy-on-mutate. Only messages actually touched by a strategy
   get backed up. PCN does the same.

6. **Final materialize on session end.** HMC 0.3.5 runs one last compression
   pass at session end to catch tool outputs that arrived after the last
   pre_llm_call. PCN does this in the `agent_end` or equivalent event.

7. **Token estimation: count what ships.** Serialize only API-visible fields
   (role, content, tool_calls, tool_call_id, name) and divide by 4. Don't
   count internal metadata like timestamps.

## NOT in scope (this version)

- MCP server mode (PCN as a remote service)
- The CodeCraft DSL for model-driven disposition
- Cross-platform shared strategy library (Python + TS from same source)
- Hermes ACP bridge mode
- Model-specific tuning (different compression for different models)

These are real future directions, not deferred shortcuts.

## What Already Exists (reusable from Pi)

- `truncateHead` / `truncateTail` utilities from Pi's built-in tools
- `serializeConversation` / `convertToLlm` from Pi's compaction utils
- `estimateTokens` from Pi's compaction module
- `SUMMARIZATION_SYSTEM_PROMPT` from Pi's compaction utils
- `custom-compaction.ts` example as the template for session_before_compact

## Implementation Order

1. Extension shell (`index.ts`) with 4 hook handlers wired
2. `state.ts` — SessionState + ToolRecord + fingerprinting
3. `strategies/short-circuit.ts` — regex patterns + error guard
4. `strategies/truncation.ts` — head/tail windowing
5. `strategies/dedup.ts` — fingerprint + content-hash
6. `strategies/error-purge.ts` — turn-based staleness
7. `strategies/pruning.ts` — tombstone replacement
8. `normalizer.ts` — timestamp/UUID/hex replacement
9. `code-filter/` — the full parser suite (line-scanner, python, brace, jsx, detection)
10. `strategies/index.ts` — materialize_view pipeline orchestrator
11. `persistence/` — JSON sidecar + index JSONL
12. `config.ts` — YAML config loading with defaults
13. `analytics/` — SQLite store with WAL
14. `dashboard/` — HTTP+SSE server + inline HTML page
15. Tests for each module
16. README + config.yaml.example

## Test Plan

Tests for every module, matching HMC's test coverage (254 tests):

- `test/short-circuit.test.ts` — pattern matching, error guard, edge cases
- `test/code-filter.test.ts` — each language, JSX bailout, multi-line sigs, string-aware braces
- `test/truncation.test.ts` — head/tail, min_content_length guard, error exemption
- `test/dedup.test.ts` — fingerprint, content-hash, protected tools, cross-strategy stacking
- `test/error-purge.test.ts` — turn threshold, protected tools
- `test/state.test.ts` — serialization round-trip, turn_history persistence, credit gating
- `test/normalizer.test.ts` — timestamp/UUID/hex replacement
- `test/analytics.test.ts` — WAL mode, concurrent access, retention TTL
- `test/dashboard.test.ts` — SSE events, port rotation, phantom filter
- `test/config.test.ts` — YAML loading, defaults, partial override
- `test/integration.test.ts` — full pipeline end-to-end

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
