import { describe, it, expect } from "bun:test";
import { shortCircuit } from "../src/strategies/short-circuit";

describe("short-circuit", () => {
  it("replaces JSON ok", () => {
    expect(shortCircuit('{"status":"ok"}', false, 2000)).toBe("[ok]");
  });
  it("replaces test summary", () => {
    expect(shortCircuit("Tests: 52 passed, 0 failed", false, 2000)).toBe("[tests: 52 passed]");
  });
  it("skips results above maxTokens", () => {
    expect(shortCircuit('{"status":"ok"}', false, 3)).toBeNull();
  });
  it("keeps results at exactly maxTokens", () => {
    expect(shortCircuit('{"status":"ok"}', false, 4)).toBe("[ok]");
  });
  it("no-op on error", () => {
    expect(shortCircuit("ENOENT error", true, 2000)).toBeNull();
  });
  it("no-op on unknown", () => {
    expect(shortCircuit("random output", false, 2000)).toBeNull();
  });
});
