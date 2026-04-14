import { describe, it, expect } from "vitest";
import { makeErrorTombstone, shouldPurgeError } from "../src/strategies/error-purge";

describe("error-purge", () => {
  it("purges old errors", () => {
    expect(shouldPurgeError(2, 6, 3)).toBe(true);
  });

  it("keeps recent errors", () => {
    expect(shouldPurgeError(4, 6, 3)).toBe(false);
  });

  it("keeps boundary case", () => {
    expect(shouldPurgeError(3, 6, 3)).toBe(false);
  });

  it("creates tombstone string", () => {
    expect(makeErrorTombstone(3)).toBe("[Error output removed -- tool failed more than 3 turns ago]");
  });
});
