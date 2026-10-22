import { getApiUserId } from "@/lib/auth/context";
import { exportAccount } from "@/lib/account";
import { toErrorResponse } from "@/lib/domain/errors";

export async function GET() {
  try {
    const userId = await getApiUserId();
    const data = await exportAccount(userId);
    return Response.json({ ok: true, data });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
