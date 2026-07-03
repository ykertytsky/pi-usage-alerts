export type UsageFamily = "codex" | "anthropic";

export type UsageWindowName = "5h" | "7d";

export type NotifySeverity = "info" | "warning" | "error";

export interface UsageWindow {
  name: UsageWindowName;
  usedPercent: number;
  resetAt: number;
  windowSeconds: number;
}

export interface UsageSnapshot {
  provider: string;
  family: UsageFamily;
  fetchedAt: number;
  plan?: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  credits?: {
    hasCredits?: boolean;
    unlimited?: boolean;
    balance?: string;
  };
}

export interface UsageCredential {
  type?: string;
  access?: string;
  accountId?: string;
  key?: string;
  expires?: number;
}

export interface UsageAlertConfig {
  enabled: boolean;
  pollIntervalMs: number;
  anthropicMinPollMs: number;
  thresholds: {
    warning: number;
    critical: number;
  };
  windows: UsageWindowName[];
  osNotify: boolean;
  osNotifyOnCriticalOnly: boolean;
}

export interface AlertCandidate {
  snapshot: UsageSnapshot;
  window: UsageWindow;
  tier: "warning" | "critical" | "exhausted";
  severity: "warning" | "error";
  remainingPercent: number;
  message: string;
}

export interface RateLimitAlert {
  provider: string;
  status: number;
  message: string;
}
