import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { resolveRuntimeConfigPath } from "../config.js";
import { buildProjectDoctorReport } from "./doctor.js";
import { exportProjectDoctorReport } from "./export.js";
import {
  disableProject,
  disableProjectDashboard,
  enableProject,
  enableProjectDashboard,
} from "./project-state.js";
import { buildProjectStatus } from "./status.js";

const USAGE_MESSAGE = "Usage: /pcn status|doctor|export|enable|disable|enable dashboard|disable dashboard";

export interface CommandRuntimeHealth {
  configPath: string;
  runtimeLoaded: boolean;
  degradedReasons: string[];
}

export function createCommandRuntimeHealth(): CommandRuntimeHealth {
  return {
    configPath: resolveRuntimeConfigPath(),
    runtimeLoaded: false,
    degradedReasons: [],
  };
}

function parsePcnArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

function requireProjectPath(ctx: ExtensionCommandContext): string | null {
  if (typeof ctx.cwd !== "string" || ctx.cwd.trim().length === 0) {
    ctx.ui.notify("Pi Context Ninja commands require an active project directory.", "warning");
    return null;
  }

  return ctx.cwd;
}

function buildStatusMessage(projectPath: string, runtimeHealth: CommandRuntimeHealth): string {
  const status = buildProjectStatus({
    projectPath,
    configPath: runtimeHealth.configPath,
    runtimeLoaded: runtimeHealth.runtimeLoaded,
    degradedReasons: runtimeHealth.degradedReasons,
  });

  const lines = [
    `PCN ${status.mode} for ${status.projectPath}`,
    `Config: ${status.configPath}`,
    `Dashboard: ${status.dashboardEnabled ? "enabled" : "disabled"}`,
  ];

  if (status.degradedReasons.length > 0) {
    lines.push(`Degraded: ${status.degradedReasons.join(" | ")}`);
  }

  return lines.join("\n");
}

function buildDoctorMessage(projectPath: string, runtimeHealth: CommandRuntimeHealth): string {
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

function exportDoctorReport(projectPath: string, runtimeHealth: CommandRuntimeHealth): string {
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
  getRuntimeHealth: () => CommandRuntimeHealth,
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
        ctx.ui.notify("Pi Context Ninja dashboard enabled for this project.", "info");
        return;
      }

      if (action === "disable" && target === "dashboard") {
        disableProjectDashboard(projectPath);
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
        ctx.ui.notify("Pi Context Ninja disabled for this project.", "info");
        return;
      }

      ctx.ui.notify(USAGE_MESSAGE, "warning");
    },
  });
}
