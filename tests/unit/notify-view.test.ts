import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NOTIFIED_KINDS, NOTIFY_EMPTY_HINT, notifyScopeLine } from "@/lib/presentation/notify-view";

function enqueuedKinds(): string[] {
  const files = [
    "src/server/services/commands/tasks/audit.ts",
    "src/server/services/commands/tasks/approvals.ts",
    "src/server/services/commands/tasks/run.ts",
    "src/server/services/commands/memory/facts.ts",
  ];
  const kinds = new Set<string>();
  for (const file of files) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    for (const match of source.matchAll(/kind: "([a-z]+)"/g)) {
      kinds.add(match[1]);
    }
  }
  return [...kinds].sort();
}

describe("the notification scope line lists what actually gets sent", () => {
  it("names every kind the commands enqueue", () => {
    // 漏掉 review 时，一个停在 needs_review 的任务永远不会自己提醒你——
    // 它是唯一一类「没有结论」的通知，也是最容易被文案漏掉的一类。
    expect([...NOTIFIED_KINDS].sort()).toEqual(enqueuedKinds());
  });

  it("reads the names from the label table instead of spelling them again", () => {
    const line = notifyScopeLine();
    expect(line).toContain("验收未通过");
    expect(line).toContain("等待你批准");
    expect(line).toContain("预算拦截");
    expect(line).toContain("待你判定");
    expect(line).toContain("记忆冲突");
    expect(line).toContain("正常的一天不会收到邮件");
    // council 有词条，但没有任何 enqueue 调用点会写它：清单不能替未来多承诺。
    expect(line).not.toContain("内阁会议");
  });

  it("describes the empty inbox with all the things that did not happen", () => {
    expect(NOTIFY_EMPTY_HINT).toContain("待你判定");
    expect(NOTIFY_EMPTY_HINT).toContain("记忆冲突");
  });
});

describe("both notification surfaces read the shared copy", () => {
  const actions = readFileSync(
    join(process.cwd(), "src/components/actions/notify-actions.tsx"),
    "utf8",
  );
  const page = readFileSync(
    join(process.cwd(), "src/app/settings/notifications/page.tsx"),
    "utf8",
  );

  it("replaces the four-name list with the shared line", () => {
    expect(actions).toContain("{notifyScopeLine()}");
    expect(actions).not.toContain("验收未通过、等你批准、预算拦截、记忆冲突");
  });

  it("uses the empty-state hint that names the fifth kind", () => {
    expect(page).toContain("hint={NOTIFY_EMPTY_HINT}");
    expect(page).not.toContain("任务通过验收、预算正常、没有冲突的日子");
  });
});
