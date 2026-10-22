/**
 * Pure confidence/salience decay for memories.
 *
 * The anchor is `lastConfirmedAt` when present (a memory that keeps being
 * confirmed should not fade) and `createdAt` otherwise. Scores halve every
 * half-life window: semantic/procedural memories are stable knowledge and use
 * a longer window than episodic memories, which describe a single event.
 *
 * This module deliberately does not touch `memories.expiresAt`. There is no
 * episodic retention value in `policy_config`, and inventing a TTL here would
 * hide a policy decision in a constant. Wire this helper to a scheduler only
 * after such a config key exists.
 */

export type DecayInput = {
  confidence: number;
  salience: number;
  type?: string;
  createdAt: Date;
  lastConfirmedAt: Date | null;
};

export type DecayOptions = {
  now?: Date;
  /** Half-life for semantic/procedural memories, in days. */
  halfLifeDays?: number;
  /** Half-life for episodic memories, in days. */
  episodicHalfLifeDays?: number;
  minConfidence?: number;
  minSalience?: number;
};

export type DecayedScores = {
  confidence: number;
  salience: number;
  /** Multiplicative decay factor applied to both scores (0–1). */
  factor: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function decayMemoryScores(
  input: DecayInput,
  options: DecayOptions = {},
): DecayedScores {
  const now = options.now ?? new Date();
  const halfLifeDays =
    input.type === "episodic"
      ? (options.episodicHalfLifeDays ?? 14)
      : (options.halfLifeDays ?? 90);
  const anchor = input.lastConfirmedAt ?? input.createdAt;
  const ageDays = Math.max(0, (now.getTime() - anchor.getTime()) / DAY_MS);
  const factor = 0.5 ** (ageDays / halfLifeDays);

  return {
    confidence: Math.max(
      options.minConfidence ?? 0.1,
      input.confidence * factor,
    ),
    salience: Math.max(options.minSalience ?? 0.1, input.salience * factor),
    factor,
  };
}
