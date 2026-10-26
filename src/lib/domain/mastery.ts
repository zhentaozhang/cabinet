/**
 * Per-topic mastery and the spacing schedule behind it.
 *
 * The learning loop used to keep a single global recall score and a free-text
 * list of error tags. That can pick *a* topic but cannot answer "how well does
 * this person know closures", and it cannot schedule anything: one global
 * number has no per-topic history to space repetitions from.
 *
 * Everything here is a pure function so the schedule can be replayed in tests
 * and explained to the user. Nothing reads the clock on its own — the caller
 * passes `now`, which is what lets the service decide between the database
 * clock (production) and an injected instant (replay).
 */

/** The topic a learner is asked about when nothing more specific is known. */
export const DEFAULT_TOPIC_KEY = "基础概念";

/**
 * One topic is asked at most once every two months. Without a ceiling the
 * interval grows by `easeFactor` forever and a topic that was answered
 * correctly a dozen times would never be revisited inside a human lifetime.
 */
export const MAX_INTERVAL_DAYS = 60;

/**
 * SM-2's classic floor and the ceiling this app uses. A factor below 1.3
 * would make `intervalDays * easeFactor` shrink the gap on a *correct*
 * answer; the ceiling keeps a lucky streak from turning one topic into a
 * once-a-year ritual.
 */
export const MIN_EASE_FACTOR = 1.3;
export const MAX_EASE_FACTOR = 2.8;

/** SM-2's starting ease factor, matched by the column default. */
export const INITIAL_EASE_FACTOR = 2.5;

const DAY_MS = 86_400_000;

/** Coerce to a finite number, falling back when the input is not one. */
function finiteOr(value: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Ease factors are compared and asserted on, so keep them off float noise. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The lookup key a topic is stored under.
 *
 * Keys are compared, labels are displayed, so the key has to survive sloppy
 * input (" Event Loop " and "event loop" are one topic) while Chinese stays
 * readable — lowercasing does not touch CJK. A blank tag is not an error: a
 * check-in with no error tags still has to produce a topic to study, and
 * "nothing in particular" is what `基础概念` means.
 */
export function normalizeTopicKey(raw: string): string {
  const collapsed = String(raw ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  return collapsed.length > 0 ? collapsed : DEFAULT_TOPIC_KEY;
}

export type MasteryScheduleInput = {
  /** How many times this topic was reviewed *before* this answer. */
  attempts: number;
  /** The interval currently stored, i.e. the gap that just elapsed. */
  intervalDays: number;
  easeFactor: number;
  correct: boolean;
  now: Date;
};

export type MasterySchedule = {
  intervalDays: number;
  easeFactor: number;
  dueAt: Date;
};

/**
 * The next review date, SM-2 style.
 *
 * A wrong answer always collapses the gap to one day and makes the topic
 * harder (lower ease) — the point of the ladder is that a forgotten topic is
 * cheap to ask again. A correct answer walks 1 -> 3 -> round(3 * ease) -> …
 *
 * The input is clamped rather than rejected: a mastery row can be corrupted by
 * a bad migration or a zeroed timestamp, and losing the user's answer because
 * of that would be worse than scheduling a slightly conservative review.
 */
export function nextSchedule(input: MasteryScheduleInput): MasterySchedule {
  const previousAttempts = Math.max(
    0,
    Math.floor(finiteOr(input.attempts, 0)),
  );
  const previousInterval = clamp(
    Math.floor(finiteOr(input.intervalDays, 0)),
    0,
    MAX_INTERVAL_DAYS,
  );
  const previousEase = clamp(
    finiteOr(input.easeFactor, INITIAL_EASE_FACTOR),
    MIN_EASE_FACTOR,
    MAX_EASE_FACTOR,
  );

  if (!input.correct) {
    return {
      intervalDays: 1,
      easeFactor: round2(Math.max(MIN_EASE_FACTOR, previousEase - 0.2)),
      dueAt: dateAfter(input.now, 1),
    };
  }

  const grown =
    previousAttempts <= 0
      ? 1
      : previousInterval <= 1
        ? 3
        : Math.round(previousInterval * previousEase);
  const intervalDays = clamp(
    finiteOr(grown, 1),
    1,
    MAX_INTERVAL_DAYS,
  );

  return {
    intervalDays,
    easeFactor: round2(Math.min(MAX_EASE_FACTOR, previousEase + 0.1)),
    dueAt: dateAfter(input.now, intervalDays),
  };
}

/**
 * `now` plus N days.
 *
 * An unparseable clock is replaced with the epoch instead of propagating NaN:
 * the row still records that the answer was given, and the next review lands
 * long overdue (which is the safe failure — it gets asked again).
 */
function dateAfter(now: Date, days: number): Date {
  const base = now instanceof Date && Number.isFinite(now.getTime())
    ? now.getTime()
    : 0;
  return new Date(base + days * DAY_MS);
}

/**
 * `(correct + 1) / (attempts + 2)` — Laplace smoothing, not `correct / attempts`.
 *
 * A raw ratio reports 100% mastery after a single right answer, and 0/0 after
 * none. The prior is what makes "1 of 1" read as 67% and keeps an unseen topic
 * at 50% instead of dividing by zero.
 */
export function masteryFrom(attempts: number, correct: number): number {
  const total = Math.max(0, Math.floor(finiteOr(attempts, 0)));
  const hits = clamp(Math.floor(finiteOr(correct, 0)), 0, total);
  const value = (hits + 1) / (total + 2);
  return Math.round(value * 10_000) / 10_000;
}
