import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  apprenticeObservations,
  artifacts,
  runs,
  skills,
  tasks,
} from "@/lib/db/schema";
import { APPRENTICE_SKILL } from "@/contracts/templates";
import { isEligibleTrainingObservation } from "@/lib/domain/provenance";
import { NotFoundError, ValidationError } from "@/lib/domain/errors";

const TRAINING_TASK_STATUSES = ["accepted", "done"] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ObservationCandidate = {
  runId: string;
  taskId: string;
  taskTitle: string;
  artifactId: string | null;
  endedAt: Date | null;
};

export type ApprenticeshipEvidence = {
  apprenticeId: string;
  mentorId: string;
  skillId: string;
  skillVersion: number;
  required: number;
  observed: number;
  /** Eligible mentor runs the user has not recorded yet. */
  candidates: ObservationCandidate[];
};

export async function loadApprentice(userId: string, tx: Tx) {
  const [apprentice] = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.role, "apprentice")))
    .limit(1);
  if (!apprentice) {
    throw new NotFoundError("Apprentice not found");
  }
  return apprentice;
}

/**
 * The apprentice's configured mentor, falling back to the workspace coach.
 * Mentorship is ownership-scoped, so a stale `mentorId` never points outside the
 * tenant.
 */
export async function resolveMentor(
  userId: string,
  mentorId: string | null,
  tx: Tx,
) {
  if (mentorId) {
    const [mentor] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, mentorId), eq(agents.userId, userId)))
      .limit(1);
    if (mentor) return mentor;
  }
  const [coach] = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.role, "coach")))
    .limit(1);
  if (!coach) {
    throw new ValidationError("Workspace has no coach to mentor the apprentice.");
  }
  return coach;
}

/** The latest skill row, or null when the apprentice has none yet (read-only). */
export async function readLatestSkill(tx: Tx, apprenticeId: string) {
  const [skill] = await tx
    .select()
    .from(skills)
    .where(eq(skills.agentId, apprenticeId))
    .orderBy(desc(skills.createdAt))
    .limit(1);
  return skill ?? null;
}

/**
 * Runs the mentor actually executed that may be recorded as training evidence.
 * The SQL narrows the candidates; `isEligibleTrainingObservation` is the single
 * predicate that decides, so the list and the command cannot drift apart.
 */
export async function eligibleMentorRuns(
  userId: string,
  mentorId: string,
  tx: Tx,
  runId?: string,
) {
  const rows = await tx
    .select({
      runId: runs.id,
      taskId: tasks.id,
      taskTitle: tasks.title,
      artifactId: artifacts.id,
      endedAt: runs.endedAt,
      runStatus: runs.status,
      mode: runs.mode,
      providerAttemptId: runs.providerAttemptId,
      taskStatus: tasks.status,
      artifactSource: artifacts.sourceType,
      artifactSubmittedBy: artifacts.submittedBy,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(artifacts, eq(artifacts.runId, runs.id))
    .where(
      and(
        eq(tasks.userId, userId),
        eq(runs.agentId, mentorId),
        runId ? eq(runs.id, runId) : undefined,
        eq(runs.status, "succeeded"),
        eq(runs.mode, "live"),
        isNotNull(runs.providerAttemptId),
        inArray(tasks.status, [...TRAINING_TASK_STATUSES]),
        eq(artifacts.submittedBy, "agent"),
        eq(artifacts.sourceType, "model_generated"),
      ),
    )
    .orderBy(desc(runs.endedAt));

  return rows.filter((row) =>
    isEligibleTrainingObservation({
      artifactSourceType: row.artifactSource,
      artifactSubmittedBy: row.artifactSubmittedBy,
      executionChannel: row.mode,
      hasProviderAttempt: row.providerAttemptId !== null,
      runStatus: row.runStatus,
      taskStatus: row.taskStatus,
    }),
  );
}

export async function loadObservations(
  apprenticeId: string,
  skillId: string,
  skillVersion: number,
  tx: Tx,
) {
  return tx
    .select()
    .from(apprenticeObservations)
    .where(
      and(
        eq(apprenticeObservations.apprenticeId, apprenticeId),
        eq(apprenticeObservations.skillId, skillId),
        eq(apprenticeObservations.skillVersion, skillVersion),
        eq(apprenticeObservations.qualification, "qualified"),
      ),
    )
    .orderBy(desc(apprenticeObservations.attestedAt));
}

/**
 * Everything the apprentice detail surface needs: how many observations the
 * current skill version has, and which mentor runs are still recordable. A page
 * render never provisions the skill row.
 */
export async function loadApprenticeshipEvidence(
  userId: string,
): Promise<ApprenticeshipEvidence> {
  return db.transaction(async (tx) => {
    const apprentice = await loadApprentice(userId, tx);
    const mentor = await resolveMentor(userId, apprentice.mentorId, tx);
    const skill = await readLatestSkill(tx, apprentice.id);
    const observations = skill
      ? await loadObservations(apprentice.id, skill.id, skill.version, tx)
      : [];
    const observedRuns = new Set(observations.map((row) => row.runId));
    const candidates = (await eligibleMentorRuns(userId, mentor.id, tx))
      .filter((row) => !observedRuns.has(row.runId))
      .slice(0, 10)
      .map((row) => ({
        runId: row.runId,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        artifactId: row.artifactId,
        endedAt: row.endedAt,
      }));

    return {
      apprenticeId: apprentice.id,
      mentorId: mentor.id,
      skillId: skill?.id ?? "",
      skillVersion: skill?.version ?? 1,
      required: APPRENTICE_SKILL.minShadowRuns,
      observed: observations.length,
      candidates,
    };
  });
}
