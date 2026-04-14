import { describe, it, expect } from "vitest";
import { normalizeContent } from "../src/normalizer";

describe("normalizer", () => {
  it("replaces timestamps", () => {
    expect(normalizeContent("2026-04-13T03:51:30Z")).toBe("__TS__");
  });
  it("replaces UUIDs", () => {
    expect(normalizeContent("550e8400-e29b-41d4-a716-446655440000")).toBe("__UUID__");
  });
  it("replaces hashes", () => {
    expect(normalizeContent("916714ab0bf9ace5fc8ca4e677d89420e285c45b")).toBe("__HASH__");
  });
  it("leaves normal text", () => {
    expect(normalizeContent("hello world")).toBe("hello world");
  });
});
