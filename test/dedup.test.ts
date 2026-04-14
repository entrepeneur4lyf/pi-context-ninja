import { describe, it, expect } from "vitest";
import { fingerprintDedup } from "../src/strategies/dedup";

describe("dedup", () => {
  it("first occurrence passes", () => {
    const seen = new Set<string>();

    expect(fingerprintDedup("c1", "read", 'read::{"path":"f"}', seen)).toBeNull();
    expect(seen.size).toBe(1);
  });

  it("duplicate gets tombstone", () => {
    const seen = new Set<string>();
    const fingerprint = 'read::{"path":"f"}';

    fingerprintDedup("c1", "read", fingerprint, seen);

    expect(fingerprintDedup("c2", "read", fingerprint, seen)).toBe("[dedup: see latest read result]");
  });

  it("protected tools never deduped", () => {
    const seen = new Set<string>();
    const fingerprint = 'write::{"path":"f"}';

    expect(fingerprintDedup("c1", "write", fingerprint, seen, ["write", "edit"])).toBeNull();
    expect(seen.size).toBe(0);
    expect(fingerprintDedup("c2", "write", fingerprint, seen, ["write", "edit"])).toBeNull();
    expect(seen.size).toBe(0);
  });
});
