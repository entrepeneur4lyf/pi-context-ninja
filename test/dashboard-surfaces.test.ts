import { describe, expect, it } from "bun:test";
import type { DashboardSnapshot } from "../src/analytics/types";
import type { OverlayModel } from "../src/dashboard/render";
import { STATUS_KEY, createDashboardSurfaces } from "../src/dashboard/surfaces";
import { createUiMock } from "./helpers";

function modelWith(sessionKeptOut: number, degradedReason: string | null = null): OverlayModel {
  const scope = (name: "session" | "project" | "lifetime", tokens: number) => ({
    scope: name,
    tokensSavedApprox: tokens,
    tokensKeptOutApprox: tokens,
    turnCount: 1,
  });
  const snapshot: DashboardSnapshot = {
    generatedAt: 0,
    sessionId: "s1",
    projectPath: "/tmp/project",
    context: { tokens: 100, percent: 10, window: 1000 },
    scopes: { session: scope("session", sessionKeptOut), project: scope("project", 0), lifetime: scope("lifetime", 0) },
    live: { turnCount: 1, toolCallCount: 1 },
    strategyTotals: {},
    recentImpactEvents: [],
  };
  return { snapshot, degradedReason };
}

describe("dashboard surfaces", () => {
  it("sets the status-line item on update and skips unchanged text", () => {
    const host = createUiMock();
    const surfaces = createDashboardSurfaces();

    surfaces.update(host.ctx, "s1", modelWith(12_345));
    expect(host.status.get(STATUS_KEY)).toBe("pcn 12.3k kept out");

    surfaces.update(host.ctx, "s1", modelWith(12_345));
    expect(host.ui.setStatus).toHaveBeenCalledTimes(1);

    surfaces.update(host.ctx, "s1", modelWith(20_000));
    expect(host.ui.setStatus).toHaveBeenCalledTimes(2);
    expect(host.status.get(STATUS_KEY)).toBe("pcn 20k kept out");
    expect(surfaces.activeSessions()).toEqual(["s1"]);
  });

  it("skips both surfaces when the host has no UI", async () => {
    const host = createUiMock({ hasUI: false });
    const surfaces = createDashboardSurfaces();

    surfaces.update(host.ctx, "s1", modelWith(5));
    await expect(surfaces.open(host.ctx, "s1", modelWith(5))).resolves.toBe(false);

    expect(host.ui.setStatus).not.toHaveBeenCalled();
    expect(host.custom).not.toHaveBeenCalled();
    expect(surfaces.activeSessions()).toEqual([]);

    surfaces.update({}, "s2", modelWith(5));
    await expect(surfaces.open({}, "s2", modelWith(5))).resolves.toBe(false);
    expect(surfaces.activeSessions()).toEqual([]);
  });

  it("opens the overlay through ctx.ui.custom in overlay mode and closes on Escape", async () => {
    const host = createUiMock();
    const surfaces = createDashboardSurfaces();

    const opening = surfaces.open(host.ctx, "s1", modelWith(500));

    expect(host.custom).toHaveBeenCalledTimes(1);
    expect(host.overlay?.options).toEqual({ overlay: true });
    expect(surfaces.isOverlayOpen("s1")).toBe(true);
    const lines = host.overlay!.component.render(80);
    expect(lines).toContain("Kept out    session 500   project 0   lifetime 0");

    host.overlay!.component.handleInput!("j");
    expect(surfaces.isOverlayOpen("s1")).toBe(true);

    host.overlay!.component.handleInput!("\x1b");
    await expect(opening).resolves.toBe(true);
    expect(surfaces.isOverlayOpen("s1")).toBe(false);
    expect(host.overlay).toBeNull();
  });

  it("re-renders an open overlay when a newer model arrives", async () => {
    const host = createUiMock();
    const surfaces = createDashboardSurfaces();

    const opening = surfaces.open(host.ctx, "s1", modelWith(500));
    const tui = host.overlay!.tui;

    surfaces.update(host.ctx, "s1", modelWith(900));

    expect(tui.requestRender).toHaveBeenCalledTimes(1);
    expect(host.overlay!.component.render(80)).toContain("Kept out    session 900   project 0   lifetime 0");
    expect(host.status.get(STATUS_KEY)).toBe("pcn 900 kept out");

    host.overlay!.component.handleInput!("\x1b[27u");
    await expect(opening).resolves.toBe(true);
  });

  it("does not open a second overlay while one is open", async () => {
    const host = createUiMock();
    const surfaces = createDashboardSurfaces();

    const first = surfaces.open(host.ctx, "s1", modelWith(1));
    await expect(surfaces.open(host.ctx, "s1", modelWith(2))).resolves.toBe(true);

    expect(host.custom).toHaveBeenCalledTimes(1);
    expect(host.overlay!.component.render(80)).toContain("Kept out    session 2   project 0   lifetime 0");

    host.overlay!.component.handleInput!("q");
    await expect(first).resolves.toBe(true);
  });

  it("clear removes the status item and closes an open overlay", async () => {
    const host = createUiMock();
    const surfaces = createDashboardSurfaces();

    surfaces.update(host.ctx, "s1", modelWith(5));
    const opening = surfaces.open(host.ctx, "s1", modelWith(5));

    surfaces.clear("s1");

    expect(host.status.get(STATUS_KEY)).toBeUndefined();
    expect(host.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
    await expect(opening).resolves.toBe(true);
    expect(surfaces.isOverlayOpen("s1")).toBe(false);
    expect(surfaces.activeSessions()).toEqual([]);

    surfaces.clear("unknown");
    expect(host.ui.setStatus).toHaveBeenCalledTimes(2);
  });

  it("returns false from open when the host UI has no custom method or custom fails", async () => {
    const withoutCustom = createUiMock({ withCustom: false });
    const surfaces = createDashboardSurfaces();
    await expect(surfaces.open(withoutCustom.ctx, "s1", modelWith(5))).resolves.toBe(false);

    const failing = createUiMock({ customRejects: new Error("no overlay here") });
    await expect(surfaces.open(failing.ctx, "s2", modelWith(5))).resolves.toBe(false);
    expect(surfaces.isOverlayOpen("s2")).toBe(false);
  });

  it("paints overlay lines through the host theme", () => {
    const host = createUiMock({ theme: { fg: (color, text) => `[${color}]${text}` } });
    const surfaces = createDashboardSurfaces();

    void surfaces.open(host.ctx, "s1", modelWith(5));

    expect(host.overlay!.component.render(80)[0]).toContain("[accent] PCN dashboard ");
    host.overlay!.component.handleInput!("\x1b");
  });

  it("shows the degraded reason in the overlay", () => {
    const host = createUiMock();
    const surfaces = createDashboardSurfaces();

    void surfaces.open(host.ctx, "s1", modelWith(5, "database is locked"));

    expect(host.overlay!.component.render(100)).toContain(
      "Analytics unavailable: database is locked. Live session counters only.",
    );
    host.overlay!.component.handleInput!("\x1b");
  });
});
