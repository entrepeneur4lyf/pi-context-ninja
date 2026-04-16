# PCN Project Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-scoped `/pcn` control plane that stays available whenever the extension is installed, gates the existing runtime with `.pi/.pi-ninja/` markers, and cleans up the root-level repo artifacts.

**Architecture:** Keep installation Pi-native and add a small `src/control/` surface around the existing extension runtime. Commands read and write project-local control markers, the runtime gates hook behavior through a shared helper, and diagnostics/export are built from real project/config/runtime state instead of ad hoc strings.

**Tech Stack:** TypeScript, Pi extension API (`pi.registerCommand()`), Vitest, Node `fs/path/os`

---

## File Map

### New files

- `src/control/project-state.ts`
  Resolves `.pi/.pi-ninja/`, reads marker files, and performs project-local enable/disable mutations.
- `src/control/runtime-gate.ts`
  Thin helper layer for “is extension enabled for this cwd?” and “is dashboard enabled for this cwd?” so hook code has one gate.
- `src/control/status.ts`
  Builds the concise project-local status model used by `/pcn status`.
- `src/control/doctor.ts`
  Builds the deeper diagnostic report used by `/pcn doctor` and `/pcn export`.
- `src/control/export.ts`
  Renders the doctor/status report to Markdown and writes it under `.pi/.pi-ninja/reports/`.
- `src/control/commands.ts`
  Registers `/pcn` slash commands and delegates to the control modules.
- `test/project-state.test.ts`
  Unit tests for default-on marker semantics and project-local filesystem behavior.
- `test/control.test.ts`
  Unit tests for status/doctor/export shaping.

### Existing files to modify

- `src/index.ts`
  Register the command surface alongside the runtime.
- `src/config.ts`
  Expose the resolved runtime config path so status/doctor can report the effective config file.
- `src/runtime/create-extension-runtime.ts`
  Gate the data plane with project-local control state and skip dashboard publishing when dashboard is disabled.
- `test/runtime-hooks.test.ts`
  Extend the Pi mock to support `registerCommand()`, then add command and runtime gate coverage.
- `.gitignore`
  Ignore `.pi/.pi-ninja/` project-local artifacts without ignoring the entire `.pi/` directory.

### Repo cleanup

- Remove `AGENTS.md`
- Remove `CLAUDE.md`
- Remove `.claude/`

---

### Task 1: Add Project-Local Control State Primitives

**Files:**
- Create: `src/control/project-state.ts`
- Create: `src/control/runtime-gate.ts`
- Test: `test/project-state.test.ts`

- [ ] **Step 1: Write the failing tests for default-on control markers**

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  disableProject,
  disableProjectDashboard,
  enableProject,
  enableProjectDashboard,
  readProjectControlState,
  resolveProjectControlDir,
} from "../src/control/project-state.js";
import { isProjectDashboardEnabled, isProjectEnabled } from "../src/control/runtime-gate.js";

describe("project control state", () => {
  it("defaults to enabled when no markers exist", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-project-state-"));
    const state = readProjectControlState(projectDir);

    expect(resolveProjectControlDir(projectDir)).toBe(path.join(projectDir, ".pi", ".pi-ninja"));
    expect(state.enabled).toBe(true);
    expect(state.dashboardEnabled).toBe(true);
    expect(isProjectEnabled(projectDir)).toBe(true);
    expect(isProjectDashboardEnabled(projectDir)).toBe(true);
  });

  it("creates marker directories on demand and flips extension enablement", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-project-state-"));

    disableProject(projectDir);
    expect(readProjectControlState(projectDir).enabled).toBe(false);

    enableProject(projectDir);
    expect(readProjectControlState(projectDir).enabled).toBe(true);
  });

  it("preserves dashboard preference independently of full enablement", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-project-state-"));

    disableProjectDashboard(projectDir);
    expect(readProjectControlState(projectDir)).toMatchObject({
      enabled: true,
      dashboardEnabled: false,
    });

    disableProject(projectDir);
    enableProject(projectDir);
    expect(readProjectControlState(projectDir)).toMatchObject({
      enabled: true,
      dashboardEnabled: false,
    });

    enableProjectDashboard(projectDir);
    expect(readProjectControlState(projectDir).dashboardEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the targeted test to confirm the module is missing**

Run: `rtk npm test -- test/project-state.test.ts`

Expected: FAIL with `Cannot find module '../src/control/project-state.js'` and `Cannot find module '../src/control/runtime-gate.js'`.

- [ ] **Step 3: Implement the project-state and runtime-gate modules**

```ts
// src/control/project-state.ts
import fs from "node:fs";
import path from "node:path";

const CONTROL_DIR_PARTS = [".pi", ".pi-ninja"] as const;
const DISABLED_MARKER = ".pcn_disabled";
const DASHBOARD_DISABLED_MARKER = ".pcn_dashboard_disabled";

export interface ProjectControlState {
  projectPath: string;
  controlDir: string;
  enabled: boolean;
  dashboardEnabled: boolean;
  disabledMarkerPath: string;
  dashboardDisabledMarkerPath: string;
}

export function resolveProjectControlDir(projectPath: string): string {
  return path.join(projectPath, ...CONTROL_DIR_PARTS);
}

export function readProjectControlState(projectPath: string): ProjectControlState {
  const controlDir = resolveProjectControlDir(projectPath);
  const disabledMarkerPath = path.join(controlDir, DISABLED_MARKER);
  const dashboardDisabledMarkerPath = path.join(controlDir, DASHBOARD_DISABLED_MARKER);

  return {
    projectPath,
    controlDir,
    enabled: !fs.existsSync(disabledMarkerPath),
    dashboardEnabled: !fs.existsSync(dashboardDisabledMarkerPath),
    disabledMarkerPath,
    dashboardDisabledMarkerPath,
  };
}

export function ensureProjectControlDir(projectPath: string): string {
  const controlDir = resolveProjectControlDir(projectPath);
  fs.mkdirSync(controlDir, { recursive: true });
  return controlDir;
}

export function disableProject(projectPath: string): void {
  const controlDir = ensureProjectControlDir(projectPath);
  fs.closeSync(fs.openSync(path.join(controlDir, DISABLED_MARKER), "w"));
}

export function enableProject(projectPath: string): void {
  fs.rmSync(path.join(resolveProjectControlDir(projectPath), DISABLED_MARKER), { force: true });
}

export function disableProjectDashboard(projectPath: string): void {
  const controlDir = ensureProjectControlDir(projectPath);
  fs.closeSync(fs.openSync(path.join(controlDir, DASHBOARD_DISABLED_MARKER), "w"));
}

export function enableProjectDashboard(projectPath: string): void {
  fs.rmSync(path.join(resolveProjectControlDir(projectPath), DASHBOARD_DISABLED_MARKER), { force: true });
}
```

```ts
// src/control/runtime-gate.ts
import { readProjectControlState } from "./project-state.js";

export function isProjectEnabled(projectPath?: string): boolean {
  if (!projectPath) {
    return true;
  }
  return readProjectControlState(projectPath).enabled;
}

export function isProjectDashboardEnabled(projectPath?: string): boolean {
  if (!projectPath) {
    return true;
  }
  const state = readProjectControlState(projectPath);
  return state.enabled && state.dashboardEnabled;
}
```

- [ ] **Step 4: Re-run the targeted test**

Run: `rtk npm test -- test/project-state.test.ts`

Expected: PASS with `3 passed`.

- [ ] **Step 5: Commit the control-state primitives**

```bash
rtk git add src/control/project-state.ts src/control/runtime-gate.ts test/project-state.test.ts
rtk git commit -m "feat: add project control state markers"
```

---

### Task 2: Build Status, Doctor, and Markdown Export

**Files:**
- Modify: `src/config.ts`
- Create: `src/control/status.ts`
- Create: `src/control/doctor.ts`
- Create: `src/control/export.ts`
- Test: `test/control.test.ts`

- [ ] **Step 1: Write the failing tests for status, doctor, and export**

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { disableProject, disableProjectDashboard } from "../src/control/project-state.js";
import { buildProjectStatus } from "../src/control/status.js";
import { buildProjectDoctorReport } from "../src/control/doctor.js";
import { exportProjectDoctorReport } from "../src/control/export.js";

describe("project control reporting", () => {
  it("builds a concise status model for the current project", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-control-status-"));
    const configPath = path.join(projectDir, ".pi-ninja-config.yaml");
    const status = buildProjectStatus({
      projectPath: projectDir,
      config: defaultConfig(),
      configPath,
      runtimeLoaded: true,
      degradedReasons: [],
    });

    expect(status.projectPath).toBe(projectDir);
    expect(status.enabled).toBe(true);
    expect(status.dashboardEnabled).toBe(true);
    expect(status.mode).toBe("full");
    expect(status.configPath).toBe(configPath);
  });

  it("marks disabled and degraded states in the doctor report", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-control-status-"));
    disableProject(projectDir);
    disableProjectDashboard(projectDir);

    const report = buildProjectDoctorReport({
      projectPath: projectDir,
      config: defaultConfig(),
      configPath: "/tmp/config.yaml",
      runtimeLoaded: true,
      degradedReasons: ["dashboard startup failed"],
    });

    expect(report.status.mode).toBe("disabled");
    expect(report.findings).toContain("Extension runtime is disabled for this project.");
    expect(report.findings).toContain("Dashboard publishing is disabled for this project.");
    expect(report.findings).toContain("dashboard startup failed");
  });

  it("exports a markdown report beneath .pi/.pi-ninja/reports", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-control-status-"));
    const reportPath = exportProjectDoctorReport({
      projectPath: projectDir,
      report: buildProjectDoctorReport({
        projectPath: projectDir,
        config: defaultConfig(),
        configPath: "/tmp/config.yaml",
        runtimeLoaded: true,
        degradedReasons: [],
      }),
    });

    expect(reportPath).toContain(path.join(".pi", ".pi-ninja", "reports"));
    expect(fs.readFileSync(reportPath, "utf8")).toContain("# Pi Context Ninja Diagnostic Report");
  });
});
```

- [ ] **Step 2: Run the targeted reporting tests**

Run: `rtk npm test -- test/control.test.ts`

Expected: FAIL with missing module errors for `status.js`, `doctor.js`, and `export.js`.

- [ ] **Step 3: Add a config-path helper and implement the reporting modules**

```ts
// src/config.ts
export function resolveRuntimeConfigPath(): string {
  return process.env.PCN_CONFIG_PATH ?? path.join(os.homedir(), ".pi-ninja", "config.yaml");
}

export function loadRuntimeConfig(): PCNConfig {
  return loadConfig(resolveRuntimeConfigPath());
}
```

```ts
// src/control/status.ts
import { readProjectControlState } from "./project-state.js";
import type { PCNConfig } from "../config.js";

export interface ProjectStatus {
  projectPath: string;
  controlDir: string;
  configPath: string;
  enabled: boolean;
  dashboardEnabled: boolean;
  runtimeLoaded: boolean;
  mode: "full" | "degraded" | "disabled";
  degradedReasons: string[];
}

export function buildProjectStatus(input: {
  projectPath: string;
  config: PCNConfig;
  configPath: string;
  runtimeLoaded: boolean;
  degradedReasons: string[];
}): ProjectStatus {
  const control = readProjectControlState(input.projectPath);
  const mode = !control.enabled ? "disabled" : input.degradedReasons.length > 0 ? "degraded" : "full";

  return {
    projectPath: input.projectPath,
    controlDir: control.controlDir,
    configPath: input.configPath,
    enabled: control.enabled,
    dashboardEnabled: control.dashboardEnabled,
    runtimeLoaded: input.runtimeLoaded,
    mode,
    degradedReasons: [...input.degradedReasons],
  };
}
```

```ts
// src/control/doctor.ts
import type { PCNConfig } from "../config.js";
import { buildProjectStatus, type ProjectStatus } from "./status.js";

export interface ProjectDoctorReport {
  status: ProjectStatus;
  findings: string[];
}

export function buildProjectDoctorReport(input: {
  projectPath: string;
  config: PCNConfig;
  configPath: string;
  runtimeLoaded: boolean;
  degradedReasons: string[];
}): ProjectDoctorReport {
  const status = buildProjectStatus(input);
  const findings: string[] = [];

  if (!status.enabled) findings.push("Extension runtime is disabled for this project.");
  if (!status.dashboardEnabled) findings.push("Dashboard publishing is disabled for this project.");
  if (status.degradedReasons.length === 0 && status.enabled) findings.push("No compatibility or runtime degradation detected.");
  findings.push(...status.degradedReasons);

  return { status, findings };
}
```

```ts
// src/control/export.ts
import fs from "node:fs";
import path from "node:path";
import { ensureProjectControlDir } from "./project-state.js";
import type { ProjectDoctorReport } from "./doctor.js";

export function exportProjectDoctorReport(input: {
  projectPath: string;
  report: ProjectDoctorReport;
}): string {
  const reportsDir = path.join(ensureProjectControlDir(input.projectPath), "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const filePath = path.join(reportsDir, `doctor-${Date.now()}.md`);

  const body = [
    "# Pi Context Ninja Diagnostic Report",
    "",
    `- Project: \`${input.report.status.projectPath}\``,
    `- Config: \`${input.report.status.configPath}\``,
    `- Mode: \`${input.report.status.mode}\``,
    "",
    "## Findings",
    ...input.report.findings.map((finding) => `- ${finding}`),
  ].join("\n");

  fs.writeFileSync(filePath, body, "utf8");
  return filePath;
}
```

- [ ] **Step 4: Re-run the reporting tests**

Run: `rtk npm test -- test/control.test.ts`

Expected: PASS with `3 passed`.

- [ ] **Step 5: Commit the reporting layer**

```bash
rtk git add src/config.ts src/control/status.ts src/control/doctor.ts src/control/export.ts test/control.test.ts
rtk git commit -m "feat: add pcn reporting surface"
```

---

### Task 3: Register the `/pcn` Slash Commands

**Files:**
- Create: `src/control/commands.ts`
- Modify: `src/index.ts`
- Modify: `test/runtime-hooks.test.ts`

- [ ] **Step 1: Extend the runtime test harness to expect command registration**

```ts
function createPiMock() {
  const calls = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
  const pi = {
    on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
      calls.set(name, handler);
    }),
    registerCommand: vi.fn((name: string, options: { handler: (...args: unknown[]) => unknown }) => {
      commands.set(name, options);
    }),
  } as unknown as ExtensionAPI;

  return { calls, commands, pi };
}
```

```ts
it("registers the /pcn command surface", () => {
  const { pi } = createPiMock();
  registerExtension(pi);

  expect((pi as any).registerCommand).toHaveBeenCalledTimes(5);
  expect((pi as any).registerCommand).toHaveBeenCalledWith("pcn", expect.objectContaining({
    description: expect.stringContaining("Pi Context Ninja"),
  }));
});
```

```ts
it("toggles project-local markers through /pcn enable and /pcn disable", async () => {
  const { commands, pi } = createPiMock();
  createExtensionRuntime(pi, defaultConfig());

  const ctx = {
    ...createContext("session-commands", "/tmp/project-control"),
    ui: {
      notify: vi.fn(),
    },
  } as any;

  await commands.get("pcn")?.handler("disable", ctx);
  expect(fs.existsSync(path.join("/tmp/project-control", ".pi", ".pi-ninja", ".pcn_disabled"))).toBe(true);

  await commands.get("pcn")?.handler("enable", ctx);
  expect(fs.existsSync(path.join("/tmp/project-control", ".pi", ".pi-ninja", ".pcn_disabled"))).toBe(false);
});
```

- [ ] **Step 2: Run the hook test file and confirm the new assertions fail**

Run: `rtk npm test -- test/runtime-hooks.test.ts`

Expected: FAIL because `registerCommand` is not called and no `pcn` command exists yet.

- [ ] **Step 3: Implement `/pcn` command registration and wire it in from the entrypoint**

```ts
// src/control/commands.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PCNConfig } from "../config.js";
import { resolveRuntimeConfigPath } from "../config.js";
import {
  disableProject,
  disableProjectDashboard,
  enableProject,
  enableProjectDashboard,
} from "./project-state.js";
import { buildProjectStatus } from "./status.js";
import { buildProjectDoctorReport } from "./doctor.js";
import { exportProjectDoctorReport } from "./export.js";

function parsePcnArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

export function registerProjectControlCommands(pi: ExtensionAPI, config: PCNConfig): void {
  pi.registerCommand("pcn", {
    description: "Pi Context Ninja project controls",
    handler: async (args, ctx) => {
      const [action, target] = parsePcnArgs(args);
      const projectPath = ctx.cwd;
      const configPath = resolveRuntimeConfigPath();

      if (action === "enable" && target === "dashboard") {
        enableProjectDashboard(projectPath);
        ctx.ui.notify("Pi Context Ninja dashboard enabled for this project.", "info");
        return;
      }

      if (action === "disable" && target === "dashboard") {
        disableProjectDashboard(projectPath);
        ctx.ui.notify("Pi Context Ninja dashboard disabled for this project.", "info");
        return;
      }

      if (action === "enable") {
        enableProject(projectPath);
        ctx.ui.notify("Pi Context Ninja enabled for this project.", "info");
        return;
      }

      if (action === "disable") {
        disableProject(projectPath);
        ctx.ui.notify("Pi Context Ninja disabled for this project.", "info");
        return;
      }

      if (action === "status") {
        const status = buildProjectStatus({
          projectPath,
          config,
          configPath,
          runtimeLoaded: true,
          degradedReasons: [],
        });
        ctx.ui.notify(`PCN ${status.mode}: ${status.projectPath}`, "info");
        return;
      }

      if (action === "doctor") {
        const report = buildProjectDoctorReport({
          projectPath,
          config,
          configPath,
          runtimeLoaded: true,
          degradedReasons: [],
        });
        ctx.ui.notify(report.findings.join(" | "), "info");
        return;
      }

      if (action === "export") {
        const report = buildProjectDoctorReport({
          projectPath,
          config,
          configPath,
          runtimeLoaded: true,
          degradedReasons: [],
        });
        const reportPath = exportProjectDoctorReport({ projectPath, report });
        ctx.ui.notify(`Exported PCN report to ${reportPath}`, "info");
        return;
      }

      ctx.ui.notify("Usage: /pcn status|doctor|export|enable|disable|enable dashboard|disable dashboard", "warn");
    },
  });
}
```

```ts
// src/index.ts
import { registerProjectControlCommands } from "./control/commands.js";

export default function (pi: ExtensionAPI) {
  const config = loadRuntimeConfig();
  registerProjectControlCommands(pi, config);
  createExtensionRuntime(pi, config);
}
```

- [ ] **Step 4: Re-run the runtime hook tests**

Run: `rtk npm test -- test/runtime-hooks.test.ts`

Expected: PASS on the new command-registration assertions.

- [ ] **Step 5: Commit the command surface**

```bash
rtk git add src/control/commands.ts src/index.ts test/runtime-hooks.test.ts
rtk git commit -m "feat: add pcn slash commands"
```

---

### Task 4: Gate the Existing Runtime by Project State

**Files:**
- Modify: `src/runtime/create-extension-runtime.ts`
- Modify: `test/runtime-hooks.test.ts`
- Modify: `test/dashboard.test.ts`

- [ ] **Step 1: Add failing runtime tests for disabled-project and dashboard-disabled behavior**

```ts
it("passes through data-plane hooks when the project is disabled", async () => {
  const config = defaultConfig();
  config.analytics.enabled = true;
  config.dashboard.enabled = true;

  const { calls, pi } = createPiMock();
  createExtensionRuntime(pi, config);

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-disabled-project-"));
  fs.mkdirSync(path.join(projectDir, ".pi", ".pi-ninja"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", ".pi-ninja", ".pcn_disabled"), "", "utf8");

  const ctx = createContext("session-disabled", projectDir);

  const toolResult = await calls.get("tool_result")?.({
    type: "tool_result",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "body" }],
    isError: false,
  }, ctx);

  expect(toolResult).toBeUndefined();

  const contextResult = await calls.get("context")?.({
    type: "context",
    messages: [{ role: "tool", type: "tool_result", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "body" }], isError: false }],
  }, ctx);

  expect(contextResult).toEqual({
    messages: [{ role: "tool", type: "tool_result", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "body" }], isError: false }],
  });
});
```

```ts
it("records analytics but skips dashboard publishing when only dashboard is disabled", async () => {
  const config = defaultConfig();
  config.analytics.enabled = true;
  config.dashboard.enabled = true;

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-dashboard-disabled-"));
  fs.mkdirSync(path.join(projectDir, ".pi", ".pi-ninja"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", ".pi-ninja", ".pcn_dashboard_disabled"), "", "utf8");

  const { calls, pi } = createPiMock();
  createExtensionRuntime(pi, config);

  await calls.get("turn_end")?.({
    type: "turn_end",
    turnIndex: 0,
    toolResults: [],
  }, createContext("session-dashboard-disabled", projectDir));

  // Assert no dashboard snapshot was emitted for the project while turn history still persisted.
  const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, `${encodeURIComponent("session-dashboard-disabled")}.json`), "utf8"));
  expect(persisted.turnHistory).toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused hook/dashboard tests**

Run: `rtk npm test -- test/runtime-hooks.test.ts test/dashboard.test.ts`

Expected: FAIL because the runtime still shapes, records, and publishes regardless of project-local markers.

- [ ] **Step 3: Add project-state gates to the runtime**

```ts
// src/runtime/create-extension-runtime.ts
import { isProjectDashboardEnabled, isProjectEnabled } from "../control/runtime-gate.js";

function isDataPlaneEnabled(projectPath?: string): boolean {
  return isProjectEnabled(projectPath);
}

pi.on("tool_call", (event, ctx) => {
  if (!isDataPlaneEnabled(ctx.cwd)) {
    return;
  }
  // existing body
});

pi.on("tool_result", (event, ctx) => {
  if (!isDataPlaneEnabled(ctx.cwd)) {
    return undefined;
  }
  // existing body
});

pi.on("context", async (event, ctx) => {
  if (!isDataPlaneEnabled(ctx.cwd)) {
    return { messages: event.messages };
  }
  // existing body
});

pi.on("turn_end", async (event, ctx) => {
  if (!isDataPlaneEnabled(ctx.cwd)) {
    return;
  }
  // existing body
});

pi.on("before_agent_start", (event, ctx) => {
  if (!isDataPlaneEnabled(ctx.cwd)) {
    return undefined;
  }
  // existing body
});

pi.on("session_before_compact", (event, ctx) => {
  if (!isDataPlaneEnabled(ctx.cwd)) {
    return undefined;
  }
  // existing body
});

pi.on("agent_end", (event, ctx) => {
  if (!isDataPlaneEnabled(ctx.cwd)) {
    return;
  }
  // existing body
});
```

```ts
async function recordTurnAnalyticsSafely(
  sessionId: string,
  state: SessionState,
  config: PCNConfig,
  turn: { /* existing shape */ },
): Promise<void> {
  if (!config.analytics.enabled) {
    return;
  }

  try {
    const analyticsStore = getAnalyticsStore(sessionId, state, config);
    const snapshot = analyticsStore?.recordTurn({ /* existing fields */ });
    if (!snapshot) {
      return;
    }

    if (!isProjectDashboardEnabled(state.projectPath)) {
      return;
    }

    const dashboardServer = await ensureDashboardServer(sessionId, config);
    if (dashboardServer) {
      dashboardServer.publish(sessionId, snapshot);
    }
  } catch {
    evictAnalyticsStore(sessionId);
  }
}
```

- [ ] **Step 4: Re-run the focused hook/dashboard tests**

Run: `rtk npm test -- test/runtime-hooks.test.ts test/dashboard.test.ts`

Expected: PASS with the new disabled-project and dashboard-disabled assertions.

- [ ] **Step 5: Commit the runtime gating**

```bash
rtk git add src/runtime/create-extension-runtime.ts test/runtime-hooks.test.ts test/dashboard.test.ts
rtk git commit -m "feat: gate runtime by project control state"
```

---

### Task 5: Ignore Project Artifacts and Clean the Root Repo Noise

**Files:**
- Modify: `.gitignore`
- Remove: `AGENTS.md`
- Remove: `CLAUDE.md`
- Remove: `.claude/`

- [ ] **Step 1: Add `.pi/.pi-ninja/` to local-artifact ignore rules**

```gitignore
.worktrees/
node_modules/
dist/
docs/superpowers/
.gitnexus
.pi/.pi-ninja/
```

- [ ] **Step 2: Verify the ignore rule before deleting root artifacts**

Run: `rtk git check-ignore -v .pi/.pi-ninja/.pcn_disabled`

Expected: `.gitignore` is reported as the matching ignore source.

- [ ] **Step 3: Remove the requested root-level artifacts**

Run:

```bash
rtk rm -rf .claude AGENTS.md CLAUDE.md
```

Expected: the files disappear from the repo root, while `docs/` remains untouched.

- [ ] **Step 4: Run full verification**

Run:

```bash
rtk npm run check
rtk git status --short
rtk git diff --name-only HEAD~5..HEAD
```

Expected:

- `typecheck` passes
- full Vitest suite passes
- status shows only the intended cleanup/config/command/runtime changes
- diff scope matches the project-control feature and root cleanup only

- [ ] **Step 5: Commit the cleanup and verification pass**

```bash
rtk git add .gitignore
rtk git add -u
rtk git commit -m "chore: clean repo artifacts and ignore pcn local state"
```

---

## Self-Review

### Spec coverage

- Pi-native install only: covered by command-surface scope and no `/pcn install` work.
- `/pcn status|doctor|export|enable|disable|enable dashboard|disable dashboard`: covered by Task 3.
- Project-local `.pi/.pi-ninja/` markers with default-on semantics: covered by Task 1.
- Control plane always available while data plane is gated: covered by Tasks 3 and 4.
- Dashboard-only toggle and analytics remaining active when enabled: covered by Task 4.
- Root cleanup for `AGENTS.md`, `CLAUDE.md`, `.claude/`: covered by Task 5.

### Placeholder scan

- No `TODO`, `TBD`, or “similar to above” placeholders remain.
- Each code step contains the exact file and the exact command to run next.

### Type consistency

- Control-state functions use one naming set across tasks: `enableProject`, `disableProject`, `enableProjectDashboard`, `disableProjectDashboard`.
- Runtime gate naming is consistent: `isProjectEnabled`, `isProjectDashboardEnabled`.
- Reporting types use one naming set across tasks: `ProjectStatus`, `ProjectDoctorReport`.

