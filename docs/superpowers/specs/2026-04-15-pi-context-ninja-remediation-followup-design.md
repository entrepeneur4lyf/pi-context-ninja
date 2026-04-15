# Pi Context Ninja Remediation Follow-Up Design

## Goal

Close the semantic and operational gaps discovered in the pre-production review so Pi Context Ninja actually delivers the original Pi `0.67.2` remediation spec, rather than merely type-checking and passing its current test suite.

## Scope And Intent

This document does not replace the accepted remediation design in `docs/superpowers/specs/2026-04-14-pi-context-ninja-remediation-design.md`. It is a follow-up design for defects found after the first implementation pass. The scope remains the same as the original spec:

- silent-first context optimization for Pi `0.67.2`
- real indexing and pruning
- faithful message shaping
- truthful analytics and dashboard behavior
- final verification against the original product and runtime contract

No scope reduction is approved here. Dead config or partially wired features are not a reason to trim. The purpose of this follow-up is to finish the original work, not renegotiate it.

## Evidence Summary

The current implementation still contains production-significant semantic errors:

- `src/runtime/index-manager.ts:19-55` indexes stale ranges by whole-turn offsets and `src/strategies/pruning.ts:14-26` drops every message in those offsets. Because the indexed slice can include user and assistant messages, background pruning can silently remove conversational truth rather than just tool noise.
- `src/strategies/materialize.ts:34-37` uses `deduplication.protectedTools` as an early return from the entire shaping pipeline, even though `src/strategies/dedup.ts:11-13` already models protected tools as a dedup-specific concept.
- `src/messages.ts:25-30` flattens all tool-result text blocks into one string, and `src/messages.ts:47-68` writes the transformed string back into every text block. Mixed-content results therefore lose block boundaries and can duplicate text.
- `src/analytics/store.ts:128-184` reads analytics rows and totals without session filters, while `src/runtime/create-extension-runtime.ts:134-171` shares one dashboard runtime across sessions. The dashboard therefore presents ambiguous or misleading multi-session state.

Local verification still passes:

- `rtk npm run check` passes

That confirms the problem is semantic correctness, not build failure.

## Remediation Objectives

1. Restore silent-first correctness so pruning removes only safe model-noise and never conversation-role truth by accident.
2. Make materialization semantically faithful for mixed-content tool results and protected tools.
3. Make analytics and dashboard output truthful about the session or aggregation scope they represent.
4. Revalidate the full original remediation spec after the fixes land, so the project is not declared complete on a narrow bugfix basis.

## Invariants

- User and assistant messages are non-prunable by default in the background indexing pipeline.
- No transform may change tool-result structure in a way that invents duplicate text or drops non-text blocks unintentionally.
- Config semantics must match runtime behavior. A dedup config key may not silently disable unrelated strategies.
- Observability must either be session-scoped or explicitly labeled as aggregated. Silent cross-session bleed is not acceptable.
- Completion requires behavioral verification of the reviewed defects plus a final check against the original remediation design.

## Remediation Approach

The implementation should use a hybrid approach:

1. Immediately make pruning safe at the current message layer by constraining pruning eligibility to tool-result-derived units only.
2. Deepen the index and materialization model so pruning can target explicit safe units inside tool outputs rather than relying on broad turn-based omission.

This approach fixes the dangerous behavior first without giving up on the original spec’s stronger pruning intent.

## Workstreams

### 1. Safe Pruning And Index Semantics

Background indexing must stop treating turn ranges as equivalent to safe omit ranges. The index format should describe pruning units that are explicitly safe to omit, derived from tool-result content only. The message-level implementation may be an intermediate step, but the end state must support pruning behavior that does not remove user or assistant messages as collateral damage.

Required properties:

- user and assistant messages are never omitted by background indexing
- omit metadata identifies safe pruning units rather than generic message offsets
- index generation and omit application agree on the same pruning unit model
- recovery from persisted state preserves those units without fabricating unsafe defaults

### 2. Faithful Materialization Semantics

Protected-tool handling and mixed-content rewriting need narrower, more truthful behavior.

Required properties:

- `deduplication.protectedTools` only disables deduplication unless a separate config concept is introduced for broader exemptions
- short-circuit, truncation, code filtering, and stale-error reduction remain eligible for protected tools when they are otherwise safe
- mixed-content tool results preserve non-text blocks and do not flatten multiple text blocks into one semantic blob that is then duplicated
- if a transform cannot safely preserve block semantics, it must skip that result rather than corrupt it

### 3. Truthful Analytics And Dashboard Scoping

The observability layer must state exactly what it is showing.

Recommended end state:

- dashboard snapshots are session-scoped by default
- analytics queries and totals are filtered to the active session unless the UI explicitly offers aggregation
- if a shared dashboard server remains process-scoped, it must still publish clearly session-scoped snapshots or expose an explicit session selector

The implementation may support aggregated views later, but the default path must align with the current product description.

### 4. Original-Spec Revalidation

The final workstream must re-open the accepted remediation design and prove the original obligations are now met. This includes the defect-specific fixes from this follow-up plus a whole-spec coverage check so the project is not declared complete on a selectively improved subset.

## Concrete Decisions

1. Conversation-role messages are not eligible for background omit-range pruning.
2. Index entries must identify safe pruning units, not just coarse turn spans.
3. `deduplication.protectedTools` applies to dedup only.
4. Mixed-content rewriting must be block-aware or must decline to transform.
5. Dashboard semantics must be session-scoped by default.
6. Final completion requires both defect closure and original-spec revalidation.

## Verification Requirements

The implementation plan derived from this follow-up must include, at minimum:

- tests proving background pruning does not remove user or assistant messages
- tests proving pruning units remain correct after state persistence and reload
- tests proving protected tools can still be short-circuited, truncated, or otherwise safely shaped when dedup is disabled for them
- tests proving mixed-content tool results preserve block boundaries and do not duplicate rewritten text
- tests proving dashboard totals and snapshots are session-truthful
- a final verification task that checks the original remediation design against the final code and documents any remaining gaps

## Out Of Scope

- changing the public product story
- removing features or config because the current code underdelivered
- speculative future-Pi abstractions
- documentation cleanup as a substitute for runtime correctness

## Result

This follow-up design keeps the original plan intact while making the current failures explicit. The next implementation plan should treat these defects as blocked deliverables inside the original remediation, then end with a full original-spec validation gate.
