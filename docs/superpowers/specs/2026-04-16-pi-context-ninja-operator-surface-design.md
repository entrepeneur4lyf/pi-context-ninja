# Pi Context Ninja Operator Surface Design

## Goal

Add an operator-first product layer to Pi Context Ninja so installation, verification, observability, diagnosis, and issue reporting are clear and trustworthy, while preserving the existing silent-first core behavior.

## Product Stance

Pi Context Ninja remains a silent-first context optimizer. Its job is still to reduce model-facing context noise through request-time shaping rather than visible compression workflows.

What changes in this design is the operator experience around that core:

- clearer install and verification flow
- clearer subsystem health reporting
- clearer observability of what was kept out and why
- clearer handling of compatibility breakage
- stricter release discipline tied to runtime semantics

This design does not broaden the product into unrelated platform features. It adds only the user-facing surfaces and internal contracts needed to make Pi Context Ninja easier to trust, operate, and support.

## Scope

This design covers both:

1. **Product-facing surfaces**
   - install and verify workflow
   - doctor diagnostics
   - observability and dashboard presentation
   - exportable issue-report artifacts
   - release and verification gate

2. **Internal support needed to make those surfaces truthful**
   - thin Pi adapter boundaries
   - explicit compatibility checks
   - subsystem health reporting
   - structured diagnostics capture
   - release-time runtime-semantic verification

This design explicitly avoids:

- tying the product identity to a single Pi version
- weakening the feature set for speculative API drift
- adding flashy surfaces that are not backed by real runtime state

## Compatibility Stance

Pi Context Ninja should target the current Pi extension contract and current documented behavior, but it should fail in a controlled, diagnosable way if Pi introduces a real breaking change.

The correct stance is:

- optimize for the current known Pi API
- rely on Pi release notes and breaking-change notifications for maintenance
- avoid speculative future-proofing abstraction that weakens the product
- add graceful failure behavior where contract assumptions can be validated

This means compatibility handling should be explicit and bounded:

- isolate Pi hook/event assumptions inside a thin adapter layer
- validate critical assumptions at startup where feasible
- disable the affected subsystem when a contract breaks, rather than silently behaving incorrectly
- fail closed only when the core `context` contract itself is no longer safe
- surface the issue through `doctor`, dashboard health, and exported diagnostics

Examples:

- if native compaction contracts drift, disable native compaction integration and keep silent-first shaping active
- if analytics/event payload assumptions drift, keep pruning active and mark observability degraded
- if Pi message or `context` contracts drift in a way that makes shaping unsafe, stop shaping and emit a clear blocking compatibility failure

## Product Surfaces

### 1. Installation Surface

Pi Context Ninja should have one obvious path from “I installed it” to “it is active in Pi.”

The install/enable flow should answer:

- is Pi loading the extension
- is the config valid
- are persistence directories writable
- are optional subsystems enabled and healthy
- is the extension running in full mode, degraded mode, or blocked mode

This does not require a huge CLI. It requires a crisp operator entrypoint and clear success criteria.

### 2. Doctor Surface

`doctor` becomes the primary diagnostics tool. It should answer concrete questions:

- is the extension wired to the current Pi contract
- is the loaded config valid
- are state, index, and analytics paths usable
- are optional subsystems healthy
- are persisted files corrupted or incompatible
- are any features currently degraded or blocked

The doctor surface should be diagnostic first. It may suggest safe repairs, but it should not hide failures behind magic.

### 3. Observability Surface

The dashboard should be a trust surface, not just a metric dump. It should tell the operator:

- what context was kept out
- which strategy caused it
- whether the measurement is exact or approximate
- what the current runtime mode is
- which subsystems are healthy, degraded, or disabled

The UI should prefer clarity and trust over volume. If a number is approximate, it must be labeled approximate.

### 4. Export Surface

When `doctor` finds a meaningful problem, the user should be able to export a Markdown report for issue filing.

That export should be designed for direct submission:

- no terminal color codes
- no wrapped whitespace artifacts
- compact environment summary
- compatibility findings
- subsystem health
- redacted config snapshot
- relevant runtime or startup errors
- recommended next actions

The flow should be simple:

1. run `doctor`
2. review findings
3. export Markdown report if needed
4. paste or attach the file to an issue

### 5. Release Surface

Pi Context Ninja should have an explicit ship gate tied to real product guarantees, not only unit-test green status.

The release surface should require:

- targeted runtime-semantic tests
- full repository verification
- whole-implementation review
- confirmation that product-facing docs and diagnostics still match behavior

## Operator Workflow

The intended developer workflow becomes:

1. **Install / enable**
   - configure the extension
   - confirm Pi is loading it

2. **Verify**
   - run `doctor`
   - confirm compatibility, config health, and writable persistence

3. **Observe**
   - inspect dashboard or status view
   - understand what the extension is doing in the current session

4. **Diagnose**
   - use `doctor` to classify issues as config, persistence, subsystem degradation, or compatibility breakage

5. **Export**
   - generate a Markdown report when an issue should be filed upstream

This workflow reduces support ambiguity. Instead of “something seems weird,” the user gets a concrete subsystem diagnosis and a report that is already shaped for action.

## Doctor Design

### Output Model

`doctor` should report by subsystem, not as a flat wall of checks.

Suggested groups:

- Pi compatibility
- extension runtime
- config
- persistence
- analytics
- dashboard / observability
- optional integrations

Each group should produce one of:

- `healthy`
- `degraded`
- `blocked`

Each failing or degraded group should include:

- what failed
- why it matters
- what remains functional
- recommended next action

### Compatibility Diagnostics

For Pi compatibility failures, `doctor` should report:

- detected Pi version, when available
- extension version
- which contract check failed
- which subsystem is affected
- whether the issue is blocking or degraded
- the exact hook, event field, or result-shape assumption that failed
- the last known tested baseline or compatibility note
- next action:
  - update Pi
  - update Pi Context Ninja
  - disable a specific optional feature
  - file an issue with the exported report

This is what makes graceful failure actually useful. The user needs enough detail to help close the compatibility gap quickly.

### Persistence Diagnostics

`doctor` should validate:

- state directory exists and is writable
- index directory exists and is writable
- analytics path is writable if enabled
- persisted files are parseable
- corrupted files are identified and surfaced clearly

If corruption is detected, the report should name the file and state whether the extension can self-recover, ignore it safely, or needs operator action.

### Runtime Diagnostics

`doctor` should also expose runtime facts that users actually care about:

- is the extension receiving Pi hooks
- which optional subsystems are enabled
- whether the current mode is full, degraded, or blocked
- last known successful runtime activity
- recent compatibility or persistence exceptions

## Observability Design

### Dashboard Model

The dashboard should be organized around operator questions:

- What did Pi Context Ninja do?
- How much context stayed out of the model?
- Why did it happen?
- Is the system healthy?

Recommended sections:

- current session status
- health summary
- recent strategy activity
- kept-out totals by strategy
- exact vs approximate metrics explanation
- recent warnings or degraded features

### Metrics Rules

Observability must not overclaim.

- exact Pi-provided context usage should be labeled exact
- heuristic savings should be labeled approximate
- disabled or degraded subsystems should not continue reporting stale-looking success

### Trust Features

The dashboard should help users trust the system by showing:

- active strategies
- disabled strategies
- degraded features
- compatibility warnings
- recent diagnostic notes

The goal is not more numbers. The goal is more legible truth.

## Internal Architecture Support

To support these operator surfaces cleanly, the runtime should expose a structured health model.

### 1. Thin Pi Adapter

All Pi-specific hook and message assumptions should remain isolated in one adapter layer. This gives the product one obvious place to validate compatibility assumptions and one obvious place to surface contract failures.

### 2. Health Registry

Introduce a small internal health registry that each subsystem can publish to:

- runtime adapter
- materialization
- persistence
- analytics
- dashboard
- optional integrations

Each subsystem reports:

- status
- short reason
- optional detailed diagnostic payload

This registry becomes the shared source for `doctor`, dashboard health, exported reports, and release checks.

### 3. Diagnostics Capture

Compatibility exceptions, persistence parse failures, analytics degradation, and startup validation failures should be captured in a structured diagnostics store rather than only emitted to the terminal.

This allows:

- doctor to show the latest relevant errors
- dashboard to display degraded-state explanations
- exported Markdown reports to include the exact captured failure context

### 4. Release Verification Contract

The product should define which runtime-semantic suites must pass before a release is considered healthy. This should include:

- compatibility-sensitive hook tests
- persistence recovery tests
- strategy correctness tests
- observability truthfulness tests

## Documentation Design

The documentation should be rewritten around operator understanding rather than internal aspiration.

### README should answer:

- what Pi Context Ninja does in one sentence
- where savings come from
- what silent-first means
- how to install / enable it
- how to verify it is active
- how to inspect what it is doing
- how to diagnose and report a problem

### Doctor docs should explain:

- healthy vs degraded vs blocked
- exact vs approximate metrics
- compatibility failures vs ordinary misconfiguration
- how to export a Markdown report

### Release docs should explain:

- what “ready” means
- which checks are mandatory
- what kinds of failures block ship

## Non-Goals

This design does not introduce:

- new cloud features
- broad new persistence systems
- unrelated dashboard analytics
- speculative compatibility abstractions for imagined future Pi changes

It is strictly about making the existing product easier to install, trust, diagnose, and maintain.

## Acceptance Criteria

This design is satisfied when:

- a new user has one obvious way to install and verify the extension
- `doctor` can clearly distinguish compatibility, config, persistence, and subsystem-health issues
- compatibility failures degrade safely and are explained clearly
- the dashboard shows operator-relevant truth rather than ambiguous telemetry
- users can export a Markdown issue report without terminal-copy formatting problems
- the release process includes runtime-semantic verification, not just generic tests

## Design Summary

Pi Context Ninja should stay quiet in the model’s context but become much louder, clearer, and more useful to the operator.

That is the right trade:

- silent-first for the agent
- explicit and trustworthy for the human
