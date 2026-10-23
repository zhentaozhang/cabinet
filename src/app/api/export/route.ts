import { getApiUserId } from "@/lib/auth/context";
import { exportAccountNdjson } from "@/lib/account-export";
import { toErrorResponse } from "@/lib/domain/errors";

/**
 * Streams the account as NDJSON so a long run history does not have to fit in
 * memory on either side. The first line says what the format is.
 */
export async function GET() {
  try {
    const userId = await getApiUserId();
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of exportAccountNdjson(userId)) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        } catch (error) {
          // The response has already started, so the only honest move is to
          // fail the stream instead of pretending the export is complete.
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": 'attachment; filename="cabinet-export.ndjson"',
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
