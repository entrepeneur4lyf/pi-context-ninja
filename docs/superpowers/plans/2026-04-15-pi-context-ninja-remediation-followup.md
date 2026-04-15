# Pi Context Ninja Remediation Follow-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the semantic defects found in pre-production review so Pi Context Ninja actually delivers the original silent-first Pi `0.67.2` remediation without unsafe pruning, misleading protected-tool behavior, mixed-content corruption, or ambiguous dashboard state.

**Architecture:** Replace broad omit-range pruning with explicit safe prune targets tied to tool results, make the materialization pipeline block-aware and dedup-specific in its protections, and scope analytics/dashboard reads to the active session. End with a full revalidation of the original remediation spec rather than a narrow bugfix signoff.

**Tech Stack:** TypeScript, Vitest, Node `http`, YAML, `better-sqlite3`, `@mariozechner/pi-coding-agent@0.67.2`, `@mariozechner/pi-ai@0.67.2`, `@mariozechner/pi-agent-core@0.67.2`

---

### Task 1: Replace Unsafe Omit Ranges With Safe Prune Targets

**Files:**
- Modify: `src/types.ts`
- Modify: `src/state.ts`
- Modify: `src/strategies/pruning.ts`
- Modify: `src/persistence/state-store.ts`
- Test: `test/pruning.test.ts`
- Test: `test/state-store.test.ts`

- [ ] **Step 1: Write failing pruning tests for conversation safety**

Replace `test/pruning.test.ts` with tests that prove pruning never deletes user or assistant messages and instead rewrites only targeted tool results:

```ts
import { describe, expect, it } from "vitest";
import { applyPruneTargets } from "../src/strategies/pruning";

describe("pruning", () => {
  it("rewrites only targeted tool results and preserves conversation messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "need file status" }] },
      { role: "assistant", content: "running read" },
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "very long file body" }],
      },
    ] as any;

    const result = applyPruneTargets(messages, [
      {
        toolCallId: "read-1",
        turnIndex: 1,
        indexedAt: 123,
        summaryRef: "1-1",
        replacementText: "[pruned: indexed read result 1-1]",
      },
    ]);

    expect(result).toHaveLength(3);
    expect((result[0] as any).role).toBe("user");
    expect((result[1] as any).role).toBe("assistant");
    expect((result[2] as any).content[0].text).toBe("[pruned: indexed read result 1-1]");
  });

  it("skips prune targets when the tool result is absent from the current context", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }] as any;

    expect(
      applyPruneTargets(messages, [
        {
          toolCallId: "missing",
          turnIndex: 3,
          indexedAt: 123,
          summaryRef: "2-3",
          replacementText: "[pruned]",
        },
      ]),
    ).toEqual(messages);
  });
});
```

- [ ] **Step 2: Write failing persistence tests for the new prune target model**

Extend `test/state-store.test.ts` with one round-trip test for `pruneTargets` and one legacy-safety test that drops old broad omit ranges instead of rehydrating them:

```ts
it("round-trips safe prune targets in persisted session state", async () => {
  const { saveSessionState, loadSessionState } = await loadStateStore();
  const s = createSessionState("/tmp");
  s.pruneTargets.push({
    toolCallId: "read-1",
    turnIndex: 4,
    indexedAt: 111,
    summaryRef: "2-4",
    replacementText: "[pruned: indexed read result 2-4]",
  });

  saveSessionState("s1", s);
  const loaded = loadSessionState("s1");

  expect(loaded?.pruneTargets).toEqual([
    {
      toolCallId: "read-1",
      turnIndex: 4,
      indexedAt: 111,
      summaryRef: "2-4",
      replacementText: "[pruned: indexed read result 2-4]",
    },
  ]);
});

it("drops legacy omitRanges because they cannot be rehydrated safely", async () => {
  const { loadSessionState, getStatePath } = await loadStateStore();
  const statePath = getStatePath("legacy");

  fs.writeFileSync(
    statePath,
    JSON.stringify({
      omitRanges: [
        {
          startOffset: 1,
          endOffset: 3,
          startTurn: 1,
          endTurn: 2,
          indexedAt: 111,
          summaryRef: "1-2",
          messageCount: 3,
        },
      ],
      projectPath: "/tmp/project",
    }),
    "utf8",
  );

  const loaded = loadSessionState("legacy");
  expect(loaded?.pruneTargets).toEqual([]);
});
```

- [ ] **Step 3: Run the focused tests to verify they fail on the current omit-range model**

Run: `rtk npm test -- test/pruning.test.ts test/state-store.test.ts`

Expected: FAIL because `applyPruneTargets` and `pruneTargets` do not exist yet, and the legacy state test still rehydrates broad omit ranges.

- [ ] **Step 4: Introduce the safe prune target type and state shape**

Update `src/types.ts` and `src/state.ts` so session state stores explicit prune targets instead of broad omit ranges:

```ts
export interface PruneTarget {
  toolCallId: string;
  turnIndex: number;
  indexedAt: number;
  summaryRef: string;
  replacementText: string;
}

export interface PersistedSessionState {
  toolCalls: PersistedToolCall[];
  prunedToolIds: string[];
  pruneTargets: PruneTarget[];
  tokensKeptOutTotal: number;
  tokensSaved: number;
  tokensKeptOutByType: Record<string, number>;
  tokensSavedByType: Record<string, number>;
  currentTurn: number;
  countedSavingsIds: string[];
  turnHistory: TurnSnapshot[];
  projectPath: string;
  lastContextTokens: number | null;
  lastContextPercent: number | null;
  lastContextWindow: number | null;
}

export interface SessionState {
  toolCalls: Map<string, ToolRecord>;
  prunedToolIds: Set<string>;
  pruneTargets: PruneTarget[];
  tokensKeptOutTotal: number;
  tokensSaved: number;
  tokensKeptOutByType: Record<string, number>;
  tokensSavedByType: Record<string, number>;
  currentTurn: number;
  countedSavingsIds: Set<string>;
  turnHistory: TurnSnapshot[];
  projectPath: string;
  lastContextTokens: number | null;
  lastContextPercent: number | null;
  lastContextWindow: number | null;
}
```

```ts
export function createSessionState(projectPath: string): SessionState {
  return {
    toolCalls: new Map(),
    prunedToolIds: new Set(),
    pruneTargets: [],
    tokensKeptOutTotal: 0,
    tokensSaved: 0,
    tokensKeptOutByType: {},
    tokensSavedByType: {},
    currentTurn: 0,
    countedSavingsIds: new Set(),
    turnHistory: [],
    projectPath,
    lastContextTokens: null,
    lastContextPercent: null,
    lastContextWindow: null,
  };
}
```

- [ ] **Step 5: Replace omit-range application with safe prune-target application**

Update `src/strategies/pruning.ts` so pruning rewrites eligible tool results instead of removing arbitrary message offsets:

```ts
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { PruneTarget } from "../types.js";
import { isToolResultMessage, replaceToolTextContent } from "../messages.js";

export function applyPruneTargets(messages: AgentMessage[], pruneTargets: PruneTarget[]): AgentMessage[] {
  if (pruneTargets.length === 0) {
    return [...messages];
  }

  const replacements = new Map(pruneTargets.map((target) => [target.toolCallId, target.replacementText]));

  return messages.map((message) => {
    if (!isToolResultMessage(message)) {
      return message;
    }

    const replacementText = replacements.get(message.toolCallId);
    if (!replacementText) {
      return message;
    }

    return replaceToolTextContent(message, replacementText);
  });
}
```

- [ ] **Step 6: Make persistence drop legacy unsafe omit ranges**

Update `src/persistence/state-store.ts` and `src/state.ts` so state round-trips `pruneTargets`, and old `omitRanges` are treated as non-recoverable unsafe legacy data:

```ts
export function serializeSessionState(state: SessionState): PersistedSessionState {
  return {
    toolCalls: [...state.toolCalls.entries()].map(([toolCallId, record]) => [toolCallId, serializeToolRecord(record)]),
    prunedToolIds: [...state.prunedToolIds],
    pruneTargets: state.pruneTargets.map((target) => ({ ...target })),
    tokensKeptOutTotal: state.tokensKeptOutTotal,
    tokensSaved: state.tokensSaved,
    tokensKeptOutByType: { ...state.tokensKeptOutByType },
    tokensSavedByType: { ...state.tokensSavedByType },
    currentTurn: state.currentTurn,
    countedSavingsIds: [...state.countedSavingsIds],
    turnHistory: state.turnHistory.map((snapshot) => ({ ...snapshot })),
    projectPath: state.projectPath,
    lastContextTokens: state.lastContextTokens,
    lastContextPercent: state.lastContextPercent,
    lastContextWindow: state.lastContextWindow,
  };
}
```

```ts
export function normalizePersistedSessionState(input: unknown): PersistedSessionState | null {
  if (!isRecord(input)) {
    return null;
  }

  return {
    toolCalls: normalizeToolCalls(input.toolCalls),
    prunedToolIds: normalizeStringArray(input.prunedToolIds),
    pruneTargets: normalizePruneTargets(input.pruneTargets),
    tokensKeptOutTotal: normalizeNumber(input.tokensKeptOutTotal),
    tokensSaved: normalizeNumber(input.tokensSaved),
    tokensKeptOutByType: normalizeRecord(input.tokensKeptOutByType),
    tokensSavedByType: normalizeRecord(input.tokensSavedByType),
    currentTurn: normalizeNumber(input.currentTurn),
    countedSavingsIds: normalizeStringArray(input.countedSavingsIds),
    turnHistory: Array.isArray(input.turnHistory) ? input.turnHistory.map(normalizeTurnSnapshot) : [],
    projectPath: typeof input.projectPath === "string" ? input.projectPath : "",
    lastContextTokens: normalizeNullableNumber(input.lastContextTokens),
    lastContextPercent: normalizeNullableNumber(input.lastContextPercent),
    lastContextWindow: normalizeNullableNumber(input.lastContextWindow),
  };
}

function normalizePruneTargets(value: unknown): PruneTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).flatMap((target) => {
    if (typeof target.toolCallId !== "string" || typeof target.summaryRef !== "string") {
      return [];
    }

    return [{
      toolCallId: target.toolCallId,
      turnIndex: normalizeNumber(target.turnIndex),
      indexedAt: normalizeNumber(target.indexedAt),
      summaryRef: target.summaryRef,
      replacementText:
        typeof target.replacementText === "string"
          ? target.replacementText
          : `[pruned: indexed tool result ${target.summaryRef}]`,
    }];
  });
}
```

- [ ] **Step 7: Run the focused tests to verify the new prune target model passes**

Run: `rtk npm test -- test/pruning.test.ts test/state-store.test.ts`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
rtk git add src/types.ts src/state.ts src/strategies/pruning.ts src/persistence/state-store.ts test/pruning.test.ts test/state-store.test.ts
rtk git commit -m "fix: replace unsafe omit ranges with prune targets"
```

### Task 2: Rebuild Background Indexing Around Tool-Result Prune Targets

**Files:**
- Modify: `src/runtime/index-manager.ts`
- Modify: `src/compression/index-entry.ts`
- Modify: `src/persistence/index-store.ts`
- Modify: `src/runtime/create-extension-runtime.ts`
- Test: `test/runtime-hooks.test.ts`
- Test: `test/index-entry.test.ts`

- [ ] **Step 1: Write failing tests for safe index generation**

Extend `test/runtime-hooks.test.ts` with a case proving `agent_end` produces prune targets only for tool results and leaves conversational messages intact:

```ts
it("indexes only tool results for background pruning", async () => {
  const piCalls = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
      piCalls.set(name, handler);
    }),
  } as any;

  const config = defaultConfig();
  config.backgroundIndexing.enabled = true;
  config.backgroundIndexing.minRangeTurns = 1;

  createExtensionRuntime(pi, config);

  const ctx = {
    cwd: "/tmp/project",
    sessionManager: {
      getSessionId: () => "session-a",
      getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
    },
    getContextUsage: () => ({ tokens: 400, percent: 0.4, contextWindow: 1000 }),
  } as any;

  await piCalls.get("turn_end")?.(
    {
      turnIndex: 0,
      message: { role: "assistant", content: "done" },
      toolResults: [
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "long file body" }],
        },
      ],
    },
    ctx,
  );

  await piCalls.get("agent_end")?.(
    {
      messages: [
        { role: "user", content: [{ type: "text", text: "show me the file" }] },
        { role: "assistant", content: "running read" },
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "long file body" }],
        },
      ],
    },
    ctx,
  );

  const contextResult = await piCalls.get("context")?.(
    {
      messages: [
        { role: "user", content: [{ type: "text", text: "show me the file" }] },
        { role: "assistant", content: "running read" },
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "long file body" }],
        },
      ],
    },
    ctx,
  );

  expect(contextResult.messages[0].role).toBe("user");
  expect(contextResult.messages[1].role).toBe("assistant");
  expect(contextResult.messages[2].content[0].text).toContain("[pruned:");
});
```

Add a focused `test/index-entry.test.ts` case that locks the new index entry shape:

```ts
it("builds index entries with explicit prune target descriptors", () => {
  const entry = buildIndexEntry(0, 2, "read output", 1, [
    { toolCallId: "read-1", turnIndex: 0, replacementText: "[pruned: indexed read result 0-0]" },
  ]);

  expect(entry.pruneTargets).toEqual([
    { toolCallId: "read-1", turnIndex: 0, replacementText: "[pruned: indexed read result 0-0]" },
  ]);
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `rtk npm test -- test/runtime-hooks.test.ts test/index-entry.test.ts`

Expected: FAIL because index entries do not record prune targets and runtime indexing still assumes broad range omission.

- [ ] **Step 3: Extend index entries to describe safe prune targets**

Update `src/compression/index-entry.ts` and `src/persistence/index-store.ts` so index files store explicit tool-result prune target metadata:

```ts
export interface IndexedPruneTarget {
  toolCallId: string;
  turnIndex: number;
  replacementText: string;
}

export interface IndexEntry {
  turnRange: string;
  topic: string;
  summary: string;
  timestamp: number;
  messageCount: number;
  indexedAt: number;
  pruneTargets: IndexedPruneTarget[];
}

export function buildIndexEntry(
  start: number,
  end: number,
  topic: string,
  count: number,
  pruneTargets: IndexedPruneTarget[],
): IndexEntry {
  return {
    turnRange: `${start}-${end}`,
    topic,
    summary: "",
    timestamp: Date.now(),
    messageCount: count,
    indexedAt: Date.now(),
    pruneTargets,
  };
}
```

- [ ] **Step 4: Rebuild range indexing to collect tool-result prune targets only**

Update `src/runtime/index-manager.ts` so indexing derives prune targets from tool results in the stale slice and appends those targets both to state and to the persisted index:

```ts
export function refreshRangeIndex(
  messages: AgentMessage[],
  state: SessionState,
  config: PCNConfig,
  projectPath = state.projectPath,
): PruneTarget[] {
  if (!config.backgroundIndexing.enabled) {
    return [];
  }

  const lastIndexedTurn = state.pruneTargets.at(-1)?.turnIndex ?? -1;
  const stale = selectStaleRanges(state.currentTurn, lastIndexedTurn, config.backgroundIndexing.minRangeTurns);
  if (!stale) {
    return [];
  }

  const toolResults = messages.filter(isToolResultMessage).filter((message) => {
    const record = state.toolCalls.get(message.toolCallId);
    return record && record.turnIndex >= stale.startTurn && record.turnIndex <= stale.endTurn;
  });

  if (toolResults.length === 0) {
    return [];
  }

  const pruneTargets = toolResults.map((message) => {
    const record = state.toolCalls.get(message.toolCallId)!;
    return {
      toolCallId: message.toolCallId,
      turnIndex: record.turnIndex,
      indexedAt: Date.now(),
      summaryRef: `${stale.startTurn}-${stale.endTurn}`,
      replacementText: `[pruned: indexed ${message.toolName} result ${stale.startTurn}-${stale.endTurn}]`,
    };
  });

  const entry = buildIndexEntry(
    stale.startTurn,
    stale.endTurn,
    extractTopicFromRange(toolResults),
    toolResults.length,
    pruneTargets.map(({ toolCallId, turnIndex, replacementText }) => ({ toolCallId, turnIndex, replacementText })),
  );

  appendIndexEntry(getIndexPath(projectPath || "default"), entry);
  state.pruneTargets.push(...pruneTargets);
  return pruneTargets;
}
```

- [ ] **Step 5: Update runtime materialization to use prune targets**

Update `src/runtime/create-extension-runtime.ts` so `context` passes `state.pruneTargets` through the materialization pipeline and `agent_end` persists the new indexing results:

```ts
pi.on("context", async (event, ctx) => {
  const sessionId = resolveSessionId(ctx);
  const state = getState(sessionId, ctx.cwd);
  return materializeContext(event.messages, { state, config });
});

pi.on("agent_end", (event, ctx) => {
  const sessionId = resolveSessionId(ctx);
  const state = getState(sessionId, ctx.cwd);
  refreshRangeIndex(event.messages, state, config, ctx.cwd);
  persistState(sessionId);
});
```

- [ ] **Step 6: Run the focused indexing tests**

Run: `rtk npm test -- test/runtime-hooks.test.ts test/index-entry.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
rtk git add src/runtime/index-manager.ts src/compression/index-entry.ts src/persistence/index-store.ts src/runtime/create-extension-runtime.ts test/runtime-hooks.test.ts test/index-entry.test.ts
rtk git commit -m "fix: index only safe tool-result prune targets"
```

### Task 3: Make Protected Tools Dedup-Only And Mixed-Content Rewriting Block-Aware

**Files:**
- Modify: `src/messages.ts`
- Modify: `src/strategies/materialize.ts`
- Modify: `src/strategies/dedup.ts`
- Test: `test/messages.test.ts`
- Test: `test/materialize.test.ts`

- [ ] **Step 1: Write failing tests for protected-tool and mixed-content semantics**

Extend `test/materialize.test.ts` with two targeted regressions:

```ts
it("still short-circuits protected tools when dedup is the only protected behavior", () => {
  const state = createSessionState("/tmp");
  const cfg = defaultConfig();
  cfg.strategies.shortCircuit.minTokens = 4;

  const msgs = [
    {
      role: "toolResult",
      content: [{ type: "text", text: '{"status":"ok"}' }],
      toolName: "write",
      isError: false,
      toolCallId: "t1",
    },
  ] as any;

  const result = materializeContext(msgs, { state, config: cfg });
  expect((result.messages as any)[0].content[0].text).toBe("[ok]");
});

it("skips mixed-content transforms that would duplicate text across multiple text blocks", () => {
  const state = createSessionState("/tmp");
  const cfg = defaultConfig();
  cfg.strategies.truncation.headLines = 1;
  cfg.strategies.truncation.tailLines = 1;
  cfg.strategies.truncation.minLines = 2;

  const msgs = [
    {
      role: "toolResult",
      content: [
        { type: "text", text: "alpha\nbeta" },
        { type: "image", data: "img-data", mimeType: "image/png" },
        { type: "text", text: "gamma\ndelta" },
      ],
      toolName: "bash",
      isError: false,
      toolCallId: "t1",
    },
  ] as any;

  const result = materializeContext(msgs, { state, config: cfg });
  const toolMsg = result.messages?.[0] as any;

  expect(toolMsg.content[0].text).toBe("alpha\nbeta");
  expect(toolMsg.content[2].text).toBe("gamma\ndelta");
});
```

Add a focused `test/messages.test.ts` case for block-aware rewriting:

```ts
it("rewrites only a single text block when explicitly targeted", () => {
  const msg = {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    isError: false,
    content: [
      { type: "text", text: "before" },
      { type: "image", data: "img-data", mimeType: "image/png" },
      { type: "text", text: "after" },
    ],
  } as any;

  const replaced = replaceToolTextBlock(msg, 0, "[pruned]");
  expect(replaced.content[0].text).toBe("[pruned]");
  expect(replaced.content[2].text).toBe("after");
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `rtk npm test -- test/messages.test.ts test/materialize.test.ts`

Expected: FAIL because protected tools currently bypass the whole pipeline and mixed-content rewriting currently duplicates transformed text into every text block.

- [ ] **Step 3: Add block-aware text replacement helpers**

Update `src/messages.ts` with one helper for single-text-block replacement and one guard for multi-text-block tool results:

```ts
export function getTextBlockIndexes(msg: ToolResultMessage): number[] {
  const indexes: number[] = [];
  msg.content.forEach((block, index) => {
    if (isTextContent(block)) {
      indexes.push(index);
    }
  });
  return indexes;
}

export function replaceToolTextBlock(
  msg: ToolResultMessage,
  blockIndex: number,
  newText: string,
): ToolResultMessage {
  return {
    ...msg,
    content: msg.content.map((block, index) => {
      if (index === blockIndex && isTextContent(block)) {
        return { type: "text", text: newText };
      }
      return block;
    }),
  };
}
```

- [ ] **Step 4: Restrict protected-tool handling to dedup only and skip unsafe mixed-content transforms**

Update `src/strategies/materialize.ts` so only the dedup step respects `protectedTools`, and mixed-content transforms apply only when there is exactly one text block:

```ts
const textBlockIndexes = getTextBlockIndexes(msg);
const hasSingleTextBlock = textBlockIndexes.length === 1;
const dedupProtected = config.strategies.deduplication.protectedTools.includes(toolName);

if (config.strategies.shortCircuit.enabled && !isErr && hasSingleTextBlock) {
  const candidate = shortCircuit(currentText, isErr, config.strategies.shortCircuit.minTokens);
  if (candidate !== null) {
    creditSavings(
      state,
      toolCallId,
      "short_circuit",
      Math.max(0, currentText.length - candidate.length),
      Math.max(0, currentText.length - candidate.length),
    );
    currentText = candidate;
    newText = candidate;
  }
}

if (config.strategies.codeFilter.enabled && !isErr && hasSingleTextBlock) {
  const lang = detectLanguage(currentText);
  if (lang) {
    const candidate = codeFilter(currentText, lang, config.strategies.codeFilter);
    if (candidate !== null) {
      creditSavings(
        state,
        toolCallId,
        "code_filter",
        Math.max(0, currentText.length - candidate.length),
        Math.max(0, currentText.length - candidate.length),
      );
      currentText = candidate;
      newText = candidate;
    }
  }
}

if (config.strategies.truncation.enabled && hasSingleTextBlock) {
  const candidate = headTailTruncate(currentText, config.strategies.truncation);
  if (candidate !== null) {
    creditSavings(
      state,
      toolCallId,
      "truncation",
      Math.max(0, currentText.length - candidate.length),
      Math.max(0, currentText.length - candidate.length),
    );
    currentText = candidate;
    newText = candidate;
  }
}

if (config.strategies.deduplication.enabled && !dedupProtected) {
  const fingerprint = `${toolName}::${normalizeContent(currentText)}`;
  const candidate = fingerprintDedup(
    toolCallId,
    toolName,
    fingerprint,
    seen,
    config.strategies.deduplication.maxOccurrences,
    config.strategies.deduplication.protectedTools,
  );
  if (candidate !== null) {
    creditSavings(
      state,
      toolCallId,
      "dedup",
      Math.max(0, currentText.length - candidate.length),
      Math.max(0, currentText.length - candidate.length),
    );
    currentText = candidate;
    newText = candidate;
  }
}

if (newText !== null && hasSingleTextBlock) {
  return replaceToolTextBlock(msg, textBlockIndexes[0]!, newText);
}
```

- [ ] **Step 5: Run the focused tests**

Run: `rtk npm test -- test/messages.test.ts test/materialize.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
rtk git add src/messages.ts src/strategies/materialize.ts src/strategies/dedup.ts test/messages.test.ts test/materialize.test.ts
rtk git commit -m "fix: preserve block semantics during materialization"
```

### Task 4: Scope Analytics And Dashboard Snapshots To The Active Session

**Files:**
- Modify: `src/analytics/types.ts`
- Modify: `src/analytics/store.ts`
- Modify: `src/runtime/create-extension-runtime.ts`
- Modify: `src/dashboard/server.ts`
- Modify: `src/dashboard/pages.ts`
- Test: `test/analytics.test.ts`
- Test: `test/dashboard.test.ts`

- [ ] **Step 1: Write failing tests for session-scoped analytics snapshots**

Extend `test/analytics.test.ts` with a direct store-level test:

```ts
it("returns snapshots scoped to the requested session", () => {
  const store = createAnalyticsStore({ dbPath, retentionDays: 30 });

  store.recordTurn({
    sessionId: "session-a",
    projectPath: "/tmp/project-a",
    turnIndex: 1,
    toolCount: 1,
    messageCountAfterTurn: 3,
    timestamp: 1,
    contextTokens: 100,
    contextPercent: 0.1,
    contextWindow: 1000,
    tokensSavedApprox: 10,
    tokensKeptOutApprox: 20,
  });

  store.recordTurn({
    sessionId: "session-b",
    projectPath: "/tmp/project-b",
    turnIndex: 1,
    toolCount: 1,
    messageCountAfterTurn: 2,
    timestamp: 2,
    contextTokens: 300,
    contextPercent: 0.3,
    contextWindow: 1000,
    tokensSavedApprox: 30,
    tokensKeptOutApprox: 40,
  });

  const snapshot = store.getSnapshot("session-a");
  expect(snapshot.sessionId).toBe("session-a");
  expect(snapshot.totalTurns).toBe(1);
  expect(snapshot.context.tokens).toBe(100);
  expect(snapshot.totals.tokensKeptOutApprox).toBe(20);
});
```

Update `test/dashboard.test.ts` so the shared dashboard case locks session scoping instead of cross-session bleed:

```ts
expect(snapshot.sessionId).toBe("session-b");
expect(snapshot.totalTurns).toBe(1);
expect(snapshot.context.tokens).toBe(300);
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `rtk npm test -- test/analytics.test.ts test/dashboard.test.ts`

Expected: FAIL because analytics queries currently aggregate across all sessions in the same DB.

- [ ] **Step 3: Make analytics store reads explicitly session-scoped**

Update `src/analytics/types.ts` and `src/analytics/store.ts` so snapshots are requested for one session at a time:

```ts
export interface AnalyticsStore {
  recordTurn(turn: AnalyticsTurnRecord): AnalyticsSnapshot;
  getSnapshot(sessionId: string, limit?: number): AnalyticsSnapshot;
  close(): void;
}
```

```ts
const selectRows = db.prepare<unknown[], AnalyticsRow>(`
  SELECT
    session_id,
    project_path,
    turn_index,
    tool_count,
    message_count_after_turn,
    timestamp,
    context_tokens,
    context_percent,
    context_window,
    tokens_saved_approx,
    tokens_kept_out_approx
  FROM turn_metrics
  WHERE session_id = ?
  ORDER BY timestamp DESC, id DESC
  LIMIT ?
`);

const selectTotals = db.prepare(`
  SELECT
    COUNT(*) AS totalTurns,
    COALESCE(SUM(tokens_saved_approx), 0) AS tokensSavedApprox,
    COALESCE(SUM(tokens_kept_out_approx), 0) AS tokensKeptOutApprox
  FROM turn_metrics
  WHERE session_id = ?
`);
```

- [ ] **Step 4: Publish session-scoped snapshots from the runtime**

Update `src/runtime/create-extension-runtime.ts` and the dashboard server interfaces so each publish call carries the current session snapshot rather than an implicitly global aggregate:

```ts
const snapshot = analyticsStore?.recordTurn({
  sessionId,
  projectPath: state.projectPath,
  turnIndex: latestTurn.turnIndex,
  toolCount: latestTurn.toolCount,
  messageCountAfterTurn: latestTurn.messageCountAfterTurn,
  timestamp: latestTurn.timestamp,
  contextTokens: state.lastContextTokens,
  contextPercent: state.lastContextPercent,
  contextWindow: state.lastContextWindow,
  tokensSavedApprox: latestTurn.tokensSavedDelta,
  tokensKeptOutApprox: latestTurn.tokensKeptOutDelta,
});

if (snapshot) {
  const dashboardServer = await ensureDashboardServer(sessionId, config);
  if (dashboardServer) {
    dashboardServer.publish(sessionId, snapshot);
  }
}
```

```ts
export interface DashboardServerHandle {
  server: Server;
  ready: Promise<void>;
  publish(sessionId: string, snapshot: AnalyticsSnapshot): void;
  close(): Promise<void>;
  snapshot(sessionId?: string): AnalyticsSnapshot | null;
}
```

- [ ] **Step 5: Surface session identity in the dashboard page**

Update `src/dashboard/pages.ts` so the page labels the active session it is displaying:

```ts
<div class="stat"><div id="session-id" class="val">--</div><div class="label">Session</div></div>
```

```ts
if (d?.sessionId) document.getElementById('session-id').textContent = d.sessionId;
```

- [ ] **Step 6: Run the focused tests**

Run: `rtk npm test -- test/analytics.test.ts test/dashboard.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
rtk git add src/analytics/types.ts src/analytics/store.ts src/runtime/create-extension-runtime.ts src/dashboard/server.ts src/dashboard/pages.ts test/analytics.test.ts test/dashboard.test.ts
rtk git commit -m "fix: scope dashboard analytics to the active session"
```

### Task 5: Revalidate The Original Remediation End To End

**Files:**
- Modify: `test/runtime-hooks.test.ts`
- Modify: `test/materialize.test.ts`
- Modify: `test/pruning.test.ts`
- Modify: `test/dashboard.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add one whole-flow regression test for the original silent-first promise**

Extend `test/runtime-hooks.test.ts` with a scenario that proves the full pipeline preserves conversation messages while compressing indexed tool noise:

```ts
it("keeps conversation history while pruning indexed tool noise in context", async () => {
  const piCalls = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
      piCalls.set(name, handler);
    }),
  } as any;

  const config = defaultConfig();
  config.backgroundIndexing.enabled = true;
  config.backgroundIndexing.minRangeTurns = 1;
  config.analytics.enabled = false;
  config.dashboard.enabled = false;

  createExtensionRuntime(pi, config);

  const ctx = {
    cwd: "/tmp/project",
    sessionManager: {
      getSessionId: () => "session-a",
      getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
    },
    getContextUsage: () => ({ tokens: 600, percent: 0.6, contextWindow: 1000 }),
  } as any;

  await piCalls.get("turn_end")?.(
    {
      turnIndex: 0,
      message: { role: "assistant", content: "done" },
      toolResults: [
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "large file output" }],
        },
      ],
    },
    ctx,
  );

  await piCalls.get("agent_end")?.(
    {
      messages: [
        { role: "user", content: [{ type: "text", text: "show me the file" }] },
        { role: "assistant", content: "running read" },
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "large file output" }],
        },
      ],
    },
    ctx,
  );

  const result = await piCalls.get("context")?.(
    {
      messages: [
        { role: "user", content: [{ type: "text", text: "show me the file" }] },
        { role: "assistant", content: "running read" },
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "large file output" }],
        },
      ],
    },
    ctx,
  );

  expect(result.messages.map((message: any) => message.role)).toEqual(["user", "assistant", "toolResult"]);
  expect(result.messages[2].content[0].text).toContain("[pruned:");
});
```

- [ ] **Step 2: Run the high-signal regression suite**

Run: `rtk npm test -- test/runtime-hooks.test.ts test/materialize.test.ts test/pruning.test.ts test/dashboard.test.ts`

Expected: PASS

- [ ] **Step 3: Re-run the full repository verification gate**

Run: `rtk npm run check`

Expected: PASS

- [ ] **Step 4: Re-check the original remediation spec against the final code**

Open `docs/superpowers/specs/2026-04-14-pi-context-ninja-remediation-design.md` and verify:

- safe tool-result shaping still exists
- range-based pruning is now safe and real
- dashboard/analytics remain implemented and truthful
- no reviewed defect contradicts the original end-state

If any gap remains, stop and add another task before claiming completion.

- [ ] **Step 5: Refresh the README verification block only if commands changed**

If `README.md` still contains:

```md
## Verification

```bash
rtk npm run check
rtk npm test -- test/runtime-hooks.test.ts
```
```

leave it unchanged. If the verification entrypoint changed during remediation, update only that block.

- [ ] **Step 6: Commit**

```bash
rtk git add test/runtime-hooks.test.ts test/materialize.test.ts test/pruning.test.ts test/dashboard.test.ts README.md
rtk git commit -m "test: revalidate original remediation end to end"
```
