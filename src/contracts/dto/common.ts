import { z } from "zod";

/**
 * Primitives shared by every DTO.
 *
 * Rule: the wire format never contains a `Date` instance. Every timestamp is an
 * ISO-8601 string produced by the server mapper, so the web side can run the
 * exact same code whether the payload came from a server render or the browser.
 */
export const isoDateTime = z.iso.datetime();

export const jsonObject = z.record(z.string(), z.unknown());

export const evidenceSchema = z.object({
  label: z.string(),
  ref: z.string().optional(),
  quote: z.string().optional(),
});
export type EvidenceDto = z.infer<typeof evidenceSchema>;

/**
 * `insights.proposed_change` is a jsonb column, so the DTO keeps only the fields
 * the UI renders and tolerates extra ones instead of rejecting a whole page.
 */
export const insightChangeSchema = z
  .object({
    type: z.string(),
    taskId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    minutes: z.number().optional(),
    rule: z.string().optional(),
  })
  .catchall(z.unknown());
export type InsightChangeDto = z.infer<typeof insightChangeSchema>;
