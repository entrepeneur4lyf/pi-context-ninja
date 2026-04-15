import { describe, it, expect } from "vitest";
import { loadConfig, defaultConfig } from "../src/config";
import fs from "fs";
import path from "path";
import os from "os";

describe("config", () => {
  it("returns defaults when no config file exists", () => {
    const config = loadConfig("/nonexistent/config.yaml");
    expect(config.systemHint.enabled).toBe(true);
    expect(config.systemHint.frequency).toBe("once_per_session");
    expect(config.nativeCompactionIntegration.enabled).toBe(false);
    expect(config.nativeCompactionIntegration.fallbackOnFailure).toBe(true);
    expect(config.nativeCompactionIntegration.maxContextSize).toBe(0);
    expect(config.backgroundIndexing.enabled).toBe(true);
    expect(config.strategies.shortCircuit.minTokens).toBe(8000);
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
    expect(config.backgroundIndexing).toEqual({
      enabled: true,
      minRangeTurns: 8,
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
          "    minTokens: 1234",
          "  codeFilter:",
          "    maxBodyLines: 88",
          "    keepImports: false",
          "  deduplication:",
          "    maxOccurrences: 7",
        ].join("\n"),
      );

      const config = loadConfig(cfgPath);
      expect(config.systemHint.enabled).toBe(false);
      expect(config.systemHint.frequency).toBe("always");
      expect(config.systemHint.text).toBe("custom hint");
      expect(config.nativeCompactionIntegration.enabled).toBe(true);
      expect(config.nativeCompactionIntegration.fallbackOnFailure).toBe(false);
      expect(config.nativeCompactionIntegration.maxContextSize).toBe(12345);
      expect(config.strategies.shortCircuit.minTokens).toBe(1234);
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
    expect(d.backgroundIndexing).toBeDefined();
    expect(d.analytics).toBeDefined();
    expect(d.dashboard).toBeDefined();
    expect(d.systemHint).toBeDefined();
    expect(d.nativeCompactionIntegration).toBeDefined();
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
      expect(config.backgroundIndexing).toEqual({
        enabled: true,
        minRangeTurns: 4,
      });
      expect("maxFiles" in config.backgroundIndexing).toBe(false);
      expect("debounceMs" in config.backgroundIndexing).toBe(false);
      expect("unsupportedTopLevel" in (config as object)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
