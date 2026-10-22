import { redirect } from "next/navigation";
import type { z } from "zod";

import {
  agentPageSchema,
  cabinetPageSchema,
  councilPageSchema,
  memoryPageSchema,
  reviewPageSchema,
  shellContextSchema,
  taskPageSchema,
  todayPageSchema,
  workspaceStateSchema,
  type AgentPageDto,
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
  const result = await api.query(path, schema);

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
  const result = await api.query("/api/setup", workspaceStateSchema);
  if (!result.ok) {
    if (result.code === "unauthorized") redirect("/login");
    throw new Error(result.error);
  }
  return result.data.hasWorkspace;
}

export async function fetchShellContext(): Promise<ShellContextDto> {
  const api = await serverApi();
  const result = await api.query("/api/shell", shellContextSchema);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
