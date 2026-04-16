import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadRuntimeConfig, resolveRuntimeConfigPath } from "./config.js";
import {
  createCommandRuntimeHealth,
  registerProjectControlCommands,
  replaceCommandRuntimeDegradedReasons,
} from "./control/commands.js";
import { createExtensionRuntime, type ExtensionRuntimeControls } from "./runtime/create-extension-runtime.js";

function formatStartupError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}`;
}

export default function (pi: ExtensionAPI) {
  const runtimeHealth = createCommandRuntimeHealth();
  runtimeHealth.configPath = resolveRuntimeConfigPath();
  let runtimeControls: ExtensionRuntimeControls | null = null;
  registerProjectControlCommands(pi, () => ({
    configPath: runtimeHealth.configPath,
    runtimeLoaded: runtimeHealth.runtimeLoaded,
    degradedReasons: [...runtimeHealth.degradedReasons],
  }), {
    revokeDashboardSession: async (sessionId: string) => {
      await runtimeControls?.revokeDashboardSession(sessionId);
    },
    revokeProjectDashboardSessions: async (projectPath: string) => {
      await runtimeControls?.revokeProjectDashboardSessions(projectPath);
    },
  });

  try {
    const config = loadRuntimeConfig();
    runtimeControls = createExtensionRuntime(pi, config, runtimeHealth);
    runtimeHealth.runtimeLoaded = true;
    replaceCommandRuntimeDegradedReasons(runtimeHealth, []);
  } catch (error) {
    runtimeHealth.runtimeLoaded = false;
    replaceCommandRuntimeDegradedReasons(runtimeHealth, [formatStartupError("Runtime startup failed", error)]);
  }
}
