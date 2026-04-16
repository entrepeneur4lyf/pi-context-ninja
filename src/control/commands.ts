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

function notifyStatus(ctx: ExtensionCommandContext, projectPath: string): void {
  const status = buildProjectStatus({
    projectPath,
    configPath: resolveRuntimeConfigPath(),
    runtimeLoaded: true,
    degradedReasons: [],
  });

  ctx.ui.notify(
    `PCN ${status.mode} for ${status.projectPath}\nDashboard: ${status.dashboardEnabled ? "enabled" : "disabled"}`,
    "info",
  );
}

function notifyDoctor(ctx: ExtensionCommandContext, projectPath: string): void {
  const report = buildProjectDoctorReport({
    projectPath,
    configPath: resolveRuntimeConfigPath(),
    runtimeLoaded: true,
    degradedReasons: [],
  });

  ctx.ui.notify(report.findings.join("\n"), "info");
}

function notifyExport(ctx: ExtensionCommandContext, projectPath: string): void {
  const report = buildProjectDoctorReport({
    projectPath,
    configPath: resolveRuntimeConfigPath(),
    runtimeLoaded: true,
    degradedReasons: [],
  });
  const reportPath = exportProjectDoctorReport({ projectPath, report });

  ctx.ui.notify(`Exported PCN report to ${reportPath}`, "info");
}

export function registerProjectControlCommands(pi: ExtensionAPI): void {
  pi.registerCommand("pcn", {
    description: "Pi Context Ninja project controls",
    handler: async (args, ctx) => {
      const projectPath = requireProjectPath(ctx);
      if (!projectPath) {
        return;
      }

      const [action, target] = parsePcnArgs(args);

      if (action === "status" && target === undefined) {
        notifyStatus(ctx, projectPath);
        return;
      }

      if (action === "doctor" && target === undefined) {
        notifyDoctor(ctx, projectPath);
        return;
      }

      if (action === "export" && target === undefined) {
        notifyExport(ctx, projectPath);
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
