import { describe, it, expect } from "vitest";
import {
  extractTextContent,
  getToolName,
  isError,
  isToolResultMessage,
  replaceToolContent,
  replaceToolTextContent,
} from "../src/messages";

describe("message helpers", () => {
  it("extracts text", () => {
    expect(extractTextContent({ role: "toolResult", content: [{ type: "text", text: "hello" }] } as any)).toBe("hello");
  });
  it("identifies toolResult", () => {
    expect(isToolResultMessage({ role: "toolResult" } as any)).toBe(true);
    expect(isToolResultMessage({ role: "user" } as any)).toBe(false);
  });
  it("treats custom messages as opaque", () => {
    const customMsg = { kind: "notification", text: "done" } as any;

    expect(isToolResultMessage(customMsg)).toBe(false);
    expect(extractTextContent(customMsg)).toBe("");
  });
  it("gets tool name", () => {
    expect(getToolName({ role: "toolResult", toolName: "bash" } as any)).toBe("bash");
  });
  it("checks error", () => {
    expect(isError({ role: "toolResult", isError: true } as any)).toBe(true);
    expect(isError({ role: "toolResult", isError: false } as any)).toBe(false);
  });
  it("replaces text while preserving images", () => {
    const msg = {
      role: "toolResult",
      content: [
        { type: "text", text: "old" },
        { type: "image", data: "img-data", mimeType: "image/png" },
      ],
    } as any;

    const textOnly = replaceToolTextContent(msg, "new");
    expect(textOnly.content).toHaveLength(2);
    expect(textOnly.content[0]).toMatchObject({ type: "text", text: "new" });
    expect(textOnly.content[1]).toMatchObject({ type: "image", data: "img-data", mimeType: "image/png" });
  });

  it("keeps replaceToolContent compatibility for string replacement", () => {
    const msg = { role: "toolResult", content: [{ type: "text", text: "old" }] } as any;
    const replaced = replaceToolContent(msg, "new");

    expect((replaced as any).content[0].text).toBe("new");
  });
});
