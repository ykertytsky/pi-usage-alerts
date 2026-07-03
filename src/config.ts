import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UsageAlertConfig, UsageWindowName } from "./types.js";

export const DEFAULT_CONFIG: UsageAlertConfig = {
  enabled: true,
  pollIntervalMs: 5 * 60 * 1000,
  anthropicMinPollMs: 10 * 60 * 1000,
  thresholds: {
    warning: 30,
    critical: 10,
  },
  windows: ["5h", "7d"],
  osNotify: true,
  osNotifyOnCriticalOnly: true,
};

export function configPath(): string {
  return join(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    "usage-alerts.json",
  );
}

function isWindowName(value: unknown): value is UsageWindowName {
  return value === "5h" || value === "7d";
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeConfig(value: unknown): UsageAlertConfig {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const thresholds =
    source.thresholds && typeof source.thresholds === "object"
      ? (source.thresholds as Record<string, unknown>)
      : {};
  const configuredWindows = Array.isArray(source.windows)
    ? source.windows.filter(isWindowName)
    : DEFAULT_CONFIG.windows;

  return {
    enabled: booleanValue(source.enabled, DEFAULT_CONFIG.enabled),
    pollIntervalMs: positiveNumber(source.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs),
    anthropicMinPollMs: Math.max(
      DEFAULT_CONFIG.anthropicMinPollMs,
      positiveNumber(source.anthropicMinPollMs, DEFAULT_CONFIG.anthropicMinPollMs),
    ),
    thresholds: {
      warning: Math.min(100, Math.max(1, positiveNumber(thresholds.warning, 30))),
      critical: Math.min(100, Math.max(0, positiveNumber(thresholds.critical, 10))),
    },
    windows: configuredWindows.length > 0 ? configuredWindows : DEFAULT_CONFIG.windows,
    osNotify: booleanValue(source.osNotify, DEFAULT_CONFIG.osNotify),
    osNotifyOnCriticalOnly: booleanValue(
      source.osNotifyOnCriticalOnly,
      DEFAULT_CONFIG.osNotifyOnCriticalOnly,
    ),
  };
}

export function loadConfig(): UsageAlertConfig {
  const path = configPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return DEFAULT_CONFIG;
  }

  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(
      `Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function formatConfig(config: UsageAlertConfig): string {
  return [
    `Config: ${configPath()}`,
    `Enabled: ${config.enabled}`,
    `Poll interval: ${Math.round(config.pollIntervalMs / 1000)}s`,
    `Anthropic minimum poll interval: ${Math.round(config.anthropicMinPollMs / 1000)}s`,
    `Thresholds: warning <= ${config.thresholds.warning}% remaining, critical <= ${config.thresholds.critical}% remaining`,
    `Windows: ${config.windows.join(", ")}`,
    `OS notify: ${config.osNotify}`,
    `OS notify on critical only: ${config.osNotifyOnCriticalOnly}`,
  ].join("\n");
}
