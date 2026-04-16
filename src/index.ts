import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadRuntimeConfig } from "./config.js";
import { registerProjectControlCommands } from "./control/commands.js";
import { createExtensionRuntime } from "./runtime/create-extension-runtime.js";

export default function (pi: ExtensionAPI) {
  const config = loadRuntimeConfig();
  registerProjectControlCommands(pi);
  createExtensionRuntime(pi, config);
}
