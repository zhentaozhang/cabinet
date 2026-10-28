import { beforeEach, describe, expect, it } from "vitest";
import { eq, getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { mcpServers, runJobs, tasks, userActions } from "@/lib/db/schema";
import {
  EXPORT_OMITTED_TABLES,
  exportAccountNdjson,
} from "@/lib/account-export";
import { DEMO_USER_ID } from "@/lib/demo";
import { resetDb } from "../helpers/db";

type Dumped = {
  meta: { tables: string[]; omitted: string[] };
  rows: Map<string, unknown[]>;
};

async function dump(userId: string): Promise<Dumped> {
  const lines: Array<Record<string, unknown>> = [];
  for await (const line of exportAccountNdjson(userId)) {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  }
  const meta = lines.find((line) => line.kind === "meta");
  if (!meta) throw new Error("导出缺少 meta 行");
  return {
    meta: meta as unknown as Dumped["meta"],
    rows: new Map(
      lines
        .filter((line) => line.kind === "rows")
        .map((line) => [String(line.table), line.rows as unknown[]]),
    ),
  };
}

const camelCase = (table: string) =>
  table.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/**
 * 导出是"你的数据能带走"的唯一兑现方式，而它有一份隐式清单：谁被写进文件。
 * 这份清单以前靠人手维护，于是 mcp_servers、user_actions 这些表在
 * deleteAccount 里被删掉、在备份里却从来没出现过——用户在换工具的时候才会
 * 发现少了一部分。这里用 schema 当权威：每张带 user_id 的表都必须有个下落。
 */
describe("导出的表清单", () => {
  beforeEach(resetDb);

  it("带 user_id 的表要么在备份里，要么在排除清单里写明理由", async () => {
    const { meta } = await dump(DEMO_USER_ID);
    const exported = new Set(meta.tables);
    const omitted = new Set(EXPORT_OMITTED_TABLES.map((entry) => entry.table));

    const uncovered: string[] = [];
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const columns = getTableColumns(value as PgTable);
      if (!("userId" in columns)) continue;
      const table = getTableName(value as PgTable);
      if (exported.has(camelCase(table)) || omitted.has(table)) continue;
      uncovered.push(table);
    }

    expect(
      uncovered,
      `这些表会被删号一并删掉，却没有出现在备份里：${uncovered.join(", ")}。` +
        "要么在 account-export.ts 里加一张表，要么在 EXPORT_OMITTED_TABLES 里写明为什么不该带走。",
    ).toEqual([]);
  });

  it("用户自己配的外部工具、操作流水和作业队列都能带走", async () => {
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.userId, DEMO_USER_ID))
      .limit(1);
    if (!task) throw new Error("种子数据里应当有任务");

    await db.insert(mcpServers).values({
      id: "mcp_export_probe",
      userId: DEMO_USER_ID,
      name: "notes",
      url: "http://127.0.0.1:9/mcp",
      resource: "mcp:notes",
      scope: "read",
    });
    await db.insert(userActions).values({
      id: "uac_export_probe",
      userId: DEMO_USER_ID,
      action: "task.create",
      durationMs: 42_000,
    });
    await db.insert(runJobs).values({
      id: "rjb_export_probe",
      userId: DEMO_USER_ID,
      taskId: task.id,
      status: "succeeded",
      attempts: 1,
    });

    const { rows } = await dump(DEMO_USER_ID);

    // 三张表在修复前一张都不在导出里：能删不能带走。
    const has = (table: string, id: string) =>
      (rows.get(table) ?? []).some((row) => (row as { id: string }).id === id);

    expect(has("mcpServers", "mcp_export_probe")).toBe(true);
    expect(has("userActions", "uac_export_probe")).toBe(true);
    expect(has("runJobs", "rjb_export_probe")).toBe(true);

    // 排除清单里的表不进备份：备份文件会被转发，token 不能在里面。
    expect(rows.has("sessions")).toBe(false);
    expect(rows.has("accounts")).toBe(false);
  });
});
