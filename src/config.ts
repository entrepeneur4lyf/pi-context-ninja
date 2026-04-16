import fs from "fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export interface ShortCircuitConfig {
  enabled: boolean;
  minTokens: number;
}

export interface CodeFilterConfig {
  enabled: boolean;
  keepDocstrings: boolean;
  maxBodyLines: number;
  keepImports: boolean;
}

export interface TruncationConfig {
  enabled: boolean;
  headLines: number;
  tailLines: number;
  minLines: number;
}

export interface DeduplicationConfig {
  enabled: boolean;
  maxOccurrences: number;
  protectedTools: string[];
}

export interface ErrorPurgeConfig {
  enabled: boolean;
  maxTurnsAgo: number;
}

export interface BackgroundIndexingConfig {
  enabled: boolean;
  minRangeTurns: number;
}

export interface AnalyticsConfig {
  enabled: boolean;
  dbPath: string;
  retentionDays: number;
}

export interface DashboardConfig {
  enabled: boolean;
  port: number;
  bindHost: string;
}

export interface SystemHintConfig {
  enabled: boolean;
  text: string;
  frequency: "always" | "once_per_session" | "on_change";
}

export interface NativeCompactionIntegrationConfig {
  enabled: boolean;
  fallbackOnFailure: boolean;
  maxContextSize: number;
}

export interface PCNConfig {
  strategies: {
    shortCircuit: ShortCircuitConfig;
    codeFilter: CodeFilterConfig;
    truncation: TruncationConfig;
    deduplication: DeduplicationConfig;
    errorPurge: ErrorPurgeConfig;
  };
  backgroundIndexing: BackgroundIndexingConfig;
  analytics: AnalyticsConfig;
  dashboard: DashboardConfig;
  systemHint: SystemHintConfig;
  nativeCompactionIntegration: NativeCompactionIntegrationConfig;
}

type PlainObject = Record<string, unknown>;

export function defaultConfig(): PCNConfig {
  return {
    strategies: {
      shortCircuit: {
        enabled: true,
        minTokens: 8000,
      },
      codeFilter: {
        enabled: true,
        keepDocstrings: true,
        maxBodyLines: 200,
        keepImports: true,
      },
      truncation: {
        enabled: true,
        headLines: 100,
        tailLines: 50,
        minLines: 300,
      },
      deduplication: {
        enabled: true,
        maxOccurrences: 2,
        protectedTools: ["write", "edit"],
      },
      errorPurge: {
        enabled: true,
        maxTurnsAgo: 3,
      },
    },
    backgroundIndexing: {
      enabled: true,
      minRangeTurns: 8,
    },
    analytics: {
      enabled: true,
      dbPath: "",
      retentionDays: 30,
    },
    dashboard: {
      enabled: true,
      port: 48900,
      bindHost: "127.0.0.1",
    },
    systemHint: {
      enabled: true,
      text: "Context management is handled automatically in the background. You do not need to manage context yourself.",
      frequency: "once_per_session",
    },
    nativeCompactionIntegration: {
      enabled: false,
      fallbackOnFailure: true,
      maxContextSize: 0,
    },
  };
}

function isPlainObject(value: unknown): value is PlainObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asPlainObject<T extends object>(value: T): T & PlainObject {
  return value as T & PlainObject;
}

function deepMerge<T extends PlainObject>(target: T, source: PlainObject): T {
  const result: PlainObject = { ...target };
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      continue;
    }
    const sourceValue = source[key];
    const targetValue = target[key];
    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else {
      result[key] = sourceValue;
    }
  }
  return result as T;
}

export function loadConfig(configPath: string): PCNConfig {
  const defaults = defaultConfig();

  if (!fs.existsSync(configPath)) {
    return defaults;
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed: unknown = YAML.parse(raw);
  if (!isPlainObject(parsed)) {
    return defaults;
  }

  return deepMerge(asPlainObject(defaults), parsed);
}

export function resolveRuntimeConfigPath(): string {
  return process.env.PCN_CONFIG_PATH ?? path.join(os.homedir(), ".pi-ninja", "config.yaml");
}

export function loadRuntimeConfig(): PCNConfig {
  return loadConfig(resolveRuntimeConfigPath());
}

export { deepMerge };
