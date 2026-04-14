import { describe, it, expect } from "vitest";
import { buildIndexEntry, formatTOC } from "../src/compression/index-entry";
describe("index entry", () => {
  it("builds entry", () => {
    const e = buildIndexEntry(0, 10, "setup", 15);
    expect(e.turnRange).toBe("0-10");
    expect(e.topic).toBe("setup");
  });
  it("formats TOC", () => {
    const toc = formatTOC([{turnRange:"0-10",topic:"a"},{turnRange:"11-20",topic:"b"}]);
    expect(toc).toContain("0-10");
  });
});
