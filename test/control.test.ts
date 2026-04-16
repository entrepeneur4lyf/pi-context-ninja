import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { disableProject, disableProjectDashboard } from "../src/control/project-state.js";
import { buildProjectDoctorReport } from "../src/control/doctor.js";
import { exportProjectDoctorReport } from "../src/control/export.js";
import { buildProjectStatus } from "../src/control/status.js";

describe("project control reporting", () => {
  it("builds a concise status model for the current project", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-control-status-"));
    const configPath = path.join(projectDir, ".pi-ninja-config.yaml");

    const status = buildProjectStatus({
      projectPath: projectDir,
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

  it("treats dashboard opt-out as healthy when runtime is otherwise fine", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-control-status-"));
    disableProjectDashboard(projectDir);

    const report = buildProjectDoctorReport({
      projectPath: projectDir,
      configPath: "/tmp/config.yaml",
      runtimeLoaded: true,
      degradedReasons: [],
    });

    expect(report.status.mode).toBe("full");
    expect(report.status.dashboardEnabled).toBe(false);
    expect(report.findings).toEqual(["No compatibility or runtime degradation detected."]);
  });

  it("marks disabled and degraded states in the doctor report", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-control-status-"));
    disableProject(projectDir);

    const report = buildProjectDoctorReport({
      projectPath: projectDir,
      configPath: "/tmp/config.yaml",
      runtimeLoaded: true,
      degradedReasons: ["dashboard startup failed"],
    });

    expect(report.status.mode).toBe("disabled");
    expect(report.findings).toContain("Extension runtime is disabled for this project.");
    expect(report.findings).toContain("dashboard startup failed");
  });

  it("exports a markdown report beneath .pi/.pi-ninja/reports", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-control-status-"));
    const reportPath = exportProjectDoctorReport({
      projectPath: projectDir,
      report: buildProjectDoctorReport({
        projectPath: projectDir,
        configPath: "/tmp/config.yaml",
        runtimeLoaded: true,
        degradedReasons: [],
      }),
    });

    expect(reportPath).toContain(path.join(".pi", ".pi-ninja", "reports"));
    const reportBody = fs.readFileSync(reportPath, "utf8");
    expect(reportBody).toContain("# Pi Context Ninja Diagnostic Report");
    expect(reportBody).toContain("Config path: `/tmp/config.yaml`");
  });
});
