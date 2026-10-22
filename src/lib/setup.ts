import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentGrants,
  agentTemplates,
  agents,
  goals,
  policyConfig,
  profiles,
  users,
} from "@/lib/db/schema";
import { AGENT_TEMPLATES, ROLE_GRANTS } from "@/lib/templates";
import { SEED_POLICY_CONFIG } from "@/lib/domain/policy";
import { newId } from "@/lib/ids";
import { startOfLocalWeek } from "@/lib/domain/time";
import { logAudit } from "@/lib/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/domain/errors";

const POLICY_KEYS = [
  "autonomy",
  "audit",
  "budget",
  "management",
  "cost",
] as const;

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
  const weekStart = startOfLocalWeek(new Date(), timezone);

  const result = await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        name: input.name?.trim() || user.name,
        timezone,
        updatedAt: new Date(),
      })
      .where(eq(users.id, input.userId));

    const profileValues = {
      constraints: {
        weekdayMinutes: 90,
        monthlyLearningBudgetCents: 60000,
        noWorkAfter: "21:30",
      },
      preferences: {
        examplesBeforeTheory: true,
        shortTasks: true,
        language: "zh-CN",
        rules: [],
      },
      energyPattern: {
        peak: "09:00-11:30",
        dip: "14:00-15:00",
        low: "20:00-23:00",
      },
      managementBudgetMin: 3,
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

    const existingConfig = await tx
      .select({ key: policyConfig.key })
      .from(policyConfig);
    const configKeys = new Set(existingConfig.map((row) => row.key));
    for (const key of POLICY_KEYS) {
      if (!configKeys.has(key)) {
        await tx.insert(policyConfig).values({
          key,
          valueJson: SEED_POLICY_CONFIG[key],
          description: `Cabinet policy: ${key}`,
        });
      }
    }

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
        lifecycleStage: "active",
        tools: template.tools,
        memoryScope: template.memoryScope,
        budgetCents: template.budgetCents,
        spentCents: 0,
        budgetPeriodStart: weekStart,
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

    return { agentCount: created.length, goalId };
  });

  await logAudit({
    userId: input.userId,
    actor: "user",
    action: "workspace.setup",
    target: input.userId,
    before: null,
    after: {
      agents: result.agentCount,
      goalId: result.goalId,
      timezone,
    },
  });

  return result;
}
