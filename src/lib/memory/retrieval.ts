import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";

export type RetrievalCandidate = {
  id: string;
  content: string;
  salience: number;
  createdAt: Date;
  lastConfirmedAt: Date | null;
};

export type MemoryScores = {
  recency: number;
  relevance: number;
  importance: number;
  total: number;
};

export type ScoredMemory<T extends RetrievalCandidate> = T & {
  scores: MemoryScores;
};

const RECENCY_DECAY = 0.99;
const WEIGHTS = { recency: 0.5, relevance: 3, importance: 2 };

function tokenize(text: string): string[] {
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  const tokens: string[] = [];
  for (const part of segmenter.segment(text.toLowerCase())) {
    const token = part.segment.trim();
    if (token.length < 2) continue;
    if (!/[\p{L}\p{N}]/u.test(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

function relevance(queryTokens: Set<string>, content: string): number {
  if (queryTokens.size === 0) return 0;
  const contentTokens = new Set(tokenize(content));
  let hits = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.size;
}

function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0);
  return values.map((value) => (value - min) / (max - min));
}

/**
 * Pure retrieval scorer. Weights follow Generative Agents:
 * recency 0.5, relevance 3, importance 2 (after min-max normalization).
 */
export function scoreMemories<T extends RetrievalCandidate>(
  query: string,
  candidates: T[],
  now: Date = new Date(),
): Array<ScoredMemory<T>> {
  const queryTokens = new Set(tokenize(query));

  const raw = candidates.map((candidate) => {
    const anchor = candidate.lastConfirmedAt ?? candidate.createdAt;
    const hours = Math.max(0, (now.getTime() - anchor.getTime()) / 3_600_000);
    return {
      candidate,
      recency: RECENCY_DECAY ** hours,
      relevance: relevance(queryTokens, candidate.content),
      importance: candidate.salience,
    };
  });

  const recencyNorm = normalize(raw.map((item) => item.recency));
  const relevanceNorm = normalize(raw.map((item) => item.relevance));
  const importanceNorm = normalize(raw.map((item) => item.importance));

  return raw
    .map((item, index) => {
      const total =
        WEIGHTS.recency * recencyNorm[index] +
        WEIGHTS.relevance * relevanceNorm[index] +
        WEIGHTS.importance * importanceNorm[index];
      return {
        ...item.candidate,
        scores: {
          recency: recencyNorm[index],
          relevance: relevanceNorm[index],
          importance: importanceNorm[index],
          total,
        },
      };
    })
    .sort((a, b) => b.scores.total - a.scores.total);
}

export async function retrieveMemories(
  userId: string,
  query: string,
  options: { limit?: number; now?: Date } = {},
): Promise<Array<ScoredMemory<typeof memories.$inferSelect>>> {
  const now = options.now ?? new Date();
  const rows = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        eq(memories.status, "active"),
        or(isNull(memories.expiresAt), gt(memories.expiresAt, now)),
      ),
    )
    .limit(200);

  return scoreMemories(query, rows, now).slice(0, options.limit ?? 8);
}
