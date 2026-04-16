import { buildProjectStatus, type ProjectStatus } from "./status.js";

export interface ProjectDoctorReport {
  status: ProjectStatus;
  findings: string[];
}

export function buildProjectDoctorReport(input: {
  projectPath: string;
  configPath: string;
  runtimeLoaded: boolean;
  degradedReasons: string[];
}): ProjectDoctorReport {
  const status = buildProjectStatus(input);
  const findings: string[] = [];

  if (!status.enabled) {
    findings.push("Extension runtime is disabled for this project.");
  }

  if (!status.runtimeLoaded) {
    findings.push("Runtime configuration could not be loaded.");
  }

  findings.push(...status.degradedReasons);

  if (findings.length === 0) {
    findings.push("No compatibility or runtime degradation detected.");
  }

  return { status, findings };
}
