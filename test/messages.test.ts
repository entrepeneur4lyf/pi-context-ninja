import { describe, it, expect } from "vitest";
import { extractTextContent, isToolResultMessage, getToolName, isError, replaceToolContent } from "../src/messages";

describe("message helpers", () => {
  it("extracts text", () => {
    expect(extractTextContent({ role: "toolResult", content: [{ type: "text", text: "hello" }] } as any)).toBe("hello");
  });
  it("identifies toolResult", () => {
    expect(isToolResultMessage({ role: "toolResult" } as any)).toBe(true);
    expect(isToolResultMessage({ role: "user" } as any)).toBe(false);
  });
  it("gets tool name", () => {
    expect(getToolName({ role: "toolResult", toolName: "bash" } as any)).toBe("bash");
  });
  it("checks error", () => {
    expect(isError({ role: "toolResult", isError: true } as any)).toBe(true);
    expect(isError({ role: "toolResult", isError: false } as any)).toBe(false);
  });
  it("replaces content", () => {
    const msg = { role: "toolResult", content: [{ type: "text", text: "old" }] } as any;
    const replaced = replaceToolContent(msg, "new");
    expect((replaced as any).content[0].text).toBe("new");
  });
});
