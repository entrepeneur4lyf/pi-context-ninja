# Pi Context Ninja

Silent-first context freshness extension for [oh-my-pi](https://omp.sh).

PCN keeps the model's request context short and fresh. Repeated outputs,
stale errors, and oversized results are rewritten before each request,
and every kept-out token is credited to the strategy that removed it.
The model sees a shorter, fresher context and at most one passive hint
per session. It never sees a compression workflow.

## Install

```bash
omp install github:entrepeneur4lyf/pi-context-ninja
```

oh-my-pi discovers the extension through the `omp.extensions` manifest in
`package.json` and loads it on the next start. Check it with:

```text
/pcn status
```

## Local development

Requires Bun 1.3.14 or newer.

```bash
bun install
omp --plugin-dir .           # run one session with this checkout loaded
```

## Runtime model

PCN has two layers:

- **Control plane**: the `/pcn` command and the project control state.
  Available whenever the extension is loaded, even when the data plane
  failed to start, so `/pcn doctor` can always say what is wrong.
- **Data plane**: the hook runtime. It records tool provenance, shapes
  tool results, credits kept-out tokens, records analytics, and serves
  the dashboard.

Project control state lives in marker files under `<project>/.omp/pcn/`:

- default: enabled
- `.pcn_disabled`: PCN is off for this project
- `.pcn_dashboard_disabled`: the dashboard is off for this project

Session state travels with the host session as a custom entry of type
`com.pcn.session-state`. Branches, forks, and resumes carry PCN's
bookkeeping with the conversation. PCN writes no state files of its own.

## Configuration

The config file is `<agent-dir>/pcn/config.yaml`, where the agent
directory is `~/.omp/agent` or `PI_CODING_AGENT_DIR`. Set `PCN_CONFIG_PATH`
to use another file. Every key is optional; these are the defaults:

```yaml
strategies:
  shortCircuit:
    enabled: true
    maxTokens: 2000          # longer results are never short-circuited
  codeFilter:
    enabled: false           # opt in; strips function bodies over maxBodyLines
    keepDocstrings: true
    maxBodyLines: 200
    keepImports: true
  truncation:
    enabled: true
    headLines: 100
    tailLines: 50
    minLines: 300
  deduplication:
    enabled: true
    maxOccurrences: 2
  errorPurge:
    enabled: true
    maxTurnsAgo: 3

shaping:
  # Tools whose results no strategy ever rewrites.
  protectedTools:
    - write
    - edit
    - task

analytics:
  enabled: true
  dbPath: ""                 # default: <project>/.omp/pcn/analytics.sqlite
  retentionDays: 30

dashboard:
  enabled: true
  shortcut: "alt+n"          # host key id that opens the overlay

systemHint:
  enabled: true
  text: "Context management is handled automatically in the background. You do not need to manage context yourself."
  frequency: "once_per_session"   # or "always", "on_change"
```

Unknown keys are dropped without error.

## Strategies

At request time (the host's `context` hook), each tool result with a
single text block passes through, in this order:

1. **Error purge**: an error result older than `maxTurnsAgo` turns becomes
   a one-line notice. No other strategy touches error results.
2. **Short circuit**: a small success payload (`{"status":"ok"}`,
   `12 passed`, `Already up to date`, `file written`) becomes a one-line
   notice, when the result is at most `maxTokens` long.
3. **Code filter** (opt-in): function bodies over `maxBodyLines` are
   dropped while signatures, imports, and docstrings stay.
4. **Truncation**: results of at least `minLines` lines keep their head and
   tail with an omitted-lines marker.
5. **Deduplication**: content seen more than `maxOccurrences` times in the
   same request becomes a notice pointing at the earlier copy.

Short circuit and truncation also run once at `tool_result` time; the host
stores that shaped result.

Some results are never rewritten:

- results of the `read` tool, because the next `edit` needs their line
  anchors;
- any result carrying a hashline header (`[path#hash]`);
- results of the tools in `shaping.protectedTools`;
- results the host has already pruned (`prunedAt` set).

oh-my-pi's own compaction, age-based pruning, and superseded-read
handling keep running underneath. PCN complements them and does not
replace them.

## Dashboard

PCN draws on two host surfaces and opens no network port.

- A status-line item, `pcn 12.3k kept out`, shows the session's kept-out
  tokens and refreshes after every turn.
- An overlay opens over the transcript on `/pcn dashboard` or the
  `dashboard.shortcut` key (default `alt+n`). It shows context usage,
  kept-out totals per session, project, and lifetime, per-strategy
  totals, and the most recent impact events. It refreshes while open and
  closes on Escape or `q`.

Figures are approximate (characters divided by four) until the host
tokenizer lands. When the analytics store is unavailable, the overlay
says so and shows the live session counters only. Headless, RPC, and ACP
modes skip both surfaces. Disable the dashboard per project with
`/pcn disable dashboard`, or globally with `dashboard.enabled: false`.

## Files

| Location | Contents |
| --- | --- |
| `<project>/.omp/pcn/` | control markers, `analytics.sqlite`, `reports/` |
| `<agent-dir>/pcn/config.yaml` | configuration |
| host session file | PCN session state as custom entries |

## Commands

| Command | Description |
| --- | --- |
| `/pcn status` | Mode, config path, and whether the dashboard is active |
| `/pcn doctor` | Diagnostics, including any degraded reasons |
| `/pcn export` | Write the doctor report to `<project>/.omp/pcn/reports/` |
| `/pcn dashboard` | Open the dashboard overlay |
| `/pcn enable` / `/pcn disable` | Turn PCN on or off for this project |
| `/pcn enable dashboard` / `/pcn disable dashboard` | Turn the dashboard on or off for this project |

## Project structure

```
pi-context-ninja/
├── src/
│   ├── index.ts                  # Extension entry: /pcn first, then the data plane
│   ├── config.ts                 # YAML config and defaults
│   ├── paths.ts                  # Agent, user, and project directories
│   ├── state.ts                  # Session state and kept-out credits
│   ├── types.ts                  # Shared types
│   ├── messages.ts               # Tool result text helpers
│   ├── normalizer.ts             # Fingerprint normalization
│   ├── control/                  # /pcn command, markers, status, doctor, export
│   ├── runtime/
│   │   └── create-extension-runtime.ts   # Hook handlers and session lifecycle
│   ├── strategies/               # protection, materialize, safe-shaping, and the five strategies
│   ├── persistence/
│   │   └── session-entries.ts    # Session state as host custom entries
│   ├── analytics/                # bun:sqlite store and types
│   └── dashboard/                # Status-line item and overlay on the host UI
├── test/                         # bun:test, one file per module
├── docs/                         # local working documents, not tracked
└── package.json
```

## Verification

```bash
bun run check                        # typecheck, then all tests
bun test test/runtime-hooks.test.ts  # the host boundary
omp --plugin-dir .                   # then /pcn doctor inside the session
```
