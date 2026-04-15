# Pi Context Ninja Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Pi Context Ninja into a Pi `0.67.2`-correct extension with real silent-first pruning, real indexing/analytics/dashboard behavior, and verification that covers the actual Pi hook and message boundaries.

**Architecture:** Keep the public product surface by default, but reorganize internals into a thin Pi hook adapter, a typed message/materialization pipeline, a turn-aware persistence and indexing layer, and an optional observability layer. Use Pi `0.67.2` source as the runtime contract and treat every surviving config field and documented subsystem as either implemented-and-verified or explicitly removed with inline evidence.

**Tech Stack:** TypeScript, Vitest, Node `http`, YAML, `better-sqlite3`, `@mariozechner/pi-coding-agent@0.67.2`, `@mariozechner/pi-ai@0.67.2`, `@mariozechner/pi-agent-core@0.67.2`

---

### Task 1: Pin Pi 0.67.2 And Establish A Deterministic Verification Baseline

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Add direct Pi runtime dependencies and a single verification script**

Update `package.json` so the repo no longer depends on hidden ambient installs. Use these exact dependency additions and script:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest --run",
    "test:watch": "vitest",
    "check": "npm run typecheck && npm test"
  },
  "dependencies": {
    "@mariozechner/pi-coding-agent": "0.67.2",
    "@mariozechner/pi-ai": "0.67.2",
    "@mariozechner/pi-agent-core": "0.67.2",
    "better-sqlite3": "^11.0.0",
    "yaml": "^2.7.0"
  },
  "engines": {
    "node": ">=20.6.0"
  }
}
```

- [ ] **Step 2: Make TypeScript compilation deterministic for both source and tests**

Update `tsconfig.json` so the project uses a stable pre-migration ESM baseline and includes test globals without relying on editor magic. Do not force the repo into a `NodeNext` explicit-extension migration in this task:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "types": ["node", "vitest/globals"],
    "strict": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": ".",
    "declaration": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Install the pinned dependencies**

Run: `rtk npm install`

Expected: lockfile updated with `@mariozechner/pi-coding-agent@0.67.2`, `@mariozechner/pi-ai@0.67.2`, and `@mariozechner/pi-agent-core@0.67.2`.

- [ ] **Step 4: Record the current failing contract state before implementation**

Run: `rtk npm run typecheck`

Expected: FAIL with the current Pi-compatibility and local baseline errors concentrated in `src/index.ts`, `src/messages.ts`, `src/config.ts`, `test/config.test.ts`, and `src/compression/index-entry.ts`, but without a broad `TS2835` import-extension cascade.

- [ ] **Step 5: Commit**

```bash
rtk git add package.json package-lock.json tsconfig.json
rtk git commit -m "chore: pin Pi 0.67.2 dependencies"
```

### Task 2: Replace The Entrypoint With A Thin Pi 0.67.2 Hook Adapter

**Files:**
- Create: `src/runtime/create-extension-runtime.ts`
- Modify: `src/index.ts`
- Modify: `src/config.ts`
- Test: `test/runtime-hooks.test.ts`

- [ ] **Step 1: Write the failing hook-registration test**

Create `test/runtime-hooks.test.ts` with a fake `ExtensionAPI` and mocked runtime factory so the test proves `src/index.ts` registers the expected Pi hooks without burying logic inside the entrypoint:

```ts
import { describe, expect, it, vi } from "vitest";

const runtime = {
  onToolCall: vi.fn(),
  onToolResult: vi.fn(),
  onContext: vi.fn(),
  onTurnEnd: vi.fn(),
  onBeforeAgentStart: vi.fn(),
  onBeforeProviderRequest: vi.fn(),
  onSessionBeforeCompact: vi.fn(),
  onAgentEnd: vi.fn(),
  onSessionShutdown: vi.fn(),
};

vi.mock("../src/runtime/create-extension-runtime.js", () => ({
  createExtensionRuntime: () => runtime,
}));

import pcnExtension from "../src/index";

describe("index hook adapter", () => {
  it("registers Pi 0.67.2 hooks", () => {
    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)),
    } as any;

    pcnExtension(pi);

    expect(handlers.has("tool_call")).toBe(true);
    expect(handlers.has("tool_result")).toBe(true);
    expect(handlers.has("context")).toBe(true);
    expect(handlers.has("turn_end")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("before_provider_request")).toBe(true);
    expect(handlers.has("session_before_compact")).toBe(true);
    expect(handlers.has("agent_end")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `rtk npm test -- test/runtime-hooks.test.ts`

Expected: FAIL because the runtime module does not exist and `src/index.ts` still wires the wrong handler shape.

- [ ] **Step 3: Create the runtime adapter surface**

Create `src/runtime/create-extension-runtime.ts` with one exported factory and one runtime interface. Keep the methods narrow and event-specific:

```ts
import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeProviderRequestEvent,
  ContextEvent,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
  TurnEndEvent,
} from "@mariozechner/pi-coding-agent";

export interface ExtensionRuntime {
  onToolCall(event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | void | Promise<ToolCallEventResult | void>;
  onToolResult(event: ToolResultEvent, ctx: ExtensionContext): ToolResultEventResult | void | Promise<ToolResultEventResult | void>;
  onContext(event: ContextEvent, ctx: ExtensionContext): { messages?: ContextEvent["messages"] } | Promise<{ messages?: ContextEvent["messages"] }>;
  onTurnEnd(event: TurnEndEvent, ctx: ExtensionContext): void | Promise<void>;
  onBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): BeforeAgentStartEventResult | void | Promise<BeforeAgentStartEventResult | void>;
  onBeforeProviderRequest(event: BeforeProviderRequestEvent, ctx: ExtensionContext): unknown;
  onSessionBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): SessionBeforeCompactResult | void | Promise<SessionBeforeCompactResult | void>;
  onAgentEnd(event: AgentEndEvent, ctx: ExtensionContext): void | Promise<void>;
  onSessionShutdown(): void;
}

export interface RuntimeDependencies {
  config?: PCNConfig;
  now?: () => number;
}

export function createExtensionRuntime(deps: RuntimeDependencies = {}): ExtensionRuntime {
  throw new Error("not implemented");
}
```

- [ ] **Step 4: Reduce `src/index.ts` to pure registration**

Replace `src/index.ts` with a thin adapter:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createExtensionRuntime } from "./runtime/create-extension-runtime.js";

export default function pcnExtension(pi: ExtensionAPI) {
  const runtime = createExtensionRuntime();

  pi.on("tool_call", (event, ctx) => runtime.onToolCall(event, ctx));
  pi.on("tool_result", (event, ctx) => runtime.onToolResult(event, ctx));
  pi.on("context", (event, ctx) => runtime.onContext(event, ctx));
  pi.on("turn_end", (event, ctx) => runtime.onTurnEnd(event, ctx));
  pi.on("before_agent_start", (event, ctx) => runtime.onBeforeAgentStart(event, ctx));
  pi.on("before_provider_request", (event, ctx) => runtime.onBeforeProviderRequest(event, ctx));
  pi.on("session_before_compact", (event, ctx) => runtime.onSessionBeforeCompact(event, ctx));
  pi.on("agent_end", (event, ctx) => runtime.onAgentEnd(event, ctx));
  pi.on("session_shutdown", () => runtime.onSessionShutdown());
}
```

- [ ] **Step 5: Make the runtime factory construct configuration once**

Extend `src/config.ts` with a validated loader entrypoint for the runtime to call:

```ts
export function loadRuntimeConfig(): PCNConfig {
  const configPath = process.env.PCN_CONFIG_PATH ?? `${process.env.HOME}/.pi-ninja/config.yaml`;
  return loadConfig(configPath);
}
```

- [ ] **Step 6: Run the hook-adapter test and typecheck**

Run: `rtk npm test -- test/runtime-hooks.test.ts && rtk npm run typecheck`

Expected: the new hook test passes; typecheck still fails deeper in the runtime implementation, but `src/index.ts` no longer contributes event-order errors.

- [ ] **Step 7: Commit**

```bash
rtk git add src/index.ts src/config.ts src/runtime/create-extension-runtime.ts test/runtime-hooks.test.ts
rtk git commit -m "fix: align extension entrypoint with Pi 0.67.2 hooks"
```

### Task 3: Make Message Classification And Tool-Result Rewriting Type-Safe

**Files:**
- Modify: `src/messages.ts`
- Modify: `test/messages.test.ts`
- Modify: `test/materialize.test.ts`

- [ ] **Step 1: Write failing mixed-content and custom-message tests**

Extend `test/messages.test.ts` with the cases the current helper layer gets wrong:

```ts
it("keeps non-tool custom messages opaque", () => {
  const msg = { role: "notification", text: "hello", timestamp: Date.now() } as any;
  expect(isToolResultMessage(msg)).toBe(false);
  expect(extractTextContent(msg)).toBe("");
});

it("rewrites only text blocks and preserves images", () => {
  const msg = {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    isError: false,
    timestamp: Date.now(),
    content: [
      { type: "text", text: "before" },
      { type: "image", data: "abc", mimeType: "image/png" },
    ],
  } as any;

  const replaced = replaceToolTextContent(msg, () => "after");
  expect(replaced.content[0]).toEqual({ type: "text", text: "after" });
  expect(replaced.content[1]).toEqual({ type: "image", data: "abc", mimeType: "image/png" });
});
```

- [ ] **Step 2: Run the targeted tests to verify failure**

Run: `rtk npm test -- test/messages.test.ts test/materialize.test.ts`

Expected: FAIL because `replaceToolTextContent` does not exist and `replaceToolContent()` rewrites the whole content array.

- [ ] **Step 3: Rewrite `src/messages.ts` around real Pi message types**

Replace the current helper layer with explicit type guards and safe text mapping:

```ts
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";

export function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
  return (message as { role?: string }).role === "toolResult";
}

export function extractTextContent(message: AgentMessage): string {
  if (!isToolResultMessage(message)) return "";
  return message.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export function isTextOnlyToolResult(message: ToolResultMessage): boolean {
  return message.content.every((item) => item.type === "text");
}

export function replaceToolTextContent(
  message: ToolResultMessage,
  mapText: (text: string) => string,
): ToolResultMessage {
  return {
    ...message,
    content: message.content.map((item) =>
      item.type === "text" ? ({ type: "text", text: mapText(item.text) } satisfies TextContent) : item
    ) as (TextContent | ImageContent)[],
  };
}
```

- [ ] **Step 4: Update `materialize.test.ts` to assert safe rewriting**

Adjust the tool-result expectations so materialization works through the new helper:

```ts
const toolMsg = result.messages?.find((m: any) => m.role === "toolResult") as any;
expect(toolMsg.content).toEqual([{ type: "text", text: "[ok]" }]);
```

Add a second case for a mixed text/image tool result:

```ts
expect(toolMsg.content[1]).toEqual({ type: "image", data: "abc", mimeType: "image/png" });
```

- [ ] **Step 5: Run the targeted tests**

Run: `rtk npm test -- test/messages.test.ts test/materialize.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add src/messages.ts test/messages.test.ts test/materialize.test.ts
rtk git commit -m "fix: make tool result message handling type-safe"
```

### Task 4: Make Config And Strategy Behavior Match The Public Surface

**Files:**
- Modify: `src/config.ts`
- Modify: `src/normalizer.ts`
- Modify: `src/strategies/short-circuit.ts`
- Modify: `src/strategies/code-filter.ts`
- Modify: `src/strategies/dedup.ts`
- Modify: `src/strategies/truncation.ts`
- Modify: `src/strategies/error-purge.ts`
- Modify: `src/strategies/materialize.ts`
- Modify: `test/config.test.ts`
- Modify: `test/code-filter.test.ts`
- Modify: `test/dedup.test.ts`
- Modify: `test/short-circuit.test.ts`
- Modify: `test/materialize.test.ts`

- [ ] **Step 1: Write failing tests for currently dead config fields**

Add or extend tests for:

- `strategies.shortCircuit.minTokens`
- `strategies.codeFilter.maxBodyLines`
- `strategies.codeFilter.keepImports`
- `strategies.deduplication.maxOccurrences`

Use exact test shapes like:

```ts
it("deduplicates repeated content across distinct tool calls", () => {
  const seen = new Map<string, number>();
  const fingerprint = createToolResultFingerprint("read", [{ type: "text", text: "same" }]);
  expect(applyDeduplication("c1", "read", fingerprint, seen, 2)).toBeNull();
  expect(applyDeduplication("c2", "read", fingerprint, seen, 2)).toBeNull();
  expect(applyDeduplication("c3", "read", fingerprint, seen, 2)).toBe("[dedup: see earlier read result x2]");
});
```

```ts
it("honors keepImports and maxBodyLines for python", () => {
  const result = codeFilter("import os\n\ndef a():\n    x=1\n    y=2\n    z=3\n", "python", {
    keepDocstrings: false,
    keepImports: true,
    maxBodyLines: 1,
  });
  expect(result).toContain("import os");
  expect(result).toContain("def a():");
  expect(result).not.toContain("z=3");
});
```

- [ ] **Step 2: Run the focused strategy tests**

Run: `rtk npm test -- test/config.test.ts test/code-filter.test.ts test/dedup.test.ts test/short-circuit.test.ts test/materialize.test.ts`

Expected: FAIL because the runtime does not consume those config fields yet.

- [ ] **Step 3: Fix `config.ts` typing and validation**

Replace the unsafe merge cast with an explicit typed loader:

```ts
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function loadConfig(configPath: string): PCNConfig {
  const defaults = defaultConfig();
  if (!fs.existsSync(configPath)) return defaults;
  const parsed = asRecord(YAML.parse(fs.readFileSync(configPath, "utf-8")));
  return deepMerge(defaults as unknown as Record<string, unknown>, parsed) as unknown as PCNConfig;
}
```

- [ ] **Step 4: Implement real strategy consumers**

Make the strategy functions consume the public config surface:

```ts
export function createToolResultFingerprint(toolName: string, content: { type: string; text?: string }[]): string {
  const text = content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
  return `${toolName}::${normalizeContent(text)}`;
}

export function applyDeduplication(
  toolCallId: string,
  toolName: string,
  fingerprint: string,
  seen: Map<string, number>,
  maxOccurrences: number,
): string | null {
  void toolCallId;
  const nextCount = (seen.get(fingerprint) ?? 0) + 1;
  seen.set(fingerprint, nextCount);
  return nextCount > maxOccurrences ? `[dedup: see earlier ${toolName} result x${maxOccurrences}]` : null;
}
```

```ts
export function shortCircuit(text: string, approxContextTokens: number | null, minTokens: number): string | null {
  if (approxContextTokens !== null && approxContextTokens < minTokens) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed.status === "ok" || parsed.success === true) return "[ok]";
  } catch {}
  const testMatch = text.match(/(\d+)\s+passed/);
  if (testMatch) return `[tests: ${testMatch[1]} passed]`;
  if (text.includes("Already up to date")) return "[git: up to date]";
  if (/file written/i.test(text) || /^\[ok:\s*file.*written/i.test(text)) return "[file written]";
  return null;
}
```

```ts
export interface CodeFilterOptions {
  keepDocstrings: boolean;
  keepImports: boolean;
  maxBodyLines: number;
}
```

Also fix the triple-single-quote bug in `code-filter.ts` by matching `'''` rather than `'''''`.

- [ ] **Step 5: Thread the new options through `materialize.ts`**

Use the runtime config values rather than hard-coded behavior:

```ts
const approxContextTokens = state.lastContextTokens;
const candidate = shortCircuit(currentText, approxContextTokens, config.strategies.shortCircuit.minTokens);
```

```ts
const fingerprint = createToolResultFingerprint(toolName, msg.content);
const candidate = applyDeduplication(
  toolCallId,
  toolName,
  fingerprint,
  seen,
  config.strategies.deduplication.maxOccurrences,
);
```

- [ ] **Step 6: Run the focused suite and typecheck**

Run: `rtk npm test -- test/config.test.ts test/code-filter.test.ts test/dedup.test.ts test/short-circuit.test.ts test/materialize.test.ts && rtk npm run typecheck`

Expected: strategy tests pass; remaining type failures move into persistence/runtime tasks.

- [ ] **Step 7: Commit**

```bash
rtk git add src/config.ts src/normalizer.ts src/strategies/*.ts test/config.test.ts test/code-filter.test.ts test/dedup.test.ts test/short-circuit.test.ts test/materialize.test.ts
rtk git commit -m "fix: implement config-backed compression strategies"
```

### Task 5: Make Turn Bookkeeping And Persistence Deterministic

**Files:**
- Modify: `src/types.ts`
- Modify: `src/state.ts`
- Modify: `src/persistence/state-store.ts`
- Modify: `src/runtime/create-extension-runtime.ts`
- Modify: `test/state-store.test.ts`
- Modify: `test/state.test.ts`
- Modify: `test/runtime-hooks.test.ts`

- [ ] **Step 1: Write failing persistence and turn-lifecycle tests**

Extend tests so they assert:

- `currentTurn` advances from `turn_end`
- `toolCalls` and `countedSavingsIds` survive save/load
- `lastContextTokens`, `lastContextPercent`, and `lastContextWindow` persist
- `turnHistory` stores enough information to resolve transcript offsets later

Use test shapes like:

```ts
it("persists tool call and savings bookkeeping", async () => {
  const s = createSessionState("/tmp");
  getOrCreateToolRecord(s, "t1", "read", { path: "a.ts" }, false, 3);
  creditSavings(s, "t1", "dedup", 10, 12);
  saveSessionState("s1", s);
  const loaded = loadSessionState("s1");
  expect(loaded?.toolCalls).toHaveLength(1);
  expect(loaded?.countedSavingsIds).toEqual(["t1:dedup"]);
});
```

- [ ] **Step 2: Run the persistence tests to verify failure**

Run: `rtk npm test -- test/state.test.ts test/state-store.test.ts test/runtime-hooks.test.ts`

Expected: FAIL because the state store does not serialize maps/sets or track real turns.

- [ ] **Step 3: Expand the persisted state model**

Update `src/types.ts` and `src/persistence/state-store.ts` so serializable state contains arrays for maps/sets:

```ts
export interface PersistedState {
  omitRanges: OmitRange[];
  currentTurn: number;
  tokensKeptOutTotal: number;
  tokensSaved: number;
  tokensKeptOutByType: Record<string, number>;
  tokensSavedByType: Record<string, number>;
  turnHistory: TurnSnapshot[];
  projectPath: string;
  toolCalls: ToolRecord[];
  countedSavingsIds: string[];
  lastContextTokens: number | null;
  lastContextPercent: number | null;
  lastContextWindow: number | null;
}
```

Also extend `TurnSnapshot` in `src/types.ts` so indexing can resolve transcript offsets without guessing:

```ts
export interface TurnSnapshot {
  turnIndex: number;
  toolCount: number;
  tokensKeptOutDelta: number;
  tokensSavedDelta: number;
  messageCountAfterTurn: number;
  timestamp: number;
}
```

- [ ] **Step 4: Add serialization helpers in `state.ts`**

Implement explicit conversion helpers:

```ts
export function toPersistedState(state: SessionState): PersistedState {
  return {
    omitRanges: state.omitRanges,
    currentTurn: state.currentTurn,
    tokensKeptOutTotal: state.tokensKeptOutTotal,
    tokensSaved: state.tokensSaved,
    tokensKeptOutByType: state.tokensKeptOutByType,
    tokensSavedByType: state.tokensSavedByType,
    turnHistory: state.turnHistory,
    projectPath: state.projectPath,
    toolCalls: [...state.toolCalls.values()],
    countedSavingsIds: [...state.countedSavingsIds],
    lastContextTokens: state.lastContextTokens,
    lastContextPercent: state.lastContextPercent,
    lastContextWindow: state.lastContextWindow,
  };
}
```

```ts
export function hydrateSessionState(persisted: PersistedState): SessionState {
  return {
    ...createSessionState(persisted.projectPath),
    omitRanges: persisted.omitRanges,
    currentTurn: persisted.currentTurn,
    tokensKeptOutTotal: persisted.tokensKeptOutTotal,
    tokensSaved: persisted.tokensSaved,
    tokensKeptOutByType: persisted.tokensKeptOutByType,
    tokensSavedByType: persisted.tokensSavedByType,
    turnHistory: persisted.turnHistory,
    toolCalls: new Map(persisted.toolCalls.map((record) => [record.toolCallId, record])),
    countedSavingsIds: new Set(persisted.countedSavingsIds),
    lastContextTokens: persisted.lastContextTokens,
    lastContextPercent: persisted.lastContextPercent,
    lastContextWindow: persisted.lastContextWindow,
  };
}
```

- [ ] **Step 5: Use `turn_end` and context usage in the runtime**

In `src/runtime/create-extension-runtime.ts`, update state from real Pi signals:

```ts
onTurnEnd(event, ctx) {
  const state = this.getState(ctx);
  state.currentTurn = event.turnIndex;
  const usage = ctx.getContextUsage();
  state.lastContextTokens = usage?.tokens ?? null;
  state.lastContextPercent = usage?.percent ?? null;
  state.lastContextWindow = usage?.contextWindow ?? null;
  state.turnHistory.push({
    turnIndex: event.turnIndex,
    toolCount: event.toolResults.length,
    tokensKeptOutDelta: 0,
    tokensSavedDelta: 0,
    messageCountAfterTurn: state.turnHistory.at(-1)?.messageCountAfterTurn ?? 0,
    timestamp: Date.now(),
  });
}
```

- [ ] **Step 6: Run the persistence/lifecycle suite**

Run: `rtk npm test -- test/state.test.ts test/state-store.test.ts test/runtime-hooks.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add src/types.ts src/state.ts src/persistence/state-store.ts src/runtime/create-extension-runtime.ts test/state.test.ts test/state-store.test.ts test/runtime-hooks.test.ts
rtk git commit -m "fix: persist turn-aware runtime state"
```

### Task 6: Implement Real Background Indexing And Omit-Range Pruning

**Files:**
- Create: `src/runtime/index-manager.ts`
- Modify: `src/types.ts`
- Modify: `src/compression/index-entry.ts`
- Modify: `src/compression/range-selection.ts`
- Modify: `src/compression/summarizer.ts`
- Modify: `src/persistence/index-store.ts`
- Modify: `src/strategies/pruning.ts`
- Modify: `src/runtime/create-extension-runtime.ts`
- Modify: `test/range-selection.test.ts`
- Modify: `test/index-entry.test.ts`
- Modify: `test/index-store.test.ts`
- Modify: `test/pruning.test.ts`

- [ ] **Step 1: Write failing indexing tests**

Add tests for:

- stale range selection after enough turns
- index entry creation from a transcript slice
- omit-range application using transcript offsets

Use exact expectations like:

```ts
it("creates an omit range from a stale transcript slice", () => {
  const range = buildIndexedRange({
    startTurn: 1,
    endTurn: 3,
    startOffset: 2,
    endOffset: 8,
    topic: "readme cleanup",
    messageCount: 7,
  });
  expect(range.startOffset).toBe(2);
  expect(range.endOffset).toBe(8);
});
```

- [ ] **Step 2: Run the indexing suite to verify failure**

Run: `rtk npm test -- test/range-selection.test.ts test/index-entry.test.ts test/index-store.test.ts test/pruning.test.ts`

Expected: FAIL because there is no runtime producer for indexed ranges and the current pruning model is key-based only.

- [ ] **Step 3: Change `OmitRange` to transcript-offset storage**

Update `src/types.ts` to carry turn and offset anchors instead of message keys:

```ts
export interface OmitRange {
  startTurn: number;
  endTurn: number;
  startOffset: number;
  endOffset: number;
  indexedAt: number;
  summaryRef: string;
  messageCount: number;
}
```

- [ ] **Step 4: Implement a runtime index manager**

Create `src/runtime/index-manager.ts`:

```ts
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { PCNConfig } from "../config.js";
import type { SessionState } from "../types.js";
import { buildIndexEntry } from "../compression/index-entry.js";
import { selectStaleRanges } from "../compression/range-selection.js";
import { extractTopicFromRange } from "../compression/summarizer.js";
import { appendIndexEntry } from "../persistence/index-store.js";

function resolveTurnOffsets(state: SessionState, startTurn: number, endTurn: number): { startOffset: number; endOffset: number } | null {
  const previousTurn = state.turnHistory.find((entry) => entry.turnIndex === startTurn - 1);
  const endTurnEntry = state.turnHistory.find((entry) => entry.turnIndex === endTurn);
  if (!endTurnEntry) return null;
  const startOffset = previousTurn?.messageCountAfterTurn ?? 0;
  const endOffset = endTurnEntry.messageCountAfterTurn - 1;
  return endOffset >= startOffset ? { startOffset, endOffset } : null;
}

export function refreshRangeIndex(messages: AgentMessage[], state: SessionState, config: PCNConfig): void {
  if (!config.backgroundIndexing.enabled) return;
  const lastIndexedTurn = state.omitRanges.at(-1)?.endTurn ?? -1;
  const stale = selectStaleRanges(state.currentTurn, lastIndexedTurn, config.backgroundIndexing.minRangeTurns);
  if (!stale) return;
  const offsets = resolveTurnOffsets(state, stale.startTurn, stale.endTurn);
  if (!offsets) return;
  const { startOffset, endOffset } = offsets;
  const slice = messages.slice(startOffset, endOffset + 1);
  const topic = extractTopicFromRange(slice);
  const entry = buildIndexEntry(stale.startTurn, stale.endTurn, topic, slice.length);
  appendIndexEntry(state.indexFilePath, entry);
  state.omitRanges.push({
    startTurn: stale.startTurn,
    endTurn: stale.endTurn,
    startOffset,
    endOffset,
    indexedAt: entry.indexedAt,
    summaryRef: entry.turnRange,
    messageCount: slice.length,
  });
}
```

- [ ] **Step 5: Make pruning offset-based**

Update `src/strategies/pruning.ts`:

```ts
export function applyOmitRanges(messages: AgentMessage[], omitRanges: OmitRange[]): AgentMessage[] {
  if (omitRanges.length === 0) return [...messages];
  const omit = new Set<number>();
  for (const range of omitRanges) {
    for (let index = range.startOffset; index <= range.endOffset; index += 1) {
      omit.add(index);
    }
  }
  return messages.filter((_, index) => !omit.has(index));
}
```

- [ ] **Step 6: Trigger index refresh on `agent_end`**

In the runtime:

```ts
onAgentEnd(event, ctx) {
  const state = this.getState(ctx);
  refreshRangeIndex(event.messages, state, this.config);
  saveSessionState(this.getSessionId(ctx), state);
}
```

- [ ] **Step 7: Run the indexing suite**

Run: `rtk npm test -- test/range-selection.test.ts test/index-entry.test.ts test/index-store.test.ts test/pruning.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
rtk git add src/runtime/index-manager.ts src/types.ts src/compression/*.ts src/persistence/index-store.ts src/strategies/pruning.ts src/runtime/create-extension-runtime.ts test/range-selection.test.ts test/index-entry.test.ts test/index-store.test.ts test/pruning.test.ts
rtk git commit -m "feat: implement indexed range pruning"
```

### Task 7: Add Real Analytics Storage And Dashboard Wiring

**Files:**
- Create: `src/analytics/store.ts`
- Create: `src/analytics/types.ts`
- Modify: `src/dashboard/server.ts`
- Modify: `src/dashboard/pages.ts`
- Modify: `src/runtime/create-extension-runtime.ts`
- Create: `test/analytics.test.ts`
- Create: `test/dashboard.test.ts`

- [ ] **Step 1: Write failing analytics and dashboard tests**

Create `test/analytics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createAnalyticsStore } from "../src/analytics/store";

describe("analytics store", () => {
  it("records turn metrics and returns totals", () => {
    const store = createAnalyticsStore(":memory:");
    store.recordTurn({
      sessionId: "s1",
      turnIndex: 1,
      contextTokens: 4000,
      contextWindow: 200000,
      contextPercent: 0.02,
      tokensSaved: 120,
      tokensKeptOut: 140,
      byStrategy: { truncation: 120 },
      recordedAt: Date.now(),
    });
    expect(store.getTotals().tokensSaved).toBe(120);
  });
});
```

Create `test/dashboard.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { startDashboardServer, stopDashboardServer } from "../src/dashboard/server";

describe("dashboard server", () => {
  afterEach(() => stopDashboardServer());

  it("serves index html on localhost", async () => {
    const server = startDashboardServer(48901, "127.0.0.1");
    const response = await fetch("http://127.0.0.1:48901/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Pi Context Ninja");
    server.close();
  });
});
```

- [ ] **Step 2: Run the analytics/dashboard tests to verify failure**

Run: `rtk npm test -- test/analytics.test.ts test/dashboard.test.ts`

Expected: FAIL because the analytics store does not exist and the dashboard is not wired for runtime state.

- [ ] **Step 3: Implement the SQLite analytics store**

Create `src/analytics/types.ts` and `src/analytics/store.ts`:

```ts
export interface TurnMetricsRow {
  sessionId: string;
  turnIndex: number;
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  tokensSaved: number;
  tokensKeptOut: number;
  byStrategy: Record<string, number>;
  recordedAt: number;
}
```

```ts
import Database from "better-sqlite3";
import type { TurnMetricsRow } from "./types.js";

export function createAnalyticsStore(dbPath: string) {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS turn_metrics (
    session_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    context_tokens INTEGER,
    context_window INTEGER,
    context_percent REAL,
    tokens_saved INTEGER NOT NULL,
    tokens_kept_out INTEGER NOT NULL,
    by_strategy TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
  )`);
  return {
    recordTurn(row: TurnMetricsRow) {
      db.prepare(`INSERT INTO turn_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.sessionId,
        row.turnIndex,
        row.contextTokens,
        row.contextWindow,
        row.contextPercent,
        row.tokensSaved,
        row.tokensKeptOut,
        JSON.stringify(row.byStrategy),
        row.recordedAt,
      );
    },
    getTotals() {
      const result = db.prepare(`SELECT COALESCE(SUM(tokens_saved), 0) AS tokensSaved, COALESCE(SUM(tokens_kept_out), 0) AS tokensKeptOut FROM turn_metrics`).get() as {
        tokensSaved: number;
        tokensKeptOut: number;
      };
      return result;
    },
    close() {
      db.close();
    },
  };
}
```

- [ ] **Step 4: Wire analytics and dashboard into the runtime**

In `src/runtime/create-extension-runtime.ts`, initialize optional analytics and dashboard once:

```ts
this.analytics = this.config.analytics.enabled
  ? createAnalyticsStore(this.config.analytics.dbPath || `${process.env.HOME}/.pi-ninja/analytics.db`)
  : null;

if (this.config.dashboard.enabled) {
  this.dashboardServer = startDashboardServer(this.config.dashboard.port, this.config.dashboard.bindHost);
}
```

Record per-turn rows on `turn_end` and broadcast live snapshots:

```ts
this.analytics?.recordTurn({
  sessionId,
  turnIndex: state.currentTurn,
  contextTokens: state.lastContextTokens,
  contextWindow: state.lastContextWindow,
  contextPercent: state.lastContextPercent,
  tokensSaved: state.tokensSaved,
  tokensKeptOut: state.tokensKeptOutTotal,
  byStrategy: state.tokensSavedByType,
  recordedAt: Date.now(),
});
```

- [ ] **Step 5: Make dashboard shutdown explicit**

In `src/dashboard/server.ts`, return a closable server and stop it on runtime shutdown:

```ts
onSessionShutdown() {
  this.analytics?.close();
  this.dashboardServer?.close();
  stopDashboardServer();
}
```

- [ ] **Step 6: Run the analytics/dashboard suite**

Run: `rtk npm test -- test/analytics.test.ts test/dashboard.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add src/analytics/store.ts src/analytics/types.ts src/dashboard/server.ts src/dashboard/pages.ts src/runtime/create-extension-runtime.ts test/analytics.test.ts test/dashboard.test.ts
rtk git commit -m "feat: add analytics storage and dashboard wiring"
```

### Task 8: Implement Optional Hooks, Update Docs, And Run Full Verification

**Files:**
- Modify: `src/runtime/create-extension-runtime.ts`
- Modify: `src/config.ts`
- Modify: `src/compression/index-entry.ts`
- Modify: `README.md`
- Modify: `docs/SPEC.md`
- Modify: `test/runtime-hooks.test.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Write failing tests for prompt guidance frequency and native compaction**

Extend `test/runtime-hooks.test.ts` with:

```ts
import { createExtensionRuntime } from "../src/runtime/create-extension-runtime";
import { defaultConfig } from "../src/config";

function makeRuntimeConfig(overrides: Record<string, unknown> = {}) {
  return {
    ...defaultConfig(),
    ...overrides,
  } as any;
}

it("returns a system prompt only once per session when frequency is once_per_session", async () => {
  const runtime = createExtensionRuntime({
    config: makeRuntimeConfig({
      systemHint: {
        enabled: true,
        text: "Stay concise.",
        frequency: "once_per_session",
      },
    }),
    now: () => 1,
  });

  const first = await runtime.onBeforeAgentStart(
    { type: "before_agent_start", prompt: "hi", images: [], systemPrompt: "Base prompt" } as any,
    {} as any,
  );
  const second = await runtime.onBeforeAgentStart(
    { type: "before_agent_start", prompt: "again", images: [], systemPrompt: "Base prompt" } as any,
    {} as any,
  );

  expect(first).toEqual({ systemPrompt: "Base prompt\n\nStay concise." });
  expect(second).toBeUndefined();
});

it("returns custom compaction when native compaction integration is enabled", async () => {
  const runtime = createExtensionRuntime({
    config: makeRuntimeConfig({
      nativeCompactionIntegration: {
        enabled: true,
        fallbackOnFailure: true,
        maxContextSize: 1000,
      },
    }),
    now: () => 1,
  });

  const result = await runtime.onSessionBeforeCompact(
    {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "entry-1", tokensBefore: 1200 } as any,
      branchEntries: [],
      signal: new AbortController().signal,
    } as any,
    {} as any,
  );

  expect(result).toEqual({
    compaction: {
      summary: expect.any(String),
      firstKeptEntryId: "entry-1",
      tokensBefore: 1200,
    },
  });
});
```

- [ ] **Step 2: Run the hook/config tests to verify failure**

Run: `rtk npm test -- test/runtime-hooks.test.ts test/config.test.ts`

Expected: FAIL because `frequency`, `fallbackOnFailure`, and `maxContextSize` are still not consumed.

- [ ] **Step 3: Implement `before_agent_start`, `before_provider_request`, and `session_before_compact`**

In `src/runtime/create-extension-runtime.ts`:

```ts
onBeforeAgentStart(event) {
  if (!this.config.systemHint.enabled) return;
  if (this.config.systemHint.frequency === "once_per_session" && this.state.systemHintShown) return;
  this.state.systemHintShown = true;
  return { systemPrompt: `${event.systemPrompt}\n\n${this.config.systemHint.text}` };
}
```

```ts
onBeforeProviderRequest(event, ctx) {
  if (!this.config.analytics.enabled) return event.payload;
  this.lastPayloadBytes = Buffer.byteLength(JSON.stringify(event.payload), "utf8");
  return event.payload;
}
```

```ts
onSessionBeforeCompact(event) {
  if (!this.config.nativeCompactionIntegration.enabled) return;
  const usage = this.state.lastContextTokens;
  const maxContextSize = this.config.nativeCompactionIntegration.maxContextSize;
  if (usage !== null && maxContextSize > 0 && usage < maxContextSize) return;
  const summary = formatTOC(readIndexEntries(this.state.indexFilePath));
  return {
    compaction: {
      summary,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    },
  };
}
```

- [ ] **Step 4: Update the docs to match the real product**

Update `README.md` and `docs/SPEC.md` so they describe:

- direct Pi `0.67.2` dependency targeting
- hook usage (`tool_call`, `tool_result`, `context`, `turn_end`, `before_agent_start`, `before_provider_request`, `session_before_compact`)
- exact analytics semantics: exact context usage vs approximate savings
- the dashboard as optional observability, not core pruning logic

Use wording like:

```md
Analytics report two classes of values:
- exact context usage snapshots from Pi runtime signals
- approximate savings deltas computed from transform output differences
```

- [ ] **Step 5: Run the full verification suite**

Run: `rtk npm run check`

Expected:

- `npm run typecheck` PASS
- `vitest --run` PASS

Then run the high-signal targeted suite:

```bash
rtk npm test -- test/runtime-hooks.test.ts test/materialize.test.ts test/messages.test.ts test/state-store.test.ts test/analytics.test.ts test/dashboard.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add src/runtime/create-extension-runtime.ts src/config.ts src/compression/index-entry.ts README.md docs/SPEC.md test/runtime-hooks.test.ts test/config.test.ts
rtk git commit -m "feat: complete Pi Context Ninja runtime integration"
```

### Task 9: Final Release Sanity Pass

**Files:**
- Modify: `README.md`
- Modify: `docs/SPEC.md`
- Modify: `package.json`

- [ ] **Step 1: Re-read the approved design and verify plan coverage**

Check [2026-04-14-pi-context-ninja-remediation-design.md](/home/shawn/workspace/pi-context-ninja/docs/superpowers/specs/2026-04-14-pi-context-ninja-remediation-design.md) against Tasks 1-8 and confirm each design section maps to at least one implementation task.

- [ ] **Step 2: Add a short “verification commands” section to the README**

Append:

```md
## Verification

```bash
rtk npm run check
rtk npm test -- test/runtime-hooks.test.ts
```
```

- [ ] **Step 3: Run one final release sanity check**

Run:

```bash
rtk npm run check
rtk npm ls @mariozechner/pi-coding-agent @mariozechner/pi-ai @mariozechner/pi-agent-core
```

Expected: PASS, with all three Pi packages resolved at `0.67.2`.

- [ ] **Step 4: Commit**

```bash
rtk git add README.md docs/SPEC.md package.json
rtk git commit -m "docs: finalize remediation verification workflow"
```
