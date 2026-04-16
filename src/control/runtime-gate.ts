import { readProjectControlState } from "./project-state.js";

function hasProjectPath(projectPath?: string): projectPath is string {
  return typeof projectPath === "string" && projectPath.trim().length > 0;
}

export function isProjectEnabled(projectPath?: string): boolean {
  if (!hasProjectPath(projectPath)) {
    return false;
  }

  return readProjectControlState(projectPath).enabled;
}

export function isProjectDashboardEnabled(projectPath?: string): boolean {
  if (!hasProjectPath(projectPath)) {
    return false;
  }

  const state = readProjectControlState(projectPath);
  return state.enabled && state.dashboardEnabled;
}
