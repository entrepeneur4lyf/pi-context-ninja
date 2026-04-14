import { describe, it, expect } from "vitest";
import { loadConfig, defaultConfig } from "../src/config";
import fs from "fs";
import path from "path";
import os from "os";

describe("config", () => {
  it("returns defaults when no config file exists", () => {
    const config = loadConfig("/nonexistent/config.yaml");
    expect(config.systemHint.enabled).toBe(true);
    expect(config.nativeCompactionIntegration.enabled).toBe(false);
    expect(config.backgroundIndexing.enabled).toBe(true);
  });
  it("loads and overrides from YAML", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-"));
    const cfgPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(cfgPath, "systemHint:\n  enabled: false\ntruncation:\n  headLines: 50\n");
    const config = loadConfig(cfgPath);
    expect(config.systemHint.enabled).toBe(false);
    expect(config.truncation.headLines).toBe(50);
    expect(config.nativeCompactionIntegration.enabled).toBe(false);
    fs.rmSync(tmpDir, { recursive: true });
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
