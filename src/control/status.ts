import type { PCNConfig } from "../config.js";
import { readProjectControlState } from "./project-state.js";

export interface ProjectStatus {
  projectPath: string;
  controlDir: string;
  configPath: string;
  runtimeLoaded: boolean;
  enabled: boolean;
  dashboardEnabled: boolean;
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
  const mode = !control.enabled
    ? "disabled"
    : !input.runtimeLoaded || input.degradedReasons.length > 0
      ? "degraded"
      : "full";

  return {
    projectPath: input.projectPath,
    controlDir: control.controlDir,
    configPath: input.configPath,
    runtimeLoaded: input.runtimeLoaded,
    enabled: control.enabled,
    dashboardEnabled: control.dashboardEnabled,
    mode,
    degradedReasons: [...input.degradedReasons],
  };
}
