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

function requireProjectPath(projectPath: string): string {
  if (projectPath.trim().length === 0) {
    throw new Error("Project path must be a non-blank string.");
  }

  return projectPath;
}

export function resolveProjectControlDir(projectPath: string): string {
  return path.join(requireProjectPath(projectPath), ...CONTROL_DIR_PARTS);
}

export function ensureProjectControlDir(projectPath: string): string {
  const controlDir = resolveProjectControlDir(projectPath);
  fs.mkdirSync(controlDir, { recursive: true });
  return controlDir;
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

export function disableProject(projectPath: string): void {
  const controlDir = ensureProjectControlDir(projectPath);
  fs.writeFileSync(path.join(controlDir, DISABLED_MARKER), "", "utf8");
}

export function enableProject(projectPath: string): void {
  fs.rmSync(path.join(resolveProjectControlDir(projectPath), DISABLED_MARKER), { force: true });
}

export function disableProjectDashboard(projectPath: string): void {
  const controlDir = ensureProjectControlDir(projectPath);
  fs.writeFileSync(path.join(controlDir, DASHBOARD_DISABLED_MARKER), "", "utf8");
}

export function enableProjectDashboard(projectPath: string): void {
  fs.rmSync(path.join(resolveProjectControlDir(projectPath), DASHBOARD_DISABLED_MARKER), {
    force: true,
  });
}
