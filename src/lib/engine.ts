/**
 * @deprecated Server-only compatibility shim.
 *
 * The implementation now lives in `src/server/services/engine.ts`, which is the
 * layer that becomes `apps/api` once the split is physical. Web code (pages and
 * components) must NOT import this module: it has to go through
 * `@/lib/api/server` (server components) or `@/lib/api/browser` (client
 * components) so the frontend only ever speaks HTTP + DTOs.
 *
 * Integration tests still import from here during the migration; the shim
 * disappears once they are pointed at the API.
 *
 * This is the only `src/lib` module allowed to import `@/server` — it is listed
 * by name in `tests/unit/boundary.test.ts` (`LIB_TO_SERVER_ALLOWED`). Adding a
 * second entry is a decision about where the boundary sits, not a formality.
 */
export * from "@/server/services/engine";
