import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadRuntimeConfig, resolveRuntimeConfigPath } from "./config.js";
import { createCommandRuntimeHealth, registerProjectControlCommands } from "./control/commands.js";
import { createExtensionRuntime } from "./runtime/create-extension-runtime.js";

function formatStartupError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}`;
}

export default function (pi: ExtensionAPI) {
  const runtimeHealth = createCommandRuntimeHealth();
  runtimeHealth.configPath = resolveRuntimeConfigPath();
  registerProjectControlCommands(pi, () => ({
    configPath: runtimeHealth.configPath,
    runtimeLoaded: runtimeHealth.runtimeLoaded,
    degradedReasons: [...runtimeHealth.degradedReasons],
  }));

  try {
    const config = loadRuntimeConfig();
    createExtensionRuntime(pi, config);
    runtimeHealth.runtimeLoaded = true;
    runtimeHealth.degradedReasons = [];
  } catch (error) {
    runtimeHealth.runtimeLoaded = false;
    runtimeHealth.degradedReasons = [formatStartupError("Runtime startup failed", error)];
  }
}
