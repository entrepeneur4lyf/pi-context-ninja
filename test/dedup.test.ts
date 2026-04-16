import { describe, it, expect } from "vitest";
import { fingerprintDedup, normalizeContent } from "../src/strategies/dedup";

describe("dedup", () => {
  it("first occurrence passes", () => {
    const seen = new Map<string, number>();

    expect(fingerprintDedup("c1", "read", "read::alpha", seen, 2)).toBeNull();
    expect(seen.size).toBe(1);
  });

  it("deduplicates repeated occurrences when the fingerprint already encodes provenance", () => {
    const seen = new Map<string, number>();
    const normalized = normalizeContent("build 2026-04-14T10:11:12Z abcdefab-cdef-4123-89ab-abcdefabcdef");
    const fingerprint = `read::${normalized}::{\"path\":\"a.log\"}`;

    expect(fingerprintDedup("c1", "read", fingerprint, seen, 1)).toBeNull();
    expect(fingerprintDedup("c2", "read", fingerprint, seen, 1)).toBe("[dedup: see earlier read result x1]");
  });

  it("allows repeated content up to maxOccurrences", () => {
    const seen = new Map<string, number>();
    const fingerprint = "read::stable";

    expect(fingerprintDedup("c1", "read", fingerprint, seen, 2)).toBeNull();
    expect(fingerprintDedup("c2", "read", fingerprint, seen, 2)).toBeNull();
    expect(fingerprintDedup("c3", "read", fingerprint, seen, 2)).toBe("[dedup: see earlier read result x2]");
  });

  it("protected tools never deduped", () => {
    const seen = new Map<string, number>();
    const fingerprint = 'write::{"path":"f"}';

    expect(fingerprintDedup("c1", "write", fingerprint, seen, 2, ["write", "edit"])).toBeNull();
    expect(seen.size).toBe(0);
    expect(fingerprintDedup("c2", "write", fingerprint, seen, 2, ["write", "edit"])).toBeNull();
    expect(seen.size).toBe(0);
  });
});
