import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadRuntimeConfig } from "./config.js";
import { createExtensionRuntime } from "./runtime/create-extension-runtime.js";

export default function (pi: ExtensionAPI) {
  createExtensionRuntime(pi, loadRuntimeConfig());
}
