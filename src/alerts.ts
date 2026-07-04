import type {
  AlertCandidate,
  RateLimitAlert,
  UsageAlertConfig,
  UsageFamily,
  UsageSnapshot,
  UsageWindow,
} from "./types.js";
import {
  formatResetDuration,
  formatUsageCompact,
  providerUsageLabel,
  remainingPercent,
} from "./usage.js";

const RATE_LIMIT_DEDUP_MS = 60 * 1000;

export interface AlertState {
  activeProvider?: string;
  snapshots: Map<string, UsageSnapshot>;
  lastFetchByProvider: Map<string, number>;
  sentThresholdAlerts: Set<string>;
  recentRateLimitAlerts: Map<string, number>;
  anthropicExtraUsageWarned: boolean;
}

export function createAlertState(): AlertState {
  return {
    snapshots: new Map(),
    lastFetchByProvider: new Map(),
    sentThresholdAlerts: new Set(),
    recentRateLimitAlerts: new Map(),
    anthropicExtraUsageWarned: false,
  };
}

export function resetProviderState(state: AlertState, provider: string | undefined): void {
  if (state.activeProvider === provider) return;
  state.activeProvider = provider;
  state.sentThresholdAlerts.clear();
  state.recentRateLimitAlerts.clear();
}

export function recordSnapshot(state: AlertState, snapshot: UsageSnapshot): void {
  state.snapshots.set(snapshot.provider, snapshot);
  state.lastFetchByProvider.set(snapshot.provider, snapshot.fetchedAt);
}

export function cachedSnapshot(
  state: AlertState,
  provider: string | undefined,
): UsageSnapshot | undefined {
  return provider ? state.snapshots.get(provider) : undefined;
}

export function shouldPollUsage(
  state: AlertState,
  provider: string,
  family: UsageFamily,
  config: UsageAlertConfig,
  options: { force?: boolean; now?: number } = {},
): boolean {
  if (options.force) return true;

  const now = options.now ?? Date.now();
  const lastFetch = state.lastFetchByProvider.get(provider);
  if (!lastFetch) return true;

  const minInterval =
    family === "anthropic"
      ? Math.max(config.pollIntervalMs, config.anthropicMinPollMs)
      : config.pollIntervalMs;
  return now - lastFetch >= minInterval;
}

function alertKey(snapshot: UsageSnapshot, window: UsageWindow, tier: string): string {
  return `${snapshot.provider}:${window.name}:${tier}:${window.resetAt}`;
}

function thresholdTier(
  remaining: number,
  config: UsageAlertConfig,
): AlertCandidate["tier"] | undefined {
  if (remaining <= 0) return "exhausted";
  if (remaining <= config.thresholds.critical) return "critical";
  if (remaining <= config.thresholds.warning) return "warning";
  return undefined;
}

function severityForTier(tier: AlertCandidate["tier"]): AlertCandidate["severity"] {
  return tier === "warning" ? "warning" : "error";
}

function tierRank(tier: AlertCandidate["tier"]): number {
  if (tier === "exhausted") return 3;
  if (tier === "critical") return 2;
  return 1;
}

function windowLabel(window: UsageWindow): string {
  return window.name === "5h" ? "5-hour" : "7-day";
}

function thresholdMessage(
  snapshot: UsageSnapshot,
  window: UsageWindow,
  tier: AlertCandidate["tier"],
  remaining: number,
  now: number,
): string {
  const provider = providerUsageLabel(snapshot.provider);
  const reset = formatResetDuration(window.resetAt, now);
  const used = Math.round(window.usedPercent);
  if (tier === "exhausted") {
    return `${provider} ${windowLabel(window)} session limit appears exhausted; resets in ${reset}.`;
  }
  return `${provider} ${windowLabel(window)} session limit is low: ${remaining}% left (${used}% used), resets in ${reset}.`;
}

function thresholdWindows(snapshot: UsageSnapshot, config: UsageAlertConfig): UsageWindow[] {
  return [snapshot.primary, snapshot.secondary].filter(
    (window): window is UsageWindow => !!window && config.windows.includes(window.name),
  );
}

export function currentThresholdAlert(
  snapshot: UsageSnapshot,
  config: UsageAlertConfig,
  now = Date.now(),
): AlertCandidate | undefined {
  let current: AlertCandidate | undefined;

  for (const window of thresholdWindows(snapshot, config)) {
    const remaining = remainingPercent(window);
    const tier = thresholdTier(remaining, config);
    if (!tier) continue;

    const candidate: AlertCandidate = {
      snapshot,
      window,
      tier,
      severity: severityForTier(tier),
      remainingPercent: remaining,
      message: thresholdMessage(snapshot, window, tier, remaining, now),
    };

    if (
      !current ||
      tierRank(candidate.tier) > tierRank(current.tier) ||
      (tierRank(candidate.tier) === tierRank(current.tier) &&
        candidate.remainingPercent < current.remainingPercent)
    ) {
      current = candidate;
    }
  }

  return current;
}

export function evaluateThresholdAlerts(
  state: AlertState,
  snapshot: UsageSnapshot,
  config: UsageAlertConfig,
  now = Date.now(),
): AlertCandidate[] {
  const alerts: AlertCandidate[] = [];

  for (const window of thresholdWindows(snapshot, config)) {
    const remaining = remainingPercent(window);
    const tier = thresholdTier(remaining, config);
    if (!tier) continue;

    const key = alertKey(snapshot, window, tier);
    if (state.sentThresholdAlerts.has(key)) continue;
    state.sentThresholdAlerts.add(key);

    alerts.push({
      snapshot,
      window,
      tier,
      severity: severityForTier(tier),
      remainingPercent: remaining,
      message: thresholdMessage(snapshot, window, tier, remaining, now),
    });
  }

  return alerts;
}

export function shouldSendOsNotification(
  alert: AlertCandidate,
  config: UsageAlertConfig,
): boolean {
  if (!config.osNotify) return false;
  if (!config.osNotifyOnCriticalOnly) return true;
  return alert.tier === "critical" || alert.tier === "exhausted";
}

export function rateLimitAlert(
  state: AlertState,
  provider: string,
  status: number,
  now = Date.now(),
): RateLimitAlert | undefined {
  const key = `${provider}:${status}`;
  const lastSent = state.recentRateLimitAlerts.get(key);
  if (lastSent && now - lastSent < RATE_LIMIT_DEDUP_MS) return undefined;

  state.recentRateLimitAlerts.set(key, now);
  return {
    provider,
    status,
    message: `${providerUsageLabel(provider)} returned HTTP ${status}; the active subscription may be rate-limited or out of usage.`,
  };
}

export function formatStatus(snapshot: UsageSnapshot | undefined): string {
  if (!snapshot) {
    return "No usage snapshot yet. Run /usage-alerts check after selecting Codex or Anthropic.";
  }
  return formatUsageCompact(snapshot);
}
