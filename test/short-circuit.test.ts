import { describe, it, expect } from "vitest";
import { shortCircuit } from "../src/strategies/short-circuit";

describe("short-circuit", () => {
  it("replaces JSON ok", () => {
    expect(shortCircuit('{"status":"ok"}', false)).toBe("[ok]");
  });
  it("replaces test summary", () => {
    expect(shortCircuit("Tests: 52 passed, 0 failed", false)).toBe("[tests: 52 passed]");
  });
  it("no-op on error", () => {
    expect(shortCircuit("ENOENT error", true)).toBeNull();
  });
  it("no-op on unknown", () => {
    expect(shortCircuit("random output", false)).toBeNull();
  });
});
