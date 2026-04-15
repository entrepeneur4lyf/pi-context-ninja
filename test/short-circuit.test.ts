import { describe, it, expect } from "vitest";
import { shortCircuit } from "../src/strategies/short-circuit";

describe("short-circuit", () => {
  it("replaces JSON ok", () => {
    expect(shortCircuit('{"status":"ok"}', false, 4)).toBe("[ok]");
  });
  it("replaces test summary", () => {
    expect(shortCircuit("Tests: 52 passed, 0 failed", false, 4)).toBe("[tests: 52 passed]");
  });
  it("respects minTokens", () => {
    expect(shortCircuit('{"status":"ok"}', false, 5)).toBeNull();
  });
  it("no-op on error", () => {
    expect(shortCircuit("ENOENT error", true, 1)).toBeNull();
  });
  it("no-op on unknown", () => {
    expect(shortCircuit("random output", false, 1)).toBeNull();
  });
});
