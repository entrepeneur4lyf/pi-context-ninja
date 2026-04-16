import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  disableProject,
  disableProjectDashboard,
  enableProject,
  enableProjectDashboard,
  readProjectControlState,
  resolveProjectControlDir,
} from "../src/control/project-state.js";
import { isProjectDashboardEnabled, isProjectEnabled } from "../src/control/runtime-gate.js";

const tempDirs: string[] = [];

function makeProjectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-project-state-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("project control state", () => {
  it("defaults to enabled when no markers exist", () => {
    const projectDir = makeProjectDir();
    const state = readProjectControlState(projectDir);

    expect(resolveProjectControlDir(projectDir)).toBe(path.join(projectDir, ".pi", ".pi-ninja"));
    expect(state.enabled).toBe(true);
    expect(state.dashboardEnabled).toBe(true);
    expect(isProjectEnabled(projectDir)).toBe(true);
    expect(isProjectDashboardEnabled(projectDir)).toBe(true);
  });

  it("creates marker directories on demand and flips extension enablement", () => {
    const projectDir = makeProjectDir();

    expect(fs.existsSync(resolveProjectControlDir(projectDir))).toBe(false);
    disableProject(projectDir);
    expect(fs.existsSync(resolveProjectControlDir(projectDir))).toBe(true);
    expect(readProjectControlState(projectDir).enabled).toBe(false);

    enableProject(projectDir);
    expect(readProjectControlState(projectDir).enabled).toBe(true);
  });

  it("preserves dashboard preference independently of full enablement", () => {
    const projectDir = makeProjectDir();

    disableProjectDashboard(projectDir);
    expect(readProjectControlState(projectDir)).toMatchObject({
      enabled: true,
      dashboardEnabled: false,
    });

    disableProject(projectDir);
    enableProject(projectDir);
    expect(readProjectControlState(projectDir)).toMatchObject({
      enabled: true,
      dashboardEnabled: false,
    });

    enableProjectDashboard(projectDir);
    expect(readProjectControlState(projectDir).dashboardEnabled).toBe(true);
  });

  it("treats equivalent project path variants as the same control directory", () => {
    const projectDir = makeProjectDir();
    const projectDirWithTrailingSlash = `${projectDir}${path.sep}`;

    disableProject(projectDirWithTrailingSlash);
    disableProjectDashboard(projectDirWithTrailingSlash);

    expect(resolveProjectControlDir(projectDirWithTrailingSlash)).toBe(resolveProjectControlDir(projectDir));
    expect(readProjectControlState(projectDir)).toMatchObject({
      projectPath: projectDir,
      enabled: false,
      dashboardEnabled: false,
    });
    expect(isProjectEnabled(projectDir)).toBe(false);
    expect(isProjectDashboardEnabled(projectDir)).toBe(false);

    enableProject(projectDir);
    enableProjectDashboard(projectDir);
    expect(readProjectControlState(projectDirWithTrailingSlash)).toMatchObject({
      projectPath: projectDir,
      enabled: true,
      dashboardEnabled: true,
    });
  });

  it("rejects blank project paths", () => {
    for (const projectPath of ["", " ", "\n\t "]) {
      expect(() => resolveProjectControlDir(projectPath)).toThrow("Project path must be a non-blank string.");
      expect(() => readProjectControlState(projectPath)).toThrow("Project path must be a non-blank string.");
      expect(() => disableProject(projectPath)).toThrow("Project path must be a non-blank string.");
      expect(() => enableProject(projectPath)).toThrow("Project path must be a non-blank string.");
      expect(() => disableProjectDashboard(projectPath)).toThrow("Project path must be a non-blank string.");
      expect(() => enableProjectDashboard(projectPath)).toThrow("Project path must be a non-blank string.");
      expect(isProjectEnabled(projectPath)).toBe(false);
      expect(isProjectDashboardEnabled(projectPath)).toBe(false);
    }
  });

  it("treats blank cwd values as passthrough in the runtime gate", () => {
    expect(isProjectEnabled()).toBe(false);
    expect(isProjectDashboardEnabled()).toBe(false);

    for (const projectPath of ["", " ", "\n\t "]) {
      expect(isProjectEnabled(projectPath)).toBe(false);
      expect(isProjectDashboardEnabled(projectPath)).toBe(false);
    }
  });
});
