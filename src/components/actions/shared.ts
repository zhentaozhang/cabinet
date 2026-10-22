"use client";

import { browserApi } from "@/lib/api/browser";

export async function call(
  url: string,
  method: "POST" | "PATCH",
  body?: unknown,
): Promise<{
  ok: boolean;
  error?: string;
  code?: string;
  [key: string]: unknown;
}> {
  const result = await browserApi.mutate<Record<string, unknown>>(url, {
    method,
    body,
  });

  if (!result.ok) {
    return { ok: false, error: result.error, code: result.code };
  }

  return { ok: true, ...result.data };
}
