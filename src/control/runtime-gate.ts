import { readProjectControlState } from "./project-state.js";

export function isProjectEnabled(projectPath?: string): boolean {
  if (projectPath === undefined) {
    return true;
  }

  return readProjectControlState(projectPath).enabled;
}

export function isProjectDashboardEnabled(projectPath?: string): boolean {
  if (projectPath === undefined) {
    return true;
  }

  const state = readProjectControlState(projectPath);
  return state.enabled && state.dashboardEnabled;
}
