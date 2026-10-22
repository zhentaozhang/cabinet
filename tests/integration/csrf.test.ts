import { describe, expect, it } from "vitest";
import { handleMutation } from "@/lib/api/mutation";

describe("CSRF origin check", () => {
  it("blocks a mutation from a different origin", async () => {
    const response = await handleMutation({
      request: new Request("http://localhost:3000/api/tasks", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
      endpoint: "test.mutation",
      handler: async () => ({ status: 200, body: { ok: true } }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("forbidden");
  });
});
