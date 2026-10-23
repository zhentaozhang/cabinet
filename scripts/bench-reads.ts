import { performance } from "node:perf_hooks";

import {
  loadAgent,
  loadAudit,
  loadCabinet,
  loadMemory,
  loadReview,
  loadShell,
  loadTask,
  loadToday,
} from "@/server/readmodels";

/**
 * Read-model latency probe.
 *
 * Measures the server side of each page load against the real database, so a
 * change can be judged by p50/p95 instead of by reading the query count. Run
 * against the dev database: `node node_modules/tsx/dist/cli.mjs scripts/bench-reads.ts`
 */

const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 20);
const userId = process.env.DEMO_USER_ID ?? "usr_zhen";

type Case = {
  name: string;
  run: () => Promise<unknown>;
};

const cases: Case[] = [
  { name: "today", run: () => loadToday(userId) },
  { name: "review", run: () => loadReview(userId) },
  { name: "cabinet", run: () => loadCabinet(userId) },
  { name: "memory", run: () => loadMemory(userId) },
  { name: "audit", run: () => loadAudit(userId, { limit: 40 }) },
  { name: "shell", run: () => loadShell(userId) },
  { name: "agent", run: () => loadAgent("ag_atlas", userId) },
  { name: "task", run: () => loadTask("tsk_research", userId) },
];

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    p50: at(0.5),
    p95: at(0.95),
    mean,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

async function main() {
  const rows: Array<{ name: string; p50: string; p95: string; mean: string }> = [];

  for (const testCase of cases) {
    // One warm-up call: the first query pays connection and statement-cache cost.
    await testCase.run();

    const samples: number[] = [];
    for (let index = 0; index < ITERATIONS; index += 1) {
      const started = performance.now();
      await testCase.run();
      samples.push(performance.now() - started);
    }

    const result = stats(samples);
    rows.push({
      name: testCase.name,
      p50: result.p50.toFixed(1),
      p95: result.p95.toFixed(1),
      mean: result.mean.toFixed(1),
    });
  }

  console.table(rows);
  const slowest = rows.reduce((worst, row) => (Number(row.p95) > Number(worst.p95) ? row : worst));
  console.log(`slowest p95: ${slowest.name} ${slowest.p95}ms (${ITERATIONS} iterations)`);
}

void main().then(() => process.exit(0));
