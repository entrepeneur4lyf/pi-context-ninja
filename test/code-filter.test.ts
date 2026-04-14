import { describe, it, expect } from "vitest";
import { codeFilter, detectLanguage } from "../src/strategies/code-filter";

describe("code-filter", () => {
  it("strips Python body", () => {
    const r = codeFilter("def greet():\n    return 'hi'", "python");
    expect(r).toContain("def greet():");
    expect(r).not.toContain("return");
  });
  it("strips TS function body", () => {
    const r = codeFilter("function greet(): string {\n  return 'hi';\n}", "typescript");
    expect(r).toContain("function greet()");
    expect(r).not.toContain("return");
  });
  it("keeps imports", () => {
    const r = codeFilter("import os\n\ndef main():\n    pass", "python");
    expect(r).toContain("import os");
  });
  it("detects Python", () => { expect(detectLanguage("def foo():\n    pass")).toBe("python"); });
  it("detects TypeScript", () => { expect(detectLanguage("function foo(): void {}")).toBe("typescript"); });
  it("returns null for non-code", () => { expect(codeFilter("just plain text", "text")).toBeNull(); });
});
