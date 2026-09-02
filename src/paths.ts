import os from "node:os";
import path from "node:path";

/**
 * File locations PCN owns. Every user-level file lives under
 * `<agent-dir>/pcn/` and every project-local file under
 * `<project>/.omp/pcn/` (00-overview.md PCN-005, PCN-006).
 *
 * The agent directory mirrors the host's default and honors the same
 * override variable, `PI_CODING_AGENT_DIR`. Host profiles are not
 * resolved here; PCN avoids a runtime dependency on the host's utility
 * package because that package pulls in native bindings.
 */
export function getAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (typeof override === "string" && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".omp", "agent");
}

export function getUserDir(): string {
  return path.join(getAgentDir(), "pcn");
}

export function getProjectDir(projectPath: string): string {
  return path.join(path.resolve(projectPath), ".omp", "pcn");
}

export function resolveRuntimeConfigPath(): string {
  const override = process.env.PCN_CONFIG_PATH;
  if (typeof override === "string" && override.trim().length > 0) {
    return override;
  }
  return path.join(getUserDir(), "config.yaml");
}
