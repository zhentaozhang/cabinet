import { redirect } from "next/navigation";
import { cache } from "react";
import type { z } from "zod";

import {
  API_ROUTES,
  agentPageSchema,
  auditPageSchema,
  cabinetPageSchema,
  councilPageSchema,
  memoryPageSchema,
  reviewPageSchema,
  shellContextSchema,
  connectorStatusSchema,
  deliveryPageSchema,
  taskPageSchema,
  todayPageSchema,
  workspaceStateSchema,
  type AgentPageDto,
  type ConnectorStatusDto,
  type DeliveryPageDto,
  type CabinetPageDto,
  type CouncilPageDto,
  type MemoryPageDto,
  type ReviewPageDto,
  type ShellContextDto,
  type TaskPageDto,
  type TodayPageDto,
} from "@/contracts";

import { serverApi } from "./server";
import { needsSetup } from "./page-guard";

/**
 * Page data loaders.
 *
 * Each loader is one HTTP call against the read API. `null` means "this
 * resource does not exist for this user" and the page turns it into
 * `notFound()`; every other failure throws so the route error boundary owns it.
 * A 401 means the session expired, which is a navigation, not an error.
 */
async function loadPage<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<{ missing: true } | { data: T }> {
  const api = await serverApi();
  // The transport takes a plain validator; zod lives on this side, where page
  // rendering already runs, and never enters the browser bundle.
  const result = await api.query(path, (value) => schema.parse(value));

  if (result.ok) return { data: result.data };
  if (result.code === "unauthorized") redirect("/login");
  if (result.code === "not_found") return { missing: true };

  throw new Error(result.error);
}

export async function fetchTodayPage(): Promise<TodayPageDto> {
  const result = await loadPage("/api/today", todayPageSchema);
  if ("missing" in result) redirect("/setup");
  if (needsSetup(result.data.agents)) redirect("/setup");
  return result.data;
}

export async function fetchReviewPage(options: {
  limit?: number;
  insightOffset?: number;
  dissentOffset?: number;
} = {}): Promise<ReviewPageDto> {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.insightOffset) {
    params.set("insightOffset", String(options.insightOffset));
  }
  if (options.dissentOffset) {
    params.set("dissentOffset", String(options.dissentOffset));
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const result = await loadPage(`/api/review${query}`, reviewPageSchema);
  if ("missing" in result) redirect("/setup");
  if (needsSetup(result.data.agents)) redirect("/setup");
  return result.data;
}

export async function fetchCabinetPage(): Promise<CabinetPageDto> {
  const result = await loadPage("/api/cabinet", cabinetPageSchema);
  if ("missing" in result) redirect("/setup");
  if (needsSetup(result.data.agents)) redirect("/setup");
  return result.data;
}

export async function fetchMemoryPage(
  type?: string,
  view: "current" | "history" = "current",
  options: { limit?: number; offset?: number } = {},
): Promise<MemoryPageDto> {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (view === "history") params.set("view", "history");
  if (options.limit) params.set("limit", String(options.limit));
  if (options.offset) params.set("offset", String(options.offset));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const result = await loadPage(`/api/memory${query}`, memoryPageSchema);
  if ("missing" in result) redirect("/setup");
  return result.data;
}

export async function fetchAuditPage(
  options: { kind?: string | null; offset?: number } = {},
) {
  const params = new URLSearchParams();
  if (options.kind) params.set("kind", options.kind);
  if (options.offset) params.set("offset", String(options.offset));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return loadPage(`/api/audit${suffix}`, auditPageSchema);
}

export async function fetchCouncilPage(): Promise<CouncilPageDto | null> {
  const result = await loadPage("/api/council", councilPageSchema);
  return "missing" in result ? null : result.data;
}

export async function fetchAgentPage(
  agentId: string,
): Promise<AgentPageDto | null> {
  const result = await loadPage(
    `/api/agents/${encodeURIComponent(agentId)}`,
    agentPageSchema,
  );
  return "missing" in result ? null : result.data;
}

export async function fetchTaskPage(
  taskId: string,
): Promise<TaskPageDto | null> {
  const result = await loadPage(
    `/api/tasks/${encodeURIComponent(taskId)}`,
    taskPageSchema,
  );
  return "missing" in result ? null : result.data;
}

export async function fetchWorkspaceReady(): Promise<boolean> {
  const api = await serverApi();
  const result = await api.query("/api/setup", (value) =>
    workspaceStateSchema.parse(value),
  );
  if (!result.ok) {
    if (result.code === "unauthorized") redirect("/login");
    throw new Error(result.error);
  }
  return result.data.hasWorkspace;
}

/**
 * Memoised per request: the root layout already needs the shell context, so a
 * page that needs it again (e.g. /setup) reuses the same response instead of
 * paying a second round-trip for identical data.
 */
export const fetchShellContext = cache(async (): Promise<ShellContextDto> => {
  const api = await serverApi();
  const result = await api.query(API_ROUTES.shell, (value) =>
    shellContextSchema.parse(value),
  );
  if (!result.ok) throw new Error(result.error);
  return result.data;
});

/** Delivery log and notification preferences for `/settings/notifications`. */
export async function fetchDeliveryPage(
  offset = 0,
): Promise<DeliveryPageDto> {
  const path = offset > 0
    ? `${API_ROUTES.notifications}?offset=${offset}`
    : API_ROUTES.notifications;
  const result = await loadPage(path, deliveryPageSchema);
  if ("missing" in result) throw new Error("Notifications endpoint returned not found");
  return result.data;
}

/** Connector state for `/settings/connectors`; never includes a key. */
export async function fetchConnectorStatus(): Promise<ConnectorStatusDto> {
  const result = await loadPage(API_ROUTES.connectors, connectorStatusSchema);
  if ("missing" in result) throw new Error("Connectors endpoint returned not found");
  return result.data;
}
