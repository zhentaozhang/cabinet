import { revalidatePath } from "next/cache";
import { recordApprenticeObservation } from "@/server/services/commands/apprentice";
import { handleMutation } from "@/lib/api/mutation";
import { apprenticeObservationSchema } from "@/lib/validation/schemas";
import { parseBody } from "@/lib/validation/parse";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: "apprentice.observations",
    body,
    handler: async (userId) => {
      const input = parseBody(apprenticeObservationSchema, body);
      // The client only names a run; eligibility and ownership are re-checked
      // server-side against the mentor relationship and run provenance.
      const result = await recordApprenticeObservation(userId, input.runId);
      revalidatePath("/cabinet");
      revalidatePath("/cabinet/ag_apprentice");
      revalidatePath("/review");
      return { status: 200, body: { ok: true, ...result } };
    },
  });
}
