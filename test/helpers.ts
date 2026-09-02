import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { vi } from "bun:test";
import type { HostUi, HostUiContext } from "../src/dashboard/surfaces";

/** Builds a tool result message with the fields the host requires. */
export function toolResult(partial: Partial<ToolResultMessage> & Pick<ToolResultMessage, "toolCallId" | "toolName" | "content">): ToolResultMessage {
  return {
    role: "toolResult",
    isError: false,
    timestamp: 0,
    ...partial,
  };
}

export interface RecordedEntry {
  type: "custom";
  id: string;
  customType: string;
  data: unknown;
  timestamp: number;
}

export interface RecordedShortcut {
  description?: string;
  handler: (ctx: unknown) => Promise<void> | void;
}

/** A fake ExtensionAPI that records hooks, commands, shortcuts, and appended entries. */
export function createPiMock(entries: RecordedEntry[] = []) {
  const calls = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
  const shortcuts = new Map<string, RecordedShortcut>();
  const pi = {
    on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
      calls.set(name, handler);
    }),
    registerCommand: vi.fn((name: string, options: { handler: (...args: any[]) => unknown }) => {
      commands.set(name, options);
    }),
    registerShortcut: vi.fn((key: string, options: RecordedShortcut) => {
      shortcuts.set(key, options);
    }),
    appendEntry: vi.fn((customType: string, data?: unknown) => {
      entries.push({ type: "custom", id: `entry-${entries.length + 1}`, customType, data, timestamp: Date.now() });
    }),
  } as unknown as ExtensionAPI;

  return { pi, calls, commands, shortcuts, entries };
}

export interface UiMockComponent {
  render(width: number): readonly string[];
  handleInput?(data: string): void;
  invalidate?(): void;
  dispose?(): void;
}

export interface UiMockOverlay {
  component: UiMockComponent;
  tui: { requestRender: ReturnType<typeof vi.fn> };
  options: unknown;
}

export interface UiMockOptions {
  hasUI?: boolean;
  /** Omit `custom` from the UI, as a host without overlays would. */
  withCustom?: boolean;
  /** Make `custom` reject instead of showing a component. */
  customRejects?: Error;
  theme?: { fg(color: string, text: string): string };
}

/**
 * A fake of the host `ctx.ui` slice PCN uses: records status items and
 * shows one custom component at a time. The returned promise from
 * `custom` resolves when the component calls `done`.
 */
export function createUiMock(options: UiMockOptions = {}) {
  const status = new Map<string, string | undefined>();
  const notify = vi.fn();
  let overlay: UiMockOverlay | null = null;
  const theme = options.theme ?? { fg: (_color: string, text: string) => text };
  const custom = vi.fn((factory: (...args: any[]) => UiMockComponent, customOptions: unknown) => {
    if (options.customRejects) {
      return Promise.reject(options.customRejects);
    }
    return new Promise((resolve) => {
      const tui = { requestRender: vi.fn() };
      const done = (value: unknown) => {
        overlay?.component.dispose?.();
        overlay = null;
        resolve(value);
      };
      const component = factory(tui, theme, {}, done);
      overlay = { component, tui, options: customOptions };
    });
  });
  const ui = {
    setStatus: vi.fn((key: string, text: string | undefined) => {
      status.set(key, text);
    }),
    notify,
    ...(options.withCustom === false ? {} : { custom }),
  };
  const ctx: HostUiContext = { hasUI: options.hasUI ?? true, ui: ui as unknown as HostUi };

  return {
    ctx,
    ui,
    status,
    notify,
    custom,
    get overlay() {
      return overlay;
    },
  };
}
