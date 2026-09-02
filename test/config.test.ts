import { describe, it, expect } from "bun:test";
import { loadConfig, defaultConfig } from "../src/config";
import { getUserDir, resolveRuntimeConfigPath } from "../src/paths";
import fs from "fs";
import path from "path";
import os from "os";

describe("config", () => {
  it("returns defaults when no config file exists", () => {
    const config = loadConfig("/nonexistent/config.yaml");
    expect(config.systemHint.enabled).toBe(true);
    expect(config.systemHint.frequency).toBe("once_per_session");
    expect(config.strategies.shortCircuit).toEqual({ enabled: true, maxTokens: 2000 });
    expect(config.strategies.codeFilter.enabled).toBe(false);
    expect(config.shaping.protectedTools).toEqual(["write", "edit", "task"]);
    expect("protectedTools" in config.strategies.deduplication).toBe(false);
    expect(config.strategies.codeFilter.maxBodyLines).toBe(200);
    expect(config.strategies.codeFilter.keepImports).toBe(true);
    expect(config.strategies.deduplication.maxOccurrences).toBe(2);
    expect(config.strategies.truncation).toEqual({
      enabled: true,
      headLines: 100,
      tailLines: 50,
      minLines: 300,
    });
    expect(config.strategies.errorPurge).toEqual({
      enabled: true,
      maxTurnsAgo: 3,
    });
  });

  it("loads and overrides from YAML", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-"));
    const cfgPath = path.join(tmpDir, "config.yaml");
    try {
      fs.writeFileSync(
        cfgPath,
        [
          "systemHint:",
          "  enabled: false",
          "  frequency: always",
          "  text: custom hint",
          "nativeCompactionIntegration:",
          "  enabled: true",
          "  fallbackOnFailure: false",
          "  maxContextSize: 12345",
          "strategies:",
          "  shortCircuit:",
          "    maxTokens: 1234",
          "  codeFilter:",
          "    maxBodyLines: 88",
          "    keepImports: false",
          "  deduplication:",
          "    maxOccurrences: 7",
          "shaping:",
          "  protectedTools:",
          "    - task",
          "    - job",
        ].join("\n"),
      );

      const config = loadConfig(cfgPath);
      expect(config.systemHint.enabled).toBe(false);
      expect(config.systemHint.frequency).toBe("always");
      expect(config.systemHint.text).toBe("custom hint");
      expect(config.strategies.shortCircuit.maxTokens).toBe(1234);
      expect(config.shaping.protectedTools).toEqual(["task", "job"]);
      expect(config.strategies.codeFilter.maxBodyLines).toBe(88);
      expect(config.strategies.codeFilter.keepImports).toBe(false);
      expect(config.strategies.deduplication.maxOccurrences).toBe(7);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("defaultConfig has all blocks", () => {
    const d = defaultConfig();
    expect(d.strategies.shortCircuit).toBeDefined();
    expect(d.strategies.codeFilter).toBeDefined();
    expect(d.strategies.truncation).toBeDefined();
    expect(d.strategies.deduplication).toBeDefined();
    expect(d.strategies.errorPurge).toBeDefined();
    expect(d.analytics).toBeDefined();
    expect(d.dashboard).toBeDefined();
    expect(d.systemHint).toBeDefined();
    expect("backgroundIndexing" in d).toBe(false);
    expect("nativeCompactionIntegration" in d).toBe(false);
  });

  it("drops withdrawn keys without error", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-"));
    const cfgPath = path.join(tmpDir, "config.yaml");
    try {
      fs.writeFileSync(
        cfgPath,
        [
          "backgroundIndexing:",
          "  enabled: true",
          "  minRangeTurns: 4",
          "nativeCompactionIntegration:",
          "  enabled: true",
          "  maxContextSize: 32768",
        ].join("\n"),
      );
      const config = loadConfig(cfgPath);
      expect("backgroundIndexing" in config).toBe(false);
      expect("nativeCompactionIntegration" in config).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores deprecated and unknown YAML keys outside the supported contract", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-"));
    const cfgPath = path.join(tmpDir, "config.yaml");
    try {
      fs.writeFileSync(
        cfgPath,
        [
          "strategies:",
          "  truncation:",
          "    minLines: 111",
          "    strategy: smart",
          "  errorPurge:",
          "    maxTurnsAgo: 9",
          "    patterns:",
          "      - timeout",
          "backgroundIndexing:",
          "  minRangeTurns: 4",
          "  maxFiles: 10",
          "  debounceMs: 250",
          "unsupportedTopLevel: true",
        ].join("\n"),
      );

      const config = loadConfig(cfgPath);
      expect(config.strategies.truncation).toEqual({
        enabled: true,
        headLines: 100,
        tailLines: 50,
        minLines: 111,
      });
      expect("strategy" in config.strategies.truncation).toBe(false);
      expect(config.strategies.errorPurge).toEqual({
        enabled: true,
        maxTurnsAgo: 9,
      });
      expect("patterns" in config.strategies.errorPurge).toBe(false);
      expect("backgroundIndexing" in config).toBe(false);
      expect("unsupportedTopLevel" in (config as object)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves the config path from the host agent directory or PCN_CONFIG_PATH", () => {
    const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    const savedConfigPath = process.env.PCN_CONFIG_PATH;
    try {
      delete process.env.PCN_CONFIG_PATH;
      delete process.env.PI_CODING_AGENT_DIR;
      expect(resolveRuntimeConfigPath()).toBe(path.join(os.homedir(), ".omp", "agent", "pcn", "config.yaml"));
      expect(getUserDir()).toBe(path.join(os.homedir(), ".omp", "agent", "pcn"));

      process.env.PI_CODING_AGENT_DIR = "/tmp/agent-dir";
      expect(resolveRuntimeConfigPath()).toBe(path.join("/tmp/agent-dir", "pcn", "config.yaml"));

      process.env.PCN_CONFIG_PATH = "/tmp/explicit.yaml";
      expect(resolveRuntimeConfigPath()).toBe("/tmp/explicit.yaml");
    } finally {
      if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
      if (savedConfigPath === undefined) delete process.env.PCN_CONFIG_PATH; else process.env.PCN_CONFIG_PATH = savedConfigPath;
    }
  });
});

describe("dashboard config", () => {
  it("defaults the dashboard to enabled with the alt+n shortcut and drops the withdrawn listener keys", () => {
    expect(defaultConfig().dashboard).toEqual({ enabled: true, shortcut: "alt+n" });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-dashboard-config-"));
    const cfgPath = path.join(tmpDir, "config.yaml");
    try {
      fs.writeFileSync(
        cfgPath,
        ["dashboard:", "  enabled: false", "  port: 48900", '  bindHost: "127.0.0.1"', '  shortcut: "ctrl+alt+d"'].join("\n"),
        "utf8",
      );
      expect(loadConfig(cfgPath).dashboard).toEqual({ enabled: false, shortcut: "ctrl+alt+d" });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
