import { describe, it, expect } from "vitest";
import {
  extractTextContent,
  getToolName,
  isError,
  isToolResultMessage,
  replaceToolContent,
  replaceToolTextContent,
  replaceSingleToolTextContent,
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

  it("leaves multi-text results unchanged for string replacement", () => {
    const msg = {
      role: "toolResult",
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "img-data", mimeType: "image/png" },
        { type: "text", text: "b" },
      ],
    } as any;

    const textOnly = replaceToolTextContent(msg, "new");
    expect(textOnly.content).toHaveLength(3);
    expect(textOnly.content[0]).toMatchObject({ type: "text", text: "a" });
    expect(textOnly.content[1]).toMatchObject({ type: "image", data: "img-data", mimeType: "image/png" });
    expect(textOnly.content[2]).toMatchObject({ type: "text", text: "b" });
  });

  it("keeps replaceToolContent compatibility for string replacement", () => {
    const msg = { role: "toolResult", content: [{ type: "text", text: "old" }] } as any;
    const replaced = replaceToolContent(msg, "new");

    expect((replaced as any).content[0].text).toBe("new");
  });

  it("leaves multi-text results unchanged through replaceToolContent string compatibility", () => {
    const msg = {
      role: "toolResult",
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "img-data", mimeType: "image/png" },
        { type: "text", text: "b" },
      ],
    } as any;

    const replaced = replaceToolContent(msg, "new");

    expect(replaced).toEqual(msg);
  });

  it("replaces a single text block without merging surrounding blocks", () => {
    const msg = {
      role: "toolResult",
      content: [
        { type: "image", data: "img-1", mimeType: "image/png" },
        { type: "text", text: "old" },
        { type: "image", data: "img-2", mimeType: "image/png" },
      ],
    } as any;

    const replaced = replaceSingleToolTextContent(msg, "new");

    expect(replaced.content).toHaveLength(3);
    expect(replaced.content[0]).toMatchObject({ type: "image", data: "img-1", mimeType: "image/png" });
    expect(replaced.content[1]).toMatchObject({ type: "text", text: "new" });
    expect(replaced.content[2]).toMatchObject({ type: "image", data: "img-2", mimeType: "image/png" });
  });
});
