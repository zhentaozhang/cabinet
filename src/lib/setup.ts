import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentGrants,
  agentTemplates,
  agents,
  goals,
  profiles,
  skills,
  users,
} from "@/lib/db/schema";
import {
  AGENT_TEMPLATES,
  APPRENTICE_SKILL,
  ROLE_GRANTS,
} from "@/contracts/templates";
import { syncPolicyConfig } from "@/lib/policy/sync";
import { newId } from "@/lib/ids";
import { logAuditTx } from "@/lib/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/domain/errors";

export type SetupInput = {
  userId: string;
  timezone: string;
  name?: string;
  goal?: {
    title: string;
    why: string;
    target: string;
    horizon: string;
    domain: string;
  };
};

export async function setupWorkspace(input: SetupInput) {
  const [user] = await db.select().from(users).where(eq(users.id, input.userId));
  if (!user) throw new NotFoundError("User not found");

  const [existingAgent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.userId, input.userId))
    .limit(1);
  if (existingAgent) {
    throw new ConflictError("Workspace already exists.");
  }

  const [existingProfile] = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.userId, input.userId))
    .limit(1);

  const timezone = input.timezone.trim() || user.timezone;

  const result = await db.transaction(async (tx) => {
    // Serialise concurrent setup calls for the same user. The pre-check above
    // is only a fast path: two tabs can pass it simultaneously. The
    // transaction-scoped lock makes the re-check below authoritative, without
    // adding a schema constraint.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${input.userId}))`,
    );

    const [createdAgent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.userId, input.userId))
      .limit(1);
    if (createdAgent) {
      throw new ConflictError("Workspace already exists.");
    }

    await tx
      .update(users)
      .set({
        name: input.name?.trim() || user.name,
        timezone,
        updatedAt: new Date(),
      })
      .where(eq(users.id, input.userId));

    // Do not invent personal facts during setup. Users can add constraints,
    // preferences and energy patterns later; empty objects mean "not set".
    const profileValues = {
      constraints: {},
      preferences: {},
      energyPattern: {},
      managementBudgetMin: 0,
      updatedAt: new Date(),
    };
    if (existingProfile) {
      await tx
        .update(profiles)
        .set(profileValues)
        .where(eq(profiles.userId, input.userId));
    } else {
      await tx.insert(profiles).values({
        userId: input.userId,
        ...profileValues,
      });
    }

    // Same routine the maintenance command runs, so a fresh workspace and an
    // existing one converge on exactly the same policy shape.
    await syncPolicyConfig(tx);

    const existingTemplates = await tx
      .select({ role: agentTemplates.role })
      .from(agentTemplates);
    const templateRoles = new Set(existingTemplates.map((row) => row.role));
    for (const template of AGENT_TEMPLATES) {
      if (!templateRoles.has(template.role)) {
        await tx.insert(agentTemplates).values(template);
      }
    }

    const created: Array<{ id: string; role: string }> = [];

    for (const template of AGENT_TEMPLATES) {
      const id = newId("ag");
      created.push({ id, role: template.role });
      await tx.insert(agents).values({
        id,
        userId: input.userId,
        role: template.role,
        name: template.name,
        title: template.title,
        avatar: template.name.slice(0, 2).toUpperCase(),
        charter: template.charter,
        objective: template.objective,
        model: "auto",
        status: "active",
        autonomyLevel: template.defaultAutonomy,
        trustScore: 50,
        lifecycleStage:
          template.role === "apprentice" ? "shadowing" : "active",
        tools: template.tools,
        memoryScope: template.memoryScope,
        budgetCents: template.budgetCents,
        // `spentCents` / `budgetPeriodStart` are frozen legacy columns; weekly
        // accounting lives in `agent_budget_periods`.
      });

      for (const grant of ROLE_GRANTS[template.role] ?? []) {
        await tx.insert(agentGrants).values({
          id: newId("grt"),
          agentId: id,
          resource: grant.resource,
          scope: grant.scope,
          config: {},
        });
      }
    }

    const coach = created.find((agent) => agent.role === "coach");
    const apprentice = created.find((agent) => agent.role === "apprentice");
    if (coach && apprentice) {
      await tx
        .update(agents)
        .set({ mentorId: coach.id })
        .where(eq(agents.id, apprentice.id));
      await tx.insert(skills).values({
        id: newId("sk"),
        agentId: apprentice.id,
        name: APPRENTICE_SKILL.name,
        version: 1,
        steps: [...APPRENTICE_SKILL.steps],
        tools: [...APPRENTICE_SKILL.tools],
        status: "draft",
        label: "draft",
        evalSet: APPRENTICE_SKILL.evalSet.map((item) => ({ ...item })),
        successCount: 0,
        failCount: 0,
        eval: {
          status: "not_started",
          required: APPRENTICE_SKILL.evalSet.length,
          passed: 0,
        },
      });
    }

    let goalId: string | null = null;
    if (input.goal) {
      if (!input.goal.title.trim() || !input.goal.target.trim()) {
        throw new ValidationError("Goal title and target are required.");
      }
      goalId = newId("goal");
      await tx.insert(goals).values({
        id: goalId,
        userId: input.userId,
        domain: input.goal.domain || "learning",
        title: input.goal.title.trim(),
        why: input.goal.why.trim(),
        target: input.goal.target.trim(),
        horizon: input.goal.horizon || "6 weeks",
        status: "active",
        progress: 0,
      });
    }

    await logAuditTx(tx, {
      userId: input.userId,
      actor: "user",
      action: "workspace.setup",
      target: input.userId,
      before: null,
      after: { agents: created.length, goalId, timezone },
    });

    return { agentCount: created.length, goalId };
  });

  return result;
}
