import {
  connectorStatusSchema,
  connectorTestSchema,
  type ConnectorStatusDto,
  type ConnectorTestDto,
} from "@/contracts";
import {
  configuredSearchProviders,
  searchWithFallback,
} from "@/lib/connectors/registry";
import { smtpConfigFromEnv } from "@/lib/connectors/email";
import type { ConnectorErrorCode } from "@/lib/connectors/types";
import { asDto } from "@/server/dto-guard";

/** `DEMO_MODE` is read in one place so the UI and the run agree on it. */
export function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE === "true";
}

/**
 * Connector state, derived from the environment only.
 *
 * This is deliberately a read model: the page must be able to say "not
 * configured" without attempting a call, and without ever exposing a key.
 */
export function loadConnectors(demoMode = demoModeEnabled()): ConnectorStatusDto {
  const providers = configuredSearchProviders().map((provider) => provider.name);
  const [primary, fallback] = providers;

  return asDto(
    connectorStatusSchema,
    {
      search: {
        // Named even when unconfigured: the page must be able to say which
        // variable to set without first having a key.
        provider: primary ?? "brave",
        configured: providers.length > 0,
        envVar: primary === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY",
        fallback: fallback ?? null,
        fallbackConfigured: providers.length > 1,
      },
      model: {
        provider: "openai",
        model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
        configured: Boolean(process.env.OPENAI_API_KEY),
        envVar: "OPENAI_API_KEY",
      },
      email: (() => {
        const smtp = smtpConfigFromEnv();
        return {
          configured: smtp !== null,
          host: smtp?.host ?? null,
          port: smtp?.port ?? null,
          from: smtp?.from ?? null,
          secure: smtp?.secure ?? false,
          envVars: ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"],
        };
      })(),
      demoMode,
    },
    "ConnectorStatus",
  );
}

const TEST_QUERY = "retrieval augmented generation survey";

const ERROR_STATUS: Record<ConnectorErrorCode, ConnectorTestDto["status"]> = {
  not_configured: "not_configured",
  unauthorized: "unauthorized",
  rate_limited: "rate_limited",
  timeout: "timeout",
  invalid_response: "invalid_response",
  network_error: "network_error",
};

/**
 * One real attempt, so "connected" means something. Costs one search call and
 * is rate-limited by the shared mutation pipeline.
 */
export async function testConnector(): Promise<ConnectorTestDto> {
  const outcome = await searchWithFallback({ query: TEST_QUERY, limit: 1 });

  if (!outcome.ok) {
    return asDto(
      connectorTestSchema,
      {
        status: ERROR_STATUS[outcome.error.code],
        provider: outcome.provider === "none" ? null : outcome.provider,
        latencyMs: Math.round(outcome.latencyMs),
        hits: 0,
        sample: null,
        message: outcome.error.message,
      },
      "ConnectorTest",
    );
  }

  const [first] = outcome.hits;
  return asDto(
    connectorTestSchema,
    {
      status: "ok",
      provider: outcome.provider,
      latencyMs: Math.round(outcome.latencyMs),
      hits: outcome.hits.length,
      sample: first
        ? { title: first.title, url: first.url, publisher: first.publisher }
        : null,
      message: null,
    },
    "ConnectorTest",
  );
}
