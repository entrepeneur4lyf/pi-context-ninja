import fs from "fs";
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
  strategy: "head_tail" | "smart";
}

export interface DeduplicationConfig {
  enabled: boolean;
  maxOccurrences: number;
  protectedTools: string[];
}

export interface ErrorPurgeConfig {
  enabled: boolean;
  maxTurnsAgo: number;
  patterns: string[];
}

export interface BackgroundIndexingConfig {
  enabled: boolean;
  minRangeTurns: number;
  maxFiles: number;
  debounceMs: number;
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
        strategy: "head_tail",
      },
      deduplication: {
        enabled: true,
        maxOccurrences: 2,
        protectedTools: ["write", "edit"],
      },
      errorPurge: {
        enabled: true,
        maxTurnsAgo: 3,
        patterns: [],
      },
    },
    backgroundIndexing: {
      enabled: true,
      minRangeTurns: 8,
      maxFiles: 50,
      debounceMs: 2000,
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

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function loadConfig(configPath: string): PCNConfig {
  const defaults = defaultConfig();

  if (!fs.existsSync(configPath)) {
    return defaults;
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = YAML.parse(raw) as Record<string, unknown>;
  return deepMerge(defaults as Record<string, unknown>, parsed) as PCNConfig;
}

export { deepMerge };
