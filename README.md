# Pi Context Ninja

Silent-first context optimization extension for Pi 0.67.2.

Reduces context window usage automatically by compressing, deduplicating, and pruning tool results — with zero disruption to agent behavior.

## Usage

```bash
pi --extension src/index.ts
```

The extension is configured via an optional YAML file (default: `~/.pi-ninja/config.yaml`). Set a custom path with `PCN_CONFIG_PATH`.
This build targets Pi 0.67.2 directly and uses the real `tool_call`, `tool_result`, `context`, `before_agent_start`, `before_provider_request`, `turn_end`, `agent_end`, `session_before_compact`, and `session_shutdown` hooks.

## Configuration

```yaml
# ~/.pi-ninja/config.yaml
strategies:
  shortCircuit:
    enabled: true
    minTokens: 8000

  codeFilter:
    enabled: true
    keepDocstrings: true
    maxBodyLines: 200
    keepImports: true

  truncation:
    enabled: true
    headLines: 100
    tailLines: 50
    minLines: 300
    strategy: "head_tail"  # or "smart"

  deduplication:
    enabled: true
    maxOccurrences: 2
    protectedTools:
      - write
      - edit

  errorPurge:
    enabled: true
    maxTurnsAgo: 3
    patterns: []

# Background index of file ranges for prune hints
backgroundIndexing:
  enabled: true
  minRangeTurns: 8
  maxFiles: 50
  debounceMs: 2000

# Token savings analytics stored in SQLite
analytics:
  enabled: true
  dbPath: ""
  retentionDays: 30

# Web dashboard
dashboard:
  enabled: true
  port: 48900
  bindHost: "127.0.0.1"

# Optional native compaction integration
nativeCompactionIntegration:
  enabled: false
  fallbackOnFailure: true
  maxContextSize: 32768

# System hint injected into sessions
systemHint:
  enabled: true
  text: "Context management is handled automatically in the background. You do not need to manage context yourself."
  frequency: "once_per_session"
```

## Strategies

The compression pipeline applies six strategies in order to each tool result message:

1. **Short Circuit** — Replaces empty or trivial tool results with a compact placeholder.
2. **Code Filter** — Strips code bodies beyond a threshold while preserving signatures, imports, and docstrings.
3. **Truncation** — Head/tail truncation for oversized content, keeping relevant context at both ends.
4. **Deduplication** — Fingerprint-based dedup that collapses repeated tool results beyond a configurable occurrence count.
5. **Error Purge** — Replaces stale error outputs (older than N turns) with minimal tombstones.
6. **View-Layer Pruning** — Applies omit-ranges from the background index to surgically remove unreferenced file content at the message level.

## Dashboard

The analytics dashboard is optional observability. It shows the current session's exact Pi context percentage, approximate tokens kept out, turn count, and a live event log.

```
http://127.0.0.1:48900
```

Enabled by default. Change the port or bind address in the config, or disable it entirely when you want silent-only operation.

## Architecture

Pi Context Ninja operates as a **view-layer pruning** extension via Pi's `context` hook. It intercepts the message list before it is materialized into the model's context window, applying transformations in-place without modifying the conversation history. The agent sees the same conversation; only the context window payload is compressed.

```
User/Agent  ──→  Pi Core  ──→  context hook  ──→  [Pruned/Compressed Messages]  ──→  LLM
```

## Project Structure

```
pi-context-ninja/
├── src/
│   ├── index.ts              # Extension entry point
│   ├── config.ts             # YAML config loading + defaults
│   ├── state.ts              # Session state management
│   ├── types.ts              # Shared TypeScript types
│   ├── messages.ts           # Message content extraction/replacement
│   ├── normalizer.ts         # Content normalization utilities
│   ├── strategies/
│   │   ├── materialize.ts    # Pipeline orchestrator
│   │   ├── short-circuit.ts  # Strategy 1: skip empty results
│   │   ├── code-filter.ts    # Strategy 2: strip code bodies
│   │   ├── truncation.ts     # Strategy 3: head/tail truncate
│   │   ├── dedup.ts          # Strategy 4: fingerprint dedup
│   │   ├── error-purge.ts    # Strategy 5: purge old errors
│   │   └── pruning.ts        # Strategy 6: view-layer omit ranges
│   ├── compression/
│   │   ├── summarizer.ts     # Summarizer for range content
│   │   ├── range-selection.ts # Range selection heuristics
│   │   └── index-entry.ts    # Index entry model
│   ├── persistence/
│   │   ├── index-store.ts    # SQLite-backed range index
│   │   └── state-store.ts    # Session state persistence
│   ├── analytics/
│   │   ├── store.ts          # Analytics SQLite store
│   │   └── types.ts          # Analytics event types
│   └── dashboard/
│       ├── server.ts         # HTTP dashboard server
│       └── pages.ts          # Dashboard page templates
├── test/
│   ├── materialize.test.ts
│   ├── dedup.test.ts
│   ├── pruning.test.ts
│   ├── error-purge.test.ts
│   ├── range-selection.test.ts
│   ├── analytics.test.ts
│   ├── index-store.test.ts
│   ├── state-store.test.ts
│   └── index-entry.test.ts
└── package.json
```

## Commands

| Command | Description |
| --- | --- |
| `npm run typecheck` | TypeScript type checking |
| `npm run test` | Run test suite |
| `npm run test:watch` | Run tests in watch mode |
