import { describe, expect, it } from "bun:test";
import { isOverlayCloseKey } from "../src/dashboard/keys";

describe("isOverlayCloseKey", () => {
  it("treats plain, kitty, and modifyOtherKeys Escape as the close key", () => {
    expect(isOverlayCloseKey("\x1b")).toBe(true);
    expect(isOverlayCloseKey("\x1b[27u")).toBe(true);
    expect(isOverlayCloseKey("\x1b[27;1u")).toBe(true);
    expect(isOverlayCloseKey("\x1b[27;1;27~")).toBe(true);
  });

  it("treats q as the close key and nothing else", () => {
    expect(isOverlayCloseKey("q")).toBe(true);
    expect(isOverlayCloseKey("Q")).toBe(false);
    expect(isOverlayCloseKey("\x1bn")).toBe(false);
    expect(isOverlayCloseKey("\x1b[A")).toBe(false);
    expect(isOverlayCloseKey("\x1b[27;1;28~")).toBe(false);
    expect(isOverlayCloseKey("")).toBe(false);
  });
});
