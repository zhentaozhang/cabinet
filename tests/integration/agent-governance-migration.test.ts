import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyMigrationsFrom,
  applyMigrationsUpTo,
  createScratchDatabase,
} from "../helpers/migrations";

/**
 * Upgrade test: `0018_agent_budget` must land on a populated `0017` database
 * without touching existing Agents/runs and without inventing any usage.
 */
describe("agent governance migrations", () => {
  const scratchDatabases: Array<() => Promise<void>> = [];

  afterAll(async () => {
    await Promise.all(scratchDatabases.map((drop) => drop()));
  });

  async function scratch() {
    const database = await createScratchDatabase();
    scratchDatabases.push(database.drop);
    const client = postgres(database.url, { max: 1, prepare: false });
    return client;
  }

  it("applies 0018 over a populated 0017 database without inventing usage", async () => {
    const client = await scratch();
    try {
      await applyMigrationsUpTo(client, "0017_provider_attempt");

      await client.unsafe(`
        insert into users (id, email, name, timezone)
        values ('usr_mig', 'mig@example.com', 'Mig', 'Asia/Shanghai')
      `);
      await client.unsafe(`
        insert into agents (
          id, user_id, role, name, title, avatar, charter, objective,
          tools, memory_scope, budget_cents, spent_cents, budget_period_start
        ) values (
          'ag_mig', 'usr_mig', 'researcher', '迁移', 'Researcher', 'MG',
          'charter', 'objective', '[]'::jsonb, '[]'::jsonb, 800, 210, now()
        )
      `);
      await client.unsafe(`
        insert into tasks (id, user_id, title, description, acceptance_criteria)
        values ('tsk_mig', 'usr_mig', '标题', '描述', '验收')
      `);
      await client.unsafe(`
        insert into runs (
          id, task_id, agent_id, status, mode, source_type,
          cost_cents, tokens_in, tokens_out
        ) values ('run_mig', 'tsk_mig', 'ag_mig', 'succeeded', 'live',
          'model_generated', 2.1, 100, 50)
      `);

      await applyMigrationsFrom(
        client,
        "0017_provider_attempt",
        "0018_agent_budget",
      );

      const agents = await client.unsafe(
        "select id, spent_cents from agents where id = 'ag_mig'",
      );
      expect(agents).toHaveLength(1);
      expect(Number(agents[0].spent_cents)).toBe(210);

      const runs = await client.unsafe(
        "select id, cost_cents, tokens_in, tokens_out from runs where id = 'run_mig'",
      );
      expect(runs).toHaveLength(1);
      expect(Number(runs[0].cost_cents)).toBe(2.1);
      expect(runs[0].tokens_in).toBe(100);
      expect(runs[0].tokens_out).toBe(50);

      const periods = await client.unsafe(
        "select count(*)::int as total from agent_budget_periods",
      );
      expect(periods[0].total).toBe(0);

      const reservations = await client.unsafe(
        "select count(*)::int as total from agent_budget_reservations",
      );
      expect(reservations[0].total).toBe(0);
    } finally {
      await client.end();
    }
  });

  it("enforces one reservation per run while allowing pre-run holds", async () => {
    const client = await scratch();
    try {
      await applyMigrationsUpTo(client, "0018_agent_budget");
      await client.unsafe(`
        insert into users (id, email, name) values ('usr_idx', 'idx@example.com', 'Idx')
      `);
      await client.unsafe(`
        insert into agents (
          id, user_id, role, name, title, avatar, charter, objective,
          tools, memory_scope
        ) values ('ag_idx', 'usr_idx', 'coach', '索引', 'Coach', 'IX',
          'charter', 'objective', '[]'::jsonb, '[]'::jsonb)
      `);
      await client.unsafe(`
        insert into agent_budget_periods (
          id, user_id, agent_id, timezone, period_start, period_end, limit_cents
        ) values ('bpd_idx', 'usr_idx', 'ag_idx', 'Asia/Shanghai',
          '2026-10-19T00:00:00Z', '2026-10-26T00:00:00Z', 1200)
      `);

      await client.unsafe(`
        insert into tasks (id, user_id, title, description, acceptance_criteria)
        values ('tsk_idx', 'usr_idx', '标题', '描述', '验收')
      `);
      await client.unsafe(`
        insert into runs (id, task_id, agent_id, status, mode, source_type)
        values ('run_idx', 'tsk_idx', 'ag_idx', 'running', 'live', 'system_event')
      `);

      // Pre-run holds may coexist because run_id is null.
      await client.unsafe(`
        insert into agent_budget_reservations
          (id, user_id, period_id, agent_id, state, amount_cents)
        values
          ('brs_a', 'usr_idx', 'bpd_idx', 'ag_idx', 'reserved', 50),
          ('brs_b', 'usr_idx', 'bpd_idx', 'ag_idx', 'reserved', 50)
      `);

      await client.unsafe(`
        insert into agent_budget_reservations
          (id, user_id, period_id, agent_id, run_id, state, amount_cents)
        values ('brs_c', 'usr_idx', 'bpd_idx', 'ag_idx', 'run_idx', 'reserved', 50)
      `);

      await expect(
        client.unsafe(`
          insert into agent_budget_reservations
            (id, user_id, period_id, agent_id, run_id, state, amount_cents)
          values ('brs_d', 'usr_idx', 'bpd_idx', 'ag_idx', 'run_idx', 'reserved', 50)
        `),
      ).rejects.toThrow(/agent_budget_reservations_run_key|duplicate key/);

      await expect(
        client.unsafe(`
          insert into agent_budget_reservations
            (id, user_id, period_id, agent_id, state, amount_cents)
          values ('brs_e', 'usr_idx', 'bpd_idx', 'ag_idx', 'bogus', 50)
        `),
      ).rejects.toThrow(/agent_budget_reservations_state_check/);
    } finally {
      await client.end();
    }
  });
});
