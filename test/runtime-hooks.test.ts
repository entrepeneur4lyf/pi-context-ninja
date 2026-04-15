import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import registerExtension from "../src/index.js";

describe("runtime hook registration", () => {
  it("registers the Pi 0.67.2 extension hooks", () => {
    const calls: Array<[string, (...args: unknown[]) => unknown]> = [];
    const pi = {
      on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
        calls.push([name, handler]);
      }),
    } as unknown as ExtensionAPI;

    registerExtension(pi);

    expect(calls.map(([name]) => name)).toEqual([
      "tool_call",
      "tool_result",
      "context",
      "turn_end",
      "before_agent_start",
      "before_provider_request",
      "session_before_compact",
      "agent_end",
      "session_shutdown",
    ]);
    expect(calls).toHaveLength(9);
    expect(calls.every(([, handler]) => typeof handler === "function")).toBe(true);
  });
});
