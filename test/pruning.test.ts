import { describe, it, expect } from "vitest";
import { applyOmitRanges } from "../src/strategies/pruning";

describe("pruning", () => {
  it("filters omitted ranges using transcript offsets", () => {
    const messages = [
      { role: "u", _k: "a", _key: "a" },
      { role: "a", _k: "b", _key: "b" },
      { role: "t", _k: "c", _key: "c" },
      { role: "u", _k: "d", _key: "d" },
    ] as any;
    const ranges = [
      {
        startTurn: 1,
        endTurn: 2,
        startOffset: 1,
        endOffset: 2,
        indexedAt: 0,
        summaryRef: "",
        messageCount: 2,
      },
    ];

    const result = applyOmitRanges(messages, ranges);

    expect(result).toHaveLength(2);
    expect(result.map((msg: any) => msg._k)).toEqual(["a", "d"]);
  });

  it("no-op with empty ranges keeps length 2", () => {
    const messages = [
      { role: "u", _k: "a", _key: "a" },
      { role: "a", _k: "b", _key: "b" },
    ] as any;

    const result = applyOmitRanges(messages, []);

    expect(result).toHaveLength(2);
    expect(result.map((msg: any) => msg._k)).toEqual(["a", "b"]);
  });
});
