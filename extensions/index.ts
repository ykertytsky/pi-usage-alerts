import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  cachedSnapshot,
  createAlertState,
  evaluateThresholdAlerts,
  formatStatus,
  rateLimitAlert,
  recordSnapshot,
  resetProviderState,
  shouldPollUsage,
  shouldSendOsNotification,
} from "../src/alerts.js";
import { formatConfig, loadConfig } from "../src/config.js";
import { notifyOS } from "../src/notify-os.js";
import type { NotifySeverity, UsageSnapshot } from "../src/types.js";
import {
  activeUsageProvider,
  fetchUsageSnapshot,
  formatUsageDetails,
  usageFamily,
} from "../src/usage.js";

type PiContext = {
  hasUI?: boolean;
  model?: unknown;
  ui?: {
    notify?: (message: string, type?: NotifySeverity) => void | Promise<void>;
  };
};

type CheckOptions = {
  force?: boolean;
  announceStatus?: boolean;
  notifyUnsupported?: boolean;
};

function notify(ctx: PiContext, message: string, severity: NotifySeverity = "info"): void {
  if (ctx.hasUI && ctx.ui?.notify) {
    void ctx.ui.notify(message, severity);
    return;
  }

  const prefix = severity === "error" ? "error" : severity;
  console.log(`[usage-alerts:${prefix}] ${message}`);
}

function currentProvider(ctx: PiContext): string | undefined {
  return activeUsageProvider(ctx.model);
}

async function pollUsage(
  provider: string,
  force: boolean,
  ctx: PiContext,
  state: ReturnType<typeof createAlertState>,
): Promise<UsageSnapshot | undefined> {
  const config = loadConfig();
  const family = usageFamily(provider);
  if (!family) return undefined;

  if (!shouldPollUsage(state, provider, family, config, { force })) {
    return cachedSnapshot(state, provider);
  }

  const snapshot = await fetchUsageSnapshot(provider);
  recordSnapshot(state, snapshot);

  if (snapshot.family === "anthropic" && !state.anthropicExtraUsageWarned) {
    state.anthropicExtraUsageWarned = true;
    notify(
      ctx,
      "Anthropic subscription auth may draw from Claude extra usage, billed per token. Manage it at https://claude.ai/settings/usage.",
      "warning",
    );
  }

  return snapshot;
}

async function checkAndAlert(
  ctx: PiContext,
  state: ReturnType<typeof createAlertState>,
  options: CheckOptions = {},
): Promise<UsageSnapshot | undefined> {
  const config = loadConfig();
  if (!config.enabled) {
    if (options.announceStatus) notify(ctx, "Usage alerts are disabled.", "info");
    return undefined;
  }

  const provider = currentProvider(ctx);
  resetProviderState(state, provider);
  if (!provider) {
    if (options.notifyUnsupported) notify(ctx, "No active provider is selected.", "warning");
    return undefined;
  }

  const family = usageFamily(provider);
  if (!family) {
    if (options.notifyUnsupported) {
      notify(
        ctx,
        `Usage alerts support OpenAI Codex and Anthropic OAuth providers, not "${provider}".`,
        "warning",
      );
    }
    return cachedSnapshot(state, provider);
  }

  let snapshot: UsageSnapshot | undefined;
  try {
    snapshot = await pollUsage(provider, !!options.force, ctx, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.force || options.announceStatus || options.notifyUnsupported) {
      notify(ctx, message, "error");
    }
    return cachedSnapshot(state, provider);
  }

  if (!snapshot) return undefined;

  const alerts = evaluateThresholdAlerts(state, snapshot, config);
  for (const alert of alerts) {
    notify(ctx, alert.message, alert.severity);
    if (shouldSendOsNotification(alert, config)) {
      notifyOS("Pi usage alert", alert.message);
    }
  }

  if (options.announceStatus) {
    notify(ctx, formatUsageDetails(snapshot), "info");
  }

  return snapshot;
}

function handleProviderResponse(
  event: { status?: number },
  ctx: PiContext,
  state: ReturnType<typeof createAlertState>,
): void {
  const status = event.status ?? 0;
  if (![402, 403, 429].includes(status)) return;

  const provider = currentProvider(ctx);
  if (!provider || !usageFamily(provider)) return;

  const alert = rateLimitAlert(state, provider, status);
  if (!alert) return;

  notify(ctx, alert.message, "error");
  notifyOS("Pi usage alert", alert.message);
}

export default function usageAlerts(pi: ExtensionAPI) {
  const state = createAlertState();

  pi.on("session_start", async (_event, ctx) => {
    await checkAndAlert(ctx as PiContext, state, { force: true });
  });

  pi.on("model_select", async (_event, ctx) => {
    resetProviderState(state, currentProvider(ctx as PiContext));
    await checkAndAlert(ctx as PiContext, state, { force: true });
  });

  pi.on("turn_end", async (_event, ctx) => {
    await checkAndAlert(ctx as PiContext, state);
  });

  pi.on("after_provider_response", (event, ctx) => {
    handleProviderResponse(event as { status?: number }, ctx as PiContext, state);
  });

  pi.registerCommand("usage-alerts", {
    description: "Show or refresh Codex/Anthropic subscription usage alerts.",
    handler: async (args, ctx) => {
      const [subcommand = "status"] = String(args ?? "").trim().split(/\s+/);
      const commandCtx = ctx as PiContext;
      const provider = currentProvider(commandCtx);

      if (subcommand === "config") {
        notify(commandCtx, formatConfig(loadConfig()), "info");
        return;
      }

      if (subcommand === "check" || subcommand === "refresh") {
        await checkAndAlert(commandCtx, state, {
          force: true,
          announceStatus: true,
          notifyUnsupported: true,
        });
        return;
      }

      if (subcommand !== "status") {
        notify(
          commandCtx,
          "Usage: /usage-alerts [status|check|refresh|config]",
          "warning",
        );
        return;
      }

      if (!provider) {
        notify(commandCtx, "No active provider is selected.", "warning");
        return;
      }

      const family = usageFamily(provider);
      if (!family) {
        notify(
          commandCtx,
          `Usage alerts support OpenAI Codex and Anthropic OAuth providers, not "${provider}".`,
          "warning",
        );
        return;
      }

      const snapshot =
        cachedSnapshot(state, provider) ??
        (await checkAndAlert(commandCtx, state, {
          force: true,
          notifyUnsupported: true,
        }));
      notify(commandCtx, formatStatus(snapshot), snapshot ? "info" : "warning");
    },
  });
}
