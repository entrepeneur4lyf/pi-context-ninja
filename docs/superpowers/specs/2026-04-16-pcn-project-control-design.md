# Pi Context Ninja Project Control Design

## Goal

Add a true in-Pi `/pcn` command surface for project-scoped control and diagnostics, while keeping installation Pi-native and the extension silent by default in operation. The control plane should stay available whenever the extension is installed, even if optimization is disabled for the current project.

## Install Model

Installation remains Pi-native:

- install with `pi install <github-repo>`
- remove with Pi's built-in remove flow
- do not add a custom installer
- do not add `/pcn install`

The extension command surface only exists after Pi has installed and loaded the extension.

## Repo Cleanup Scope

This work also includes a small repository cleanup pass:

- remove root-level `AGENTS.md`
- remove root-level `CLAUDE.md`
- remove root-level `.claude/`
- leave `docs/` untouched
- do not perform any worktree merge action unless more than one worktree exists

At design time, the repository has a single worktree on `main`, so no worktree merge flow is needed.

## Command Surface

The slash command surface should be:

- `/pcn status`
- `/pcn doctor`
- `/pcn export`
- `/pcn enable`
- `/pcn disable`
- `/pcn enable dashboard`
- `/pcn disable dashboard`

No other commands are required in this phase.

## Command Semantics

### `/pcn status`

A concise one-screen summary for the current project. It should report:

- current project path
- whether the extension is enabled for this project
- whether dashboard publishing is enabled for this project
- config path in effect
- whether `.pi/.pi-ninja/` exists
- whether the extension is currently loaded and operating in full, degraded, or disabled mode

### `/pcn doctor`

A deeper diagnostic for the current project. It should classify:

- compatibility issues
- config issues
- persistence issues
- analytics or dashboard degradation
- project-local control state
- recovery posture

It should produce enough detail to support a bug report.

### `/pcn export`

Exports the latest project-local diagnostic context to Markdown for issue filing. Output must avoid terminal formatting artifacts.

### `/pcn enable`

Project-local enable:

- ensure `.pi/` exists
- ensure `.pi/.pi-ninja/` exists
- remove `.pi/.pi-ninja/.pcn_disabled` if present
- preserve dashboard preference

### `/pcn disable`

Project-local full disable:

- ensure `.pi/.pi-ninja/` exists
- create `.pi/.pi-ninja/.pcn_disabled`
- keep command availability intact
- do not uninstall the extension

### `/pcn enable dashboard`

- remove `.pi/.pi-ninja/.pcn_dashboard_disabled` if present
- if the project is otherwise disabled, report that dashboard is enabled for when `/pcn enable` is run

### `/pcn disable dashboard`

- create `.pi/.pi-ninja/.pcn_dashboard_disabled`
- analytics and native compaction remain unaffected

## Project-Scoped Control State

Control state must be project-local under `.pi/.pi-ninja/`.

Markers:

- `.pi/.pi-ninja/.pcn_disabled`
- `.pi/.pi-ninja/.pcn_dashboard_disabled`

Rules:

- default is enabled
- missing `.pcn_disabled` means enabled
- present `.pcn_disabled` means data-plane behavior is disabled for this project
- missing `.pcn_dashboard_disabled` means dashboard publishing is enabled for this project
- present `.pcn_dashboard_disabled` means dashboard publishing is disabled for this project

This model intentionally uses disable markers rather than run markers so missing files are unambiguous under a default-on policy.

## Runtime Model

The extension should split into two layers.

### Control Plane

Always available when the extension is installed. It owns:

- `/pcn` command registration
- project-state reads and writes under `.pi/.pi-ninja/`
- status rendering
- doctor diagnostics
- Markdown export

### Data Plane

Only active when the current project is enabled. It owns:

- context shaping
- deduplication
- error aging
- background indexing
- analytics recording
- native compaction integration
- optional dashboard publishing

If the project is disabled:

- hooks still register
- `/pcn` remains available
- context and tool-result paths become passthrough
- project optimization bookkeeping stops
- analytics does not record for that project
- dashboard does not publish for that project

If only dashboard is disabled:

- core runtime remains active
- analytics remains active
- dashboard server may still exist for other projects or sessions
- current project simply does not publish dashboard snapshots

## Internal Structure

Implementation should be split into focused modules.

### `src/control/project-state.ts`

Owns:

- `.pi/.pi-ninja/` path resolution
- marker reads and writes
- enable and disable helpers
- dashboard enable and disable helpers

This module is the only place that should know the marker filenames.

### `src/control/status.ts`

Builds the short project-local status model.

### `src/control/doctor.ts`

Builds the deeper project-local diagnostic model.

### `src/control/export.ts`

Renders Markdown reports from status and doctor output.

### `src/control/commands.ts`

Registers `/pcn` commands via Pi's extension command API and delegates to the control modules.

### `src/control/runtime-gate.ts`

Provides shared project-local gating helpers for runtime behavior:

- is project enabled?
- is dashboard enabled?

## Scope Boundaries

### In scope

- project-local `/pcn` command surface
- project-local enable and disable state
- project-local dashboard toggle state
- runtime gating based on that state
- status, doctor, and export behaviors
- repo cleanup for `AGENTS.md`, `CLAUDE.md`, and `.claude/`

### Out of scope

- custom installer scripts
- a separate standalone CLI
- changing Pi's install or remove model
- redesigning dashboard UI
- changing analytics storage scope beyond what is necessary to respect project-local enablement

## Success Criteria

- `pi install <github-repo>` remains the only install path
- `/pcn` commands are available whenever the extension is installed
- a project with no control markers is enabled by default
- `/pcn disable` disables the extension only for the current project
- `/pcn disable dashboard` disables only dashboard publication for the current project
- analytics remains enabled whenever the extension is enabled
- runtime hooks respect project-local state without removing command availability
- `status`, `doctor`, and `export` reflect the current project's real control and runtime state
