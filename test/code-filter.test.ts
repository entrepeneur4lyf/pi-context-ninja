import { describe, it, expect } from "vitest";
import { codeFilter, detectLanguage } from "../src/strategies/code-filter";

describe("code-filter", () => {
  it("keeps short Python functions when under the body threshold", () => {
    const r = codeFilter("def greet():\n    return 'hi'", "python", {
      keepDocstrings: true,
      maxBodyLines: 10,
      keepImports: true,
    });
    expect(r).toBeNull();
  });
  it("strips Python bodies above the threshold and respects import/docstring knobs", () => {
    const r = codeFilter(
      [
        "import os",
        "",
        "def greet():",
        "    '''hello'''",
        "    first()",
        "    second()",
      ].join("\n"),
      "python",
      {
        keepDocstrings: true,
        maxBodyLines: 1,
        keepImports: false,
      },
    );
    expect(r).not.toBeNull();
    expect(r).not.toContain("import os");
    expect(r).toContain("def greet():");
    expect(r).toContain("'''hello'''");
    expect(r).not.toContain("second()");
  });
  it("strips TS function body", () => {
    const r = codeFilter("function greet(): string {\n  return 'hi';\n}", "typescript", {
      keepDocstrings: false,
      maxBodyLines: 1,
      keepImports: true,
    });
    expect(r).toContain("function greet()");
    expect(r).not.toContain("return");
  });
  it("keeps imports", () => {
    const r = codeFilter("import os\n\ndef main():\n    pass", "python", {
      keepDocstrings: false,
      maxBodyLines: 1,
      keepImports: true,
    });
    expect(r).toContain("import os");
  });
  it("does not swallow later Python functions after triple-single docstrings", () => {
    const r = codeFilter(
      [
        "def greet():",
        "    '''hello'''",
        "    return 'hi'",
        "",
        "def after():",
        "    pass",
      ].join("\n"),
      "python",
      {
        keepDocstrings: true,
        maxBodyLines: 1,
        keepImports: true,
      },
    );
    expect(r).toContain("def after():");
  });
  it("detects Python", () => { expect(detectLanguage("def foo():\n    pass")).toBe("python"); });
  it("detects TypeScript", () => { expect(detectLanguage("function foo(): void {}")).toBe("typescript"); });
  it("returns null for non-code", () => { expect(codeFilter("just plain text", "text")).toBeNull(); });
});
