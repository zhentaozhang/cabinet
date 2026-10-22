import { verifyAuditChain } from "@/lib/audit";
import { getApiUserId } from "@/lib/auth/context";
import { toErrorResponse } from "@/lib/domain/errors";

export async function GET() {
  try {
    const userId = await getApiUserId();
    const result = await verifyAuditChain(userId);
    return Response.json(result);
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
