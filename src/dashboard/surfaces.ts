import { isOverlayCloseKey } from "./keys.js";
import { renderOverlayLines, renderStatusText, type OverlayModel, type Paint, type PaintRole } from "./render.js";

/**
 * The two dashboard surfaces on the host UI: one status-line item and one
 * overlay per session (04-analytics-and-dashboard.md DASH-020 to DASH-035).
 * The host types are mirrored structurally so this module imports nothing
 * from the host at runtime.
 */

export const STATUS_KEY = "pcn";

export interface HostTui {
  requestRender(): void;
}

export interface HostTheme {
  fg?(color: string, text: string): string;
}

export interface HostComponent {
  render(width: number): readonly string[];
  handleInput?(data: string): void;
  invalidate?(): void;
  dispose?(): void;
}

export type HostCustomFactory<T> = (
  tui: HostTui,
  theme: HostTheme,
  keybindings: unknown,
  done: (result: T) => void,
) => HostComponent;

export interface HostUi {
  setStatus(key: string, text: string | undefined): void;
  custom?<T>(factory: HostCustomFactory<T>, options?: { overlay?: boolean }): Promise<T>;
}

/** The slice of the host extension context the surfaces read. */
export interface HostUiContext {
  hasUI?: boolean;
  ui?: HostUi;
}

export interface DashboardSurfaces {
  /** Refresh the status item and any open overlay for a session (DASH-021, DASH-032). */
  update(ctx: HostUiContext, sessionId: string, model: OverlayModel): void;
  /** Open the overlay; resolves when it closes. False when the host has no UI. */
  open(ctx: HostUiContext, sessionId: string, model: OverlayModel): Promise<boolean>;
  /** Remove the status item and close the overlay for a session (DASH-022, HOST-080). */
  clear(sessionId: string): void;
  activeSessions(): string[];
  isOverlayOpen(sessionId: string): boolean;
}

interface OpenOverlay {
  tui: HostTui;
  close: () => void;
}

interface SessionSurface {
  ui: HostUi;
  statusText: string | null;
  model: OverlayModel;
  overlay: OpenOverlay | null;
}

function resolveUi(ctx: HostUiContext): HostUi | null {
  if (ctx.hasUI === false) {
    return null;
  }
  const ui = ctx.ui;
  return ui && typeof ui.setStatus === "function" ? ui : null;
}

function paintWith(theme: HostTheme): Paint {
  const fg = theme.fg;
  if (typeof fg !== "function") {
    return (_role: PaintRole, text: string) => text;
  }
  return (role: PaintRole, text: string) => fg.call(theme, role, text);
}

export function createDashboardSurfaces(): DashboardSurfaces {
  const surfaces = new Map<string, SessionSurface>();

  function getSurface(ui: HostUi, sessionId: string, model: OverlayModel): SessionSurface {
    let surface = surfaces.get(sessionId);
    if (!surface) {
      surface = { ui, statusText: null, model, overlay: null };
      surfaces.set(sessionId, surface);
    }
    surface.ui = ui;
    surface.model = model;
    return surface;
  }

  function setStatus(surface: SessionSurface): void {
    const text = renderStatusText(surface.model.snapshot.scopes.session.tokensKeptOutApprox);
    if (surface.statusText === text) {
      return;
    }
    surface.statusText = text;
    surface.ui.setStatus(STATUS_KEY, text);
  }

  return {
    update(ctx, sessionId, model) {
      const ui = resolveUi(ctx);
      if (!ui) {
        return;
      }
      const surface = getSurface(ui, sessionId, model);
      setStatus(surface);
      surface.overlay?.tui.requestRender();
    },

    async open(ctx, sessionId, model) {
      const ui = resolveUi(ctx);
      if (!ui || typeof ui.custom !== "function") {
        return false;
      }
      const surface = getSurface(ui, sessionId, model);
      if (surface.overlay) {
        surface.overlay.tui.requestRender();
        return true;
      }

      try {
        await ui.custom<undefined>(
          (tui, theme, _keybindings, done) => {
            const paint = paintWith(theme);
            surface.overlay = { tui, close: () => done(undefined) };
            return {
              render: (width) => renderOverlayLines(surface.model, width, paint),
              handleInput: (data) => {
                if (isOverlayCloseKey(data)) {
                  done(undefined);
                }
              },
              invalidate: () => {},
              dispose: () => {
                surface.overlay = null;
              },
            };
          },
          { overlay: true },
        );
        return true;
      } catch {
        return false;
      } finally {
        surface.overlay = null;
      }
    },

    clear(sessionId) {
      const surface = surfaces.get(sessionId);
      if (!surface) {
        return;
      }
      surfaces.delete(sessionId);
      if (surface.statusText !== null) {
        surface.ui.setStatus(STATUS_KEY, undefined);
      }
      surface.overlay?.close();
    },

    activeSessions() {
      return [...surfaces.keys()];
    },

    isOverlayOpen(sessionId) {
      return (surfaces.get(sessionId)?.overlay ?? null) !== null;
    },
  };
}
