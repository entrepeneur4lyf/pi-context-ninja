# Pi Context Ninja Remediation Design

## Goal

Rebuild Pi Context Ninja as a correct, fully implemented Pi `0.67.2` extension that reduces context noise without corrupting conversation truth, while preserving the current public surface unless a change is justified by direct code evidence.

## Scope And Constraints

Pi Context Ninja remains a silent-first product. Its default behavior is to reduce what enters the model context through Pi's request-time `context` hook rather than by mutating stored conversation history or by creating visible compression chatter. Visible extension output is allowed only when it materially improves correctness, observability, or operator control, and only when it does not create recurring conversational noise.

The implementation target is Pi `0.67.2` specifically. This design does not spend scope on speculative forward-compatibility abstraction. Pi's current source is the contract of record, especially `packages/coding-agent/src/core/extensions/types.ts`, `runner.ts`, and the current message models in `packages/ai/src/types.ts` and `packages/agent/src/types.ts`.

The default posture is to preserve the current public surface: strategy names, config blocks, README-promised subsystems, and the high-level "silent-first context optimization" product story. A feature, config option, or workflow is only eligible for trim if the design cites all of the following inline:

- where it is declared in `pi-context-ninja`
- whether it is consumed in runtime code
- whether Pi `0.67.2` offers a correct integration point for it
- why keeping it would add ambiguity, broken behavior, or focus-harming noise

At spec time, no surface-area trims are approved by default. The current repo contains many dead or partially wired features, but most of them have plausible Pi `0.67.2` integration points. The design therefore treats them as implementation obligations unless later evidence proves otherwise.

## Evidence Summary

The current implementation does not meet Pi `0.67.2`'s runtime contract.

- Hook handlers in `src/index.ts` are written as `(ctx, event)` at lines `34`, `47`, `56`, `62`, and `69`, but Pi defines handlers as `(event, ctx)` in `packages/coding-agent/src/core/extensions/types.ts:981`.
- `before_agent_start` returns `{ systemHint }` in `src/index.ts:62-66`, but Pi `0.67.2` expects `BeforeAgentStartEventResult` with `systemPrompt` and/or `message` in `packages/coding-agent/src/core/extensions/types.ts:911-915`.
- `messages.ts` assumes `AgentMessage` always has `content` at `src/messages.ts:87-102`, while Pi's `AgentMessage` includes custom message unions at `packages/agent/src/types.ts:245`.
- `replaceToolContent()` in `src/messages.ts:130-137` rewrites the full content array, but Pi tool results explicitly support mixed text/image payloads in `packages/ai/src/types.ts:203-210`.
- Deduplication is nonfunctional because the runtime fingerprint defaults to ``${toolName}::${toolCallId}`` in `src/strategies/materialize.ts:95-103`, and there is no production path that sets `__pcnFingerprint` or calls `normalizeContent()`. Search confirms `normalizeContent()` is only used in tests.
- Turn aging is inaccurate because `currentTurn` is incremented once per `agent_end` in `src/index.ts:69-73`, while Pi exposes real `turn_start` and `turn_end` events with turn indices in `packages/coding-agent/src/core/extensions/types.ts:563-576`.
- Background indexing, analytics, and dashboard are documented in `README.md` and `docs/SPEC.md`, but the runtime search shows no call sites for `startDashboardServer`, `broadcastEvent`, `appendIndexEntry`, `readIndexEntries`, `selectStaleRanges`, or `extractTopicFromRange`.

Local verification confirms the gap:

- `rtk npm run typecheck` fails against current Pi types.
- `rtk npm test` passes, but the tests lean heavily on `as any` and do not cover the real Pi hook boundary.

## Product Model

The end-state product is organized into three explicit feature classes.

### 1. Core Silent-First Features

These must be fully implemented and supported:

- request-time context materialization through Pi's `context` hook
- safe tool-result shaping/compression for supported result types
- stale error reduction with correct turn accounting
- deduplication based on repeated normalized content, not per-call IDs
- range-based pruning backed by an actual index
- measurable context/usage analytics grounded in real runtime observations

### 2. Optional But Real Platform Features

These may remain configurable, but if they stay in the public surface they must be wired, tested, and documented:

- dashboard server
- live event broadcasting
- optional prompt guidance or visible extension messaging
- provider payload interception
- optional native compaction integration through `session_before_compact`

### 3. Trim Candidates

A config key or subsystem only becomes a trim candidate if it fails the evidence test above. Dead config alone is not sufficient if Pi `0.67.2` gives us a sound way to make it real. This matters because several current keys are declared but unused, including `minTokens`, `maxBodyLines`, `keepImports`, `maxOccurrences`, `frequency`, `fallbackOnFailure`, and `maxContextSize`. The rewrite must either wire each surviving field or remove it with proof.

## Runtime Architecture

The implementation is split into four layers.

### Pi Hook Adapter Layer

This is a thin typed integration layer that owns Pi event subscription and nothing else. It loads config, constructs the runtime container, and registers Pi `0.67.2` hooks using the real `(event, ctx)` contract. Supported hooks are:

- `tool_call`
- `tool_result`
- `context`
- `turn_end`
- `before_agent_start`
- `before_provider_request`
- `session_before_compact`
- `agent_end`
- `session_shutdown`

The current `src/index.ts` should be reduced to this adapter role. Business logic must move out so future Pi API drift is localized.

### Materialization Pipeline

This layer owns request-time context shaping. It receives the cloned `AgentMessage[]` that Pi provides through `context` and applies ordered transforms only to supported message classes. It must preserve assistant tool-call semantics, handle custom agent messages defensively, and explicitly distinguish text-only tool results from mixed-content tool results.

### State, Index, And Analytics Layer

State is split by responsibility:

- session state for turn/tool bookkeeping
- range index storage for stale-range pruning
- analytics storage for cumulative and per-turn measurements

Persisted state must contain only fields that have a post-write consumer. The current store in `src/persistence/state-store.ts:87-166` persists only a subset of `SessionState`, which is insufficient for deterministic behavior after restart.

### Observability Layer

Dashboard, SSE broadcast, and visible status messaging are optional consumers of internal events. They must not be hidden dependencies of pruning behavior.

## Correctness Rules

1. **Pi is the runtime contract.** Hook signatures, event payloads, and message models come from Pi `0.67.2` source, not prior assumptions.
2. **Conversation truth is preserved.** Silent-first pruning changes the model-facing view, not stored history.
3. **No mixed-content loss.** Text transforms may not drop image payloads or other supported tool-result content.
4. **Turn-aware features use Pi turns.** Aging, indexing, and turn metrics are driven from `turn_end` and Pi turn indices, not synthetic counters on `agent_end`.
5. **Every metric must mean something exact or be labeled approximate.** If a figure is character-based rather than token-based, it must be labeled that way.
6. **A feature is not implemented unless it is wired, exercised, and verified.** Disk presence is not evidence.

## End-State Subsystems

### Hook Integration

Owns Pi event registrations and dispatch into internal services. This subsystem also owns optional integration with `before_provider_request` and `session_before_compact`, because Pi `0.67.2` exposes both hooks directly in `packages/coding-agent/src/core/extensions/types.ts:998-1011`.

### Message Classification

Provides typed helpers for:

- `ToolResultMessage`
- user messages
- assistant messages
- custom agent messages
- text-only versus mixed-content tool results

This replaces the current blunt helper model in `src/messages.ts`.

### Compression Strategies

Each strategy must declare:

- applicability conditions
- whether it is safe in `tool_result`, `context`, or both
- whether it is lossy
- which metrics it emits

Strategies in scope:

- short-circuit
- code-aware reduction
- truncation
- deduplication
- stale-error reduction
- indexed range pruning

### Indexing And Range Pruning

Owns stale-range selection, summary/index record generation, omit-range persistence, and omit-range application. This subsystem must have a real producer path for `omitRanges`, not just the current consumer in `src/strategies/pruning.ts:231-270`.

### Analytics

Owns retention, storage, and reporting of:

- exact context-usage snapshots when Pi exposes them through `ctx.getContextUsage()`
- approximate savings metrics when only transform deltas are available
- per-turn and cumulative strategy effects

If SQLite remains in scope, `better-sqlite3` must become a real dependency of the analytics subsystem rather than a declared but unused package.

### Observability

Owns dashboard serving and runtime event broadcast. Safe defaults are required: local binding by default, no unauthenticated remote exposure by surprise, and full separation from core shaping logic.

## Concrete Remediation Decisions

### 1. Replace The Entrypoint With A Thin Adapter

`src/index.ts` becomes a registration shell. Hook-specific orchestration moves into dedicated runtime services.

### 2. Use Pi's Real Turn Model

`turn_end` becomes the source of truth for turn advancement, stale-error age, and index aging. `agent_end` remains for end-of-loop flushing only.

### 3. Redefine Deduplication

Dedup fingerprints are built from normalized tool-result content plus relevant tool identity. `toolCallId` alone is insufficient because it guarantees uniqueness.

### 4. Make Mixed-Content Handling Explicit

If a tool result contains images and text, either:

- rewrite only text blocks and preserve images, or
- skip unsafe transforms entirely

The current whole-array replacement model is not acceptable.

### 5. Promote Config To A Runtime Contract

Every retained config field must have:

- a runtime consumer
- validation behavior
- documented semantics
- verification coverage

### 6. Make Indexing Real

Background indexing remains in scope. The rewrite must define:

- trigger timing
- stale-range selection rules
- summary extraction/generation behavior
- persistence format
- omit-range application semantics

If any part of that cannot be made correct against Pi `0.67.2`, the specific sub-feature must be cut with explicit evidence.

### 7. Make Analytics Honest

The analytics layer must distinguish:

- exact context usage from Pi runtime signals
- approximate savings from transform heuristics

These may be reported together, but never conflated.

### 8. Make Visible Messaging Optional

Visible extension messaging is opt-in and evidence-based. It exists to improve trust or control, not as a default part of compression.

## Verified Trim Policy

No immediate trims are approved by this design. That is deliberate.

Evidence from `pi-context-ninja` shows multiple dead config fields and unwired modules, but evidence from Pi `0.67.2` also shows viable integration points for most of them:

- `before_provider_request` exists in Pi and is supported by `ExtensionAPI`.
- `session_before_compact` exists in Pi and can return a custom compaction result.
- `turn_end` and `tool_execution_*` exist in Pi and support accurate bookkeeping and observability.
- `ctx.getContextUsage()` exists in `ExtensionContext` and supports real usage reporting.

Because those integration points exist, the default rewrite decision is to implement rather than trim. A later trim recommendation must prove that the feature remains misleading or harmful even after considering the available Pi hooks.

## Verification Requirements

The implementation plan derived from this design must require all of the following:

- `rtk npm run typecheck` passes against current Pi package types
- `rtk npm test` passes
- integration coverage for real hook signatures and message unions
- tests for mixed-content tool-result safety
- tests proving dedup works across repeated calls with different `toolCallId` values
- tests proving turn-based stale-error aging advances on Pi turns, not only agent-loop completion
- tests for persisted-state reload correctness
- tests for every retained config field's behavior
- dashboard and analytics verification when those features are enabled

## Out Of Scope For This Design

- speculative forward-compatibility abstractions for unknown future Pi versions
- changing the core product away from silent-first
- removing public features or config without code-proven justification
- implementation task breakdown; that belongs in the subsequent execution plan

## Result

This design intentionally chooses a focused internal redesign with a stable external surface. The rewrite should end with a coherent Pi `0.67.2` extension whose runtime contract is correct, whose feature claims are real, and whose internals are organized to minimize ambiguity and context noise for both Pi and the developer working on it.
