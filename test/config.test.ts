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
});
