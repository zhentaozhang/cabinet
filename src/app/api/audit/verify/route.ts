import { verifyAuditChain } from "@/lib/audit";
import { handleQuery } from "@/lib/api/read";

export async function GET() {
  // A broken chain is a successful verification with a negative verdict, not a
  // transport failure: the client has to show *which* event broke the chain.
  return handleQuery(async (userId) => {
    const result = await verifyAuditChain(userId);
    return {
      verified: result.ok,
      checked: result.checked,
      firstMismatch: result.firstMismatch,
    };
  });
}
