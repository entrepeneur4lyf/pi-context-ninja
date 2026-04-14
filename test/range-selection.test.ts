import { describe, it, expect } from "vitest";
import { selectStaleRanges } from "../src/compression/range-selection";
describe("range selection", () => {
  it("selects stale turns", () => {
    const result = selectStaleRanges(15, -1, 8);
    expect(result).not.toBeNull();
    expect(result?.startTurn).toBe(0);
  });
  it("null if insufficient", () => { expect(selectStaleRanges(5, -1, 8)).toBeNull(); });
});
