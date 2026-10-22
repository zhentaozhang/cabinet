import { verifyAuditChain } from "@/lib/audit";
import { DEMO_USER_ID } from "@/lib/engine";
import { toErrorResponse } from "@/lib/domain/errors";

export async function GET() {
  try {
    const result = await verifyAuditChain(DEMO_USER_ID);
    return Response.json(result);
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
