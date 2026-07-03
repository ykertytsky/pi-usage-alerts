import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type {
  UsageCredential,
  UsageFamily,
  UsageSnapshot,
  UsageWindow,
  UsageWindowName,
} from "./types.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

let authStore: unknown;

export class UsageFetchError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "UsageFetchError";
    this.status = status;
  }
}

function getAuthStore(): any {
  if (!authStore) {
    authStore = AuthStorage.create();
  }
  return authStore;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clampPercent(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined ? undefined : Math.min(100, Math.max(0, number));
}

function epochMs(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() && !Number.isFinite(Number(value))) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  const number = finiteNumber(value);
  if (number === undefined || number <= 0) return undefined;
  return number < 10_000_000_000 ? number * 1000 : number;
}

function usageWindow(
  name: UsageWindowName,
  value: unknown,
  fallbackWindowSeconds: number,
): UsageWindow | undefined {
  const source = record(value);
  const usedPercent = clampPercent(
    source.used_percent ?? source.usedPercent ?? source.utilization,
  );
  const resetAt = epochMs(source.reset_at ?? source.resetAt ?? source.resets_at);
  if (usedPercent === undefined || resetAt === undefined) return undefined;

  return {
    name,
    usedPercent,
    resetAt,
    windowSeconds: finiteNumber(source.limit_window_seconds) ?? fallbackWindowSeconds,
  };
}

export function usageFamily(provider: string): UsageFamily | undefined {
  if (provider === "openai-codex" || /^openai-codex-account-\d+$/.test(provider)) {
    return "codex";
  }
  if (provider === "anthropic" || /^anthropic-account-\d+$/.test(provider)) {
    return "anthropic";
  }
  return undefined;
}

export function providerUsageLabel(provider: string): string {
  const index = provider.match(/-account-(\d+)$/)?.[1];
  if (provider.startsWith("openai-codex")) return index ? `Codex A${index}` : "Codex";
  if (provider.startsWith("anthropic")) return index ? `Claude A${index}` : "Claude";
  return provider;
}

export function parseCodexUsageBody(
  provider: string,
  body: unknown,
  fetchedAt = Date.now(),
): UsageSnapshot | undefined {
  const source = record(body);
  const rateLimit = record(source.rate_limit);
  const primary = usageWindow("5h", rateLimit.primary_window, 5 * 60 * 60);
  const secondary = usageWindow("7d", rateLimit.secondary_window, 7 * 24 * 60 * 60);
  if (!primary && !secondary) return undefined;

  const creditsSource = record(source.credits);
  const credits =
    Object.keys(creditsSource).length > 0
      ? {
          hasCredits:
            typeof creditsSource.has_credits === "boolean"
              ? creditsSource.has_credits
              : undefined,
          unlimited:
            typeof creditsSource.unlimited === "boolean"
              ? creditsSource.unlimited
              : undefined,
          balance:
            typeof creditsSource.balance === "string" ||
            typeof creditsSource.balance === "number"
              ? String(creditsSource.balance)
              : undefined,
        }
      : undefined;

  return {
    provider,
    family: "codex",
    fetchedAt,
    plan:
      typeof rateLimit.limit_name === "string"
        ? rateLimit.limit_name
        : typeof source.plan_type === "string"
          ? source.plan_type
          : undefined,
    primary,
    secondary,
    credits,
  };
}

export function parseAnthropicUsageBody(
  provider: string,
  body: unknown,
  fetchedAt = Date.now(),
): UsageSnapshot | undefined {
  const source = record(body);
  const primary = usageWindow("5h", source.five_hour, 5 * 60 * 60);
  const secondary = usageWindow("7d", source.seven_day, 7 * 24 * 60 * 60);
  if (!primary && !secondary) return undefined;

  return {
    provider,
    family: "anthropic",
    fetchedAt,
    primary,
    secondary,
  };
}

async function getOAuthCredential(provider: string): Promise<UsageCredential> {
  const auth = getAuthStore();
  const stored = typeof auth.get === "function" ? auth.get(provider) : undefined;
  const credential = record(stored) as UsageCredential;
  const access =
    typeof auth.getApiKey === "function"
      ? await auth.getApiKey(provider, { includeFallback: true })
      : credential.access;

  if (credential.type !== "oauth") {
    throw new UsageFetchError(`${provider} is not authenticated with OAuth; run /login.`);
  }
  if (!access) {
    throw new UsageFetchError(`${provider} has no OAuth access token; run /login.`);
  }

  return {
    ...credential,
    access,
  };
}

export async function fetchUsageSnapshot(
  provider: string,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<UsageSnapshot> {
  const family = usageFamily(provider);
  if (!family) {
    throw new UsageFetchError(`Usage alerts do not support provider "${provider}".`);
  }

  const credential = await getOAuthCredential(provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const signal = options.signal ?? controller.signal;
  const fetchImpl = options.fetchImpl ?? fetch;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.access}`,
    Accept: "application/json",
  };
  let url: string;

  if (family === "codex") {
    url = CODEX_USAGE_URL;
    if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
  } else {
    url = ANTHROPIC_USAGE_URL;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  }

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal,
    });
    if (!response.ok) {
      throw new UsageFetchError(
        `${provider} usage endpoint returned HTTP ${response.status}`,
        response.status,
      );
    }

    const body = await response.json();
    const snapshot =
      family === "codex"
        ? parseCodexUsageBody(provider, body)
        : parseAnthropicUsageBody(provider, body);
    if (!snapshot) {
      throw new UsageFetchError(`${provider} usage endpoint returned no 5h/7d windows.`);
    }

    return snapshot;
  } catch (error) {
    if (error instanceof UsageFetchError) throw error;
    if ((error as { name?: string })?.name === "AbortError") {
      throw new UsageFetchError(`${provider} usage request timed out.`);
    }
    throw new UsageFetchError(
      `${provider} usage request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function remainingPercent(window: UsageWindow): number {
  return Math.max(0, Math.round(100 - window.usedPercent));
}

export function formatResetDuration(resetAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}h${restMinutes}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d${restHours}h` : `${days}d`;
}

export function formatUsageCompact(snapshot: UsageSnapshot, now = Date.now()): string {
  const parts = [providerUsageLabel(snapshot.provider)];
  if (snapshot.primary) {
    parts.push(
      `5h ${remainingPercent(snapshot.primary)}% left/${formatResetDuration(
        snapshot.primary.resetAt,
        now,
      )}`,
    );
  }
  if (snapshot.secondary) {
    parts.push(
      `7d ${remainingPercent(snapshot.secondary)}% left/${formatResetDuration(
        snapshot.secondary.resetAt,
        now,
      )}`,
    );
  }
  if (snapshot.credits?.unlimited) parts.push("credits unlimited");
  else if (snapshot.credits?.balance !== undefined) {
    parts.push(`credits ${snapshot.credits.balance}`);
  }
  return parts.join(" | ");
}

export function formatUsageDetails(snapshot: UsageSnapshot, now = Date.now()): string {
  const lines = [
    `Limits for ${providerUsageLabel(snapshot.provider)}${snapshot.plan ? ` (${snapshot.plan})` : ""}`,
  ];

  for (const [label, window] of [
    ["5h", snapshot.primary],
    ["7d", snapshot.secondary],
  ] as const) {
    if (!window) continue;
    lines.push(
      `${label}: ${remainingPercent(window)}% left (${Math.round(
        window.usedPercent,
      )}% used), resets in ${formatResetDuration(window.resetAt, now)} at ${new Date(
        window.resetAt,
      ).toLocaleString()}`,
    );
  }

  if (snapshot.credits?.unlimited) lines.push("Credits: unlimited");
  else if (snapshot.credits?.balance !== undefined) {
    lines.push(`Credits: ${snapshot.credits.balance}`);
  }
  lines.push(`Updated ${formatResetDuration(now, snapshot.fetchedAt)} ago`);
  return lines.join("\n");
}

export function activeUsageProvider(model: unknown): string | undefined {
  const source = record(model);
  const provider = source.provider;
  return typeof provider === "string" ? provider : undefined;
}
