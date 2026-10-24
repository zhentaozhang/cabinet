/**
 * End-to-end probe of the real execution chain.
 *
 * Not a test — a probe. It prints what each layer actually reported, because
 * the failure mode this product cares about is a layer quietly claiming
 * success. Run it against a built server:
 *
 *   next build && next start -p 3970
 *   pnpm e2e:probe                         # E2E_BASE overrides the origin
 *
 * Exit code 1 means a layer contradicted itself (see the checks at the end),
 * not that a task was rejected — rejection is the healthy outcome when
 * retrieval is unavailable.
 */
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3970";

let cookie = "";

/* A probe reads raw wire JSON; precise DTO types would only restate the
 * contract it is trying to check. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function call(
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<{ status: number; json: Json | null }> {
  const res = await fetch(BASE + path, {
    method: init.method ?? "GET",
    body: init.body,
    headers: {
      "content-type": "application/json",
      // better-auth rejects a POST without Origin (`MISSING_OR_NULL_ORIGIN`),
      // so a scripted client must send the same thing a browser would.
      origin: BASE,
      ...(cookie ? { cookie } : {}),
    },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) as Json };
  } catch {
    return { status: res.status, json: null };
  }
}

function line(label: string, value: unknown): void {
  console.log(`${label.padEnd(26)} ${String(value)}`);
}

function short(value: unknown, max = 130): string {
  return JSON.stringify(value).slice(0, max);
}

async function main(): Promise<void> {
  const failures: string[] = [];

  const signIn = await call("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({
      email: "demo@cabinet.local",
      password: "cabinet-demo",
    }),
  });
  line("sign-in", signIn.status);
  if (signIn.status !== 200) {
    console.error("Cannot sign in; is the demo account seeded?");
    process.exit(1);
  }

  const created = await call("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "E2E 检索一次真实的 RAG 综述",
      description: "找一篇 RAG 综述，给出一句可直接引用的结论。",
      assigneeId: "ag_research",
      auditorId: "ag_auditor",
      actionType: "internal",
      acceptanceCriteria: "结论必须带来源 URL",
      estimateMin: 20,
    }),
  });
  const taskId: string | undefined = created.json?.data?.task?.id;
  line("create task", `${created.status} ${taskId ?? short(created.json)}`);
  if (!taskId) process.exit(1);

  const run = await call(`/api/tasks/${taskId}/run`, {
    method: "POST",
    body: "{}",
  });
  line("run", `${run.status} ${short(run.json)}`);

  const detail = await call(`/api/tasks/${taskId}`);
  const data: Json = detail.json?.data ?? {};
  const runs: Json[] = data.runs ?? [];
  const steps: Json[] = data.steps ?? [];

  line("runs recorded", runs.length);
  for (const entry of runs) {
    line("  run", `${entry.status} · ${entry.mode ?? "-"} · ${entry.costSource ?? "-"}`);
  }
  for (const step of steps.filter((s) => s.type === "tool")) {
    const output = step.output ?? {};
    line(`  ${step.tool}`, `${output.status ?? "-"} · ${short(output.reason ?? output, 90)}`);
  }
  line("evidence rows", (data.evidence ?? []).length);

  const evidence = (data.evidence ?? []).length;
  const toolSteps = steps.filter((s) => s.type === "tool");
  if (evidence === 0 && toolSteps.length > 0) {
    const honest = toolSteps.every((s) => {
      const status = s.output?.status ?? "ok";
      return status !== "ok";
    });
    if (!honest) {
      failures.push("零证据，但工具步骤报告 ok —— 有一层在谎报成功");
    }
  }

  const audited = await call(`/api/tasks/${taskId}/audit`, {
    method: "POST",
    body: "{}",
  });
  const verdict: Json = audited.json?.data ?? {};
  line("audit decision", verdict.decision ?? short(audited.json));
  if (verdict.decision === "accepted" && evidence === 0) {
    failures.push("零证据却被验收通过");
  }

  const after = await call(`/api/tasks/${taskId}`);
  const report: Json[] = after.json?.data?.task?.acceptanceReport ?? [];
  line("acceptance items", report.length);
  for (const row of report) {
    line(
      `  ${row.item?.type}`,
      `${row.passed ? "通过" : row.undetermined ? "需人工复核" : "未通过"} · ${row.reason ?? ""}`,
    );
  }

  const chain = await call("/api/audit/verify");
  const chainData: Json = chain.json?.data ?? chain.json ?? {};
  line("audit chain", `${chainData.verified ? "完整" : "不一致"} · ${chainData.checked} 条`);
  if (chainData.verified !== true) failures.push("审计链校验未通过");

  console.log();
  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exit(1);
  }
  console.log("✓ 每一层的结论与它实际做过的事一致");
}

void main();
