import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { resolveRuntimeConfigPath } from "../config.js";
import { buildProjectDoctorReport } from "./doctor.js";
import { exportProjectDoctorReport } from "./export.js";
import {
  disableProject,
  disableProjectDashboard,
  enableProject,
  enableProjectDashboard,
  normalizeProjectPath,
  readProjectControlState,
} from "./project-state.js";
import { buildProjectStatus } from "./status.js";

const USAGE_MESSAGE = "Usage: /pcn status|doctor|export|enable|disable|enable dashboard|disable dashboard";

export interface CommandRuntimeHealthSnapshot {
  configPath: string;
  runtimeLoaded: boolean;
  degradedReasons: string[];
}

export interface CommandRuntimeHealth extends CommandRuntimeHealthSnapshot {
  degradedReasonEntries: Map<string, string>;
}

export interface CommandRuntimeActions {
  revokeDashboardSession?: (sessionId: string) => Promise<void> | void;
  revokeProjectDashboardSessions?: (projectPath: string) => Promise<void> | void;
}

export function createCommandRuntimeHealth(): CommandRuntimeHealth {
  return {
    configPath: resolveRuntimeConfigPath(),
    runtimeLoaded: false,
    degradedReasons: [],
    degradedReasonEntries: new Map(),
  };
}

function syncCommandRuntimeHealthDegradedReasons(runtimeHealth: CommandRuntimeHealth): void {
  runtimeHealth.degradedReasons = [...runtimeHealth.degradedReasonEntries.values()];
}

export function replaceCommandRuntimeDegradedReasons(
  runtimeHealth: CommandRuntimeHealth,
  degradedReasons: string[],
): void {
  runtimeHealth.degradedReasonEntries.clear();
  for (const [index, degradedReason] of degradedReasons.entries()) {
    runtimeHealth.degradedReasonEntries.set(`startup:${index}`, degradedReason);
  }
  syncCommandRuntimeHealthDegradedReasons(runtimeHealth);
}

export function setCommandRuntimeDegradedReason(
  runtimeHealth: CommandRuntimeHealth,
  key: string,
  degradedReason: string | null,
): void {
  if (degradedReason === null) {
    runtimeHealth.degradedReasonEntries.delete(key);
  } else {
    runtimeHealth.degradedReasonEntries.set(key, degradedReason);
  }
  syncCommandRuntimeHealthDegradedReasons(runtimeHealth);
}

function parsePcnArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

function requireProjectPath(ctx: ExtensionCommandContext): string | null {
  if (typeof ctx.cwd !== "string" || ctx.cwd.trim().length === 0) {
    ctx.ui.notify("Pi Context Ninja commands require an active project directory.", "warning");
    return null;
  }

  return normalizeProjectPath(ctx.cwd);
}

async function revokeProjectDashboardSessions(
  projectPath: string,
  runtimeActions?: CommandRuntimeActions,
): Promise<void> {
  await runtimeActions?.revokeProjectDashboardSessions?.(projectPath);
}

function buildStatusMessage(projectPath: string, runtimeHealth: CommandRuntimeHealthSnapshot): string {
  const status = buildProjectStatus({
    projectPath,
    configPath: runtimeHealth.configPath,
    runtimeLoaded: runtimeHealth.runtimeLoaded,
    degradedReasons: runtimeHealth.degradedReasons,
  });

  const lines = [
    `PCN ${status.mode} for ${status.projectPath}`,
    `Config: ${status.configPath}`,
    `Dashboard preference: ${status.dashboardEnabled ? "enabled" : "disabled"}`,
  ];

  if (!status.enabled) {
    lines.push("Dashboard active: no (PCN disabled for project)");
  } else if (!status.dashboardEnabled) {
    lines.push("Dashboard active: no (dashboard disabled for project)");
  } else {
    lines.push(`Dashboard active: ${status.dashboardActive ? "yes" : "no"}`);
  }

  if (status.degradedReasons.length > 0) {
    lines.push(`Degraded: ${status.degradedReasons.join(" | ")}`);
  }

  return lines.join("\n");
}

function buildDoctorMessage(projectPath: string, runtimeHealth: CommandRuntimeHealthSnapshot): string {
  const report = buildProjectDoctorReport({
    projectPath,
    configPath: runtimeHealth.configPath,
    runtimeLoaded: runtimeHealth.runtimeLoaded,
    degradedReasons: runtimeHealth.degradedReasons,
  });

  return [`PCN doctor for ${report.status.projectPath}`, `Config: ${report.status.configPath}`, ...report.findings].join(
    "\n",
  );
}

function exportDoctorReport(projectPath: string, runtimeHealth: CommandRuntimeHealthSnapshot): string {
  const report = buildProjectDoctorReport({
    projectPath,
    configPath: runtimeHealth.configPath,
    runtimeLoaded: runtimeHealth.runtimeLoaded,
    degradedReasons: runtimeHealth.degradedReasons,
  });

  return exportProjectDoctorReport({ projectPath, report });
}

export function registerProjectControlCommands(
  pi: ExtensionAPI,
  getRuntimeHealth: () => CommandRuntimeHealthSnapshot,
  runtimeActions?: CommandRuntimeActions,
): void {
  pi.registerCommand("pcn", {
    description: "Pi Context Ninja project controls",
    handler: async (args, ctx) => {
      const projectPath = requireProjectPath(ctx);
      if (!projectPath) {
        return;
      }

      const [action, target] = parsePcnArgs(args);

      if (action === "status" && target === undefined) {
        ctx.ui.notify(buildStatusMessage(projectPath, getRuntimeHealth()), "info");
        return;
      }

      if (action === "doctor" && target === undefined) {
        ctx.ui.notify(buildDoctorMessage(projectPath, getRuntimeHealth()), "info");
        return;
      }

      if (action === "export" && target === undefined) {
        const reportPath = exportDoctorReport(projectPath, getRuntimeHealth());
        ctx.ui.notify(`Exported PCN report to ${reportPath}`, "info");
        return;
      }

      if (action === "enable" && target === "dashboard") {
        enableProjectDashboard(projectPath);
        const controlState = readProjectControlState(projectPath);
        ctx.ui.notify(
          controlState.enabled
            ? "Pi Context Ninja dashboard enabled for this project."
            : "Pi Context Ninja dashboard enabled for this project, but Pi Context Ninja remains disabled until /pcn enable.",
          "info",
        );
        return;
      }

      if (action === "disable" && target === "dashboard") {
        disableProjectDashboard(projectPath);
        await revokeProjectDashboardSessions(projectPath, runtimeActions);
        ctx.ui.notify("Pi Context Ninja dashboard disabled for this project.", "info");
        return;
      }

      if (action === "enable" && target === undefined) {
        enableProject(projectPath);
        ctx.ui.notify("Pi Context Ninja enabled for this project.", "info");
        return;
      }

      if (action === "disable" && target === undefined) {
        disableProject(projectPath);
        await revokeProjectDashboardSessions(projectPath, runtimeActions);
        ctx.ui.notify("Pi Context Ninja disabled for this project.", "info");
        return;
      }

      ctx.ui.notify(USAGE_MESSAGE, "warning");
    },
  });
}
