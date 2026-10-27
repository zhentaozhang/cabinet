/**
 * 人判记录 → 页面 DTO 的翻译。
 *
 * 这条翻译的关键不是字段对齐，而是"读不懂时不许猜"：审计行的 after 是
 * JSONB，可以被迁移、被手工修数据、被旧版本写成别的形状。把它默认成
 * "已通过"会在页面上凭空造出一个谁也没下过的结论——那正是本仓库反复
 * 处理的同一类问题（没有证据就写"未判定"）。
 */
import { describe, expect, it } from "vitest";
import type { auditEvents } from "@/lib/db/schema";
import { toOverrideRecord } from "@/server/mappers";

type AuditRow = typeof auditEvents.$inferSelect;

function event(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: "aud_override",
    seq: 7,
    userId: "usr_demo",
    actor: "user",
    action: "audit.override",
    target: "tsk_read",
    before: { status: "needs_review" },
    after: {
      status: "accepted",
      reason: "三条要点都对得上会议记录。",
      artifactId: "art_1",
    },
    hash: "0".repeat(64),
    prevHash: null,
    createdAt: new Date("2026-10-27T09:30:00.000Z"),
    ...overrides,
  };
}

describe("人判记录映射", () => {
  it("通过：判定、理由、被判产物与时间都在", () => {
    expect(toOverrideRecord(event())).toEqual({
      decision: "accepted",
      reason: "三条要点都对得上会议记录。",
      artifactId: "art_1",
      decidedAt: "2026-10-27T09:30:00.000Z",
    });
  });

  it("驳回也是同一种记录", () => {
    expect(
      toOverrideRecord(
        event({
          after: { status: "rejected", reason: "没有来源。", artifactId: null },
        }),
      ),
    ).toMatchObject({ decision: "rejected", artifactId: null });
  });

  it("没有产物时是 null，不是空字符串", () => {
    expect(
      toOverrideRecord(
        event({ after: { status: "accepted", reason: "看过产物。", artifactId: null } }),
      )?.artifactId,
    ).toBeNull();
  });

  it("读不懂的审计行不猜结论", () => {
    expect(toOverrideRecord(null)).toBeNull();
    expect(toOverrideRecord(event({ after: null }))).toBeNull();
    // 状态被改坏、或者写的是别的审计动作：都不算一条人判。
    expect(toOverrideRecord(event({ after: { status: "auditing" } }))).toBeNull();
    expect(toOverrideRecord(event({ after: { status: 42 } }))).toBeNull();
  });

  it("理由是空的就留空，不替用户编一句", () => {
    expect(
      toOverrideRecord(event({ after: { status: "accepted", artifactId: "art_1" } }))
        ?.reason,
    ).toBe("");
  });
});
