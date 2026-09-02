import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../src/config";
import { hasHashlineHeader, isHostPruned, isProtectedTool, isReadResult } from "../src/strategies/protection";

describe("protection", () => {
  it("recognizes the read tool", () => {
    expect(isReadResult("read")).toBe(true);
    expect(isReadResult("grep")).toBe(false);
  });

  it("recognizes a hashline header line", () => {
    expect(hasHashlineHeader("[src/a.ts#ab12cd]\n1:export const a = 1;\n2:")).toBe(true);
    expect(hasHashlineHeader("plain text\n[not a header]")).toBe(false);
    expect(hasHashlineHeader("note [src/a.ts#ab12cd] inline")).toBe(false);
  });

  it("reads the protected list from config", () => {
    const config = defaultConfig();
    expect(isProtectedTool("task", config)).toBe(true);
    expect(isProtectedTool("bash", config)).toBe(false);
  });

  it("recognizes a host-pruned result by its prunedAt stamp", () => {
    expect(isHostPruned({ role: "toolResult", prunedAt: 1 } as never)).toBe(true);
    expect(isHostPruned({ role: "toolResult" } as never)).toBe(false);
  });
});
