import fs from "node:fs";
import path from "node:path";
import type { ProjectDoctorReport } from "./doctor.js";
import { ensureProjectControlDir } from "./project-state.js";

function formatFindingItems(findings: string[]): string[] {
  if (findings.length === 0) {
    return ["- No findings."];
  }

  return findings.map((finding) => `- ${finding}`);
}

export function exportProjectDoctorReport(input: {
  projectPath: string;
  report: ProjectDoctorReport;
}): string {
  const reportsDir = path.join(ensureProjectControlDir(input.projectPath), "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const reportPath = path.join(reportsDir, `doctor-${Date.now()}.md`);
  const { status, findings } = input.report;
  const markdown = [
    "# Pi Context Ninja Diagnostic Report",
    "",
    "## Project",
    `- Project path: \`${status.projectPath}\``,
    `- Control dir: \`${status.controlDir}\``,
    `- Config path: \`${status.configPath}\``,
    `- Runtime loaded: ${status.runtimeLoaded ? "yes" : "no"}`,
    `- Mode: \`${status.mode}\``,
    `- Dashboard enabled: ${status.dashboardEnabled ? "yes" : "no"}`,
    "",
    "## Findings",
    ...formatFindingItems(findings),
    "",
  ].join("\n");

  fs.writeFileSync(reportPath, markdown, "utf8");
  return reportPath;
}
