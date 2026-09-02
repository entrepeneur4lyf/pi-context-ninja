import fs from "node:fs";
import YAML from "yaml";
import { resolveRuntimeConfigPath } from "./paths.js";

export interface ShortCircuitConfig {
  enabled: boolean;
  /** Results longer than this many estimated tokens are never short-circuited. */
  maxTokens: number;
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
}

export interface ShapingConfig {
  /** Tools whose results no strategy rewrites (02-shaping.md SHAPE-012). */
  protectedTools: string[];
}

export interface ErrorPurgeConfig {
  enabled: boolean;
  maxTurnsAgo: number;
}

export interface AnalyticsConfig {
  enabled: boolean;
  dbPath: string;
  retentionDays: number;
}

export interface DashboardConfig {
  enabled: boolean;
  /** Host key id that opens the overlay (04-analytics-and-dashboard.md DASH-036). */
  shortcut: string;
}

export interface SystemHintConfig {
  enabled: boolean;
  text: string;
  frequency: "always" | "once_per_session" | "on_change";
}

export interface PCNConfig {
  strategies: {
    shortCircuit: ShortCircuitConfig;
    codeFilter: CodeFilterConfig;
    truncation: TruncationConfig;
    deduplication: DeduplicationConfig;
    errorPurge: ErrorPurgeConfig;
  };
  shaping: ShapingConfig;
  analytics: AnalyticsConfig;
  dashboard: DashboardConfig;
  systemHint: SystemHintConfig;
}

type PlainObject = Record<string, unknown>;

export function defaultConfig(): PCNConfig {
  return {
    strategies: {
      shortCircuit: {
        enabled: true,
        maxTokens: 2000,
      },
      codeFilter: {
        enabled: false,
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
      },
      errorPurge: {
        enabled: true,
        maxTurnsAgo: 3,
      },
    },
    shaping: {
      protectedTools: ["write", "edit", "task"],
    },
    analytics: {
      enabled: true,
      dbPath: "",
      retentionDays: 30,
    },
    dashboard: {
      enabled: true,
      shortcut: "alt+n",
    },
    systemHint: {
      enabled: true,
      text: "Context management is handled automatically in the background. You do not need to manage context yourself.",
      frequency: "once_per_session",
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

export function loadRuntimeConfig(): PCNConfig {
  return loadConfig(resolveRuntimeConfigPath());
}

export { deepMerge, resolveRuntimeConfigPath };
