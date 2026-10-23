import { verifyAuditChain } from "@/lib/audit";
import { handleQueryWithRequest } from "@/lib/api/read";

export async function GET(request: Request) {
  // A broken chain is a successful verification with a negative verdict, not a
  // transport failure: the client has to show *which* event broke the chain.
  return handleQueryWithRequest(request, async (userId) => {
    const result = await verifyAuditChain(userId);
    return {
      verified: result.ok,
      checked: result.checked,
      firstMismatch: result.firstMismatch,
    };
  });
}
