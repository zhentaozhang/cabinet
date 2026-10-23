import { AsyncLocalStorage } from "node:async_hooks";

type RequestScope = {
  requestId: string;
  startedAt: number;
};

const storage = new AsyncLocalStorage<RequestScope>();

/** Arbitrary length bound: an id is for correlation, not for carrying data. */
const MAX_INBOUND_ID = 64;
const INBOUND_ID = /^[A-Za-z0-9._:-]{1,64}$/;

function newRequestId(): string {
  return `req_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/**
 * Keep a caller's id when it looks like an id.
 *
 * A proxy or an upstream service usually already assigned one, and inventing a
 * second id breaks the only thing a request id is for. Anything longer or
 * stranger than the pattern is replaced, so a header cannot smuggle content
 * into every log line.
 */
export function inboundRequestId(request: Request): string | null {
  const header = request.headers.get("x-request-id");
  if (!header) return null;
  if (header.length > MAX_INBOUND_ID) return null;
  return INBOUND_ID.test(header) ? header : null;
}

/**
 * Run one HTTP request inside a scope every log line can read.
 *
 * `AsyncLocalStorage` rather than threading a parameter: the alternative is
 * passing a context object through the entire service layer, which would put
 * observability concerns in signatures that have nothing to do with it.
 */
export async function runWithRequestScope<T>(
  request: Request,
  fn: () => Promise<T>,
): Promise<{ result: T; requestId: string }> {
  const requestId = inboundRequestId(request) ?? newRequestId();
  return storage.run(
    { requestId, startedAt: Date.now() },
    async () => ({ result: await fn(), requestId }),
  );
}

export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

export function currentRequestElapsedMs(): number | null {
  const startedAt = storage.getStore()?.startedAt;
  return startedAt === undefined ? null : Date.now() - startedAt;
}
