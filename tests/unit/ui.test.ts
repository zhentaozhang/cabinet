import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Avatar,
  Badge,
  Button,
  CapabilityBadge,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Progress,
  Stat,
  SectionTitle,
  StatusBadge,
} from "@/components/ui";
import { capabilityTone, statusNextAction } from "@/contracts/labels";
import { cn } from "@/lib/format";

/**
 * Render-level coverage for the shared primitives. No DOM, no new dependency:
 * these are the a11y and class-merge contracts every page relies on.
 */
describe("cn", () => {
  it("lets the caller override a conflicting utility", () => {
    expect(cn("px-3.5", "px-9")).toBe("px-9");
    expect(cn("text-label text-muted", "text-body")).toBe("text-muted text-body");
  });

  it("does not confuse a project font size with a project text colour", () => {
    // Both live under the `text-` prefix; without the extended merge config one
    // of them would be silently dropped.
    expect(cn("text-label text-muted")).toBe("text-label text-muted");
    expect(cn("text-eyebrow", "text-faint")).toBe("text-eyebrow text-faint");
  });

  it("still resolves genuine background and border conflicts", () => {
    expect(cn("bg-panel/80", "bg-panel2")).toBe("bg-panel2");
    expect(cn("border-line", "border-accent")).toBe("border-accent");
  });

  it("drops false branches and keeps unrelated utilities", () => {
    expect(cn("flex", false, undefined, "gap-2")).toBe("flex gap-2");
  });
});

describe("Button", () => {
  it("defaults to type=button so a button inside a form cannot submit it", () => {
    const html = renderToStaticMarkup(
      createElement(Button, {}, "运行"),
    );
    expect(html).toContain('type="button"');
  });

  it("keeps an explicit type when the caller submits a form", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { type: "submit" }, "保存"),
    );
    expect(html).toContain('type="submit"');
  });

  it("merges caller classes over the variant", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { className: "px-9" }, "跑"),
    );
    expect(html).toContain("px-9");
    expect(html).not.toContain("px-3.5");
  });
});

describe("Progress", () => {
  it("exposes the value to assistive tech", () => {
    const html = renderToStaticMarkup(
      createElement(Progress, { value: 62, label: "目标进度" }),
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="62"');
    expect(html).toContain('aria-valuemax="100"');
  });

  it("carries a name, because a bare percentage is meaningless", () => {
    // The page renders several bars at once; "40%" alone tells a screen-reader
    // user nothing about which of them they are on.
    const html = renderToStaticMarkup(
      createElement(Progress, { value: 40, label: "本周模型用量占预算比例" }),
    );
    expect(html).toContain('aria-label="本周模型用量占预算比例"');
    expect(html).not.toContain("aria-labelledby");
  });

  it("can borrow the name of a visible heading instead", () => {
    const html = renderToStaticMarkup(
      createElement(Progress, { value: 40, labelledBy: "goal-progress-g1" }),
    );
    expect(html).toContain('aria-labelledby="goal-progress-g1"');
    expect(html).not.toContain("aria-label=");
  });

  it("clamps out-of-range input instead of emitting invalid aria", () => {
    const html = renderToStaticMarkup(
      createElement(Progress, { value: 180, label: "进度" }),
    );
    expect(html).toContain('aria-valuenow="100"');
  });
});

describe("Badge / Avatar / Stat", () => {
  it("renders badge copy", () => {
    const html = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop
      createElement(Badge, { tone: "teal", children: "已通过" }),
    );
    expect(html).toContain("已通过");
  });

  it("renders avatar initials", () => {
    const html = renderToStaticMarkup(
      createElement(Avatar, { initials: "AT", accent: "#e0a83e" }),
    );
    expect(html).toContain("AT");
  });

  it("renders a stat with its hint", () => {
    const html = renderToStaticMarkup(
      createElement(Stat, { label: "信任分", value: "72", hint: "近 30 天" }),
    );
    expect(html).toContain("信任分");
    expect(html).toContain("72");
    expect(html).toContain("近 30 天");
  });
});

/**
 * The state primitives added for the P1 pass. The contract under test is the
 * one the whole redesign leans on: a state is never colour alone — every badge
 * carries an icon and a word, so it survives greyscale and a screen reader.
 */
describe("StatusBadge", () => {
  it("renders both the label and an icon for a known status", () => {
    const html = renderToStaticMarkup(
      createElement(StatusBadge, { status: "submitted" }),
    );
    expect(html).toContain("待验收");
    expect(html).toContain("<svg");
  });

  it("still renders an icon when the status is unknown to the label map", () => {
    const html = renderToStaticMarkup(
      createElement(StatusBadge, { status: "something_new" }),
    );
    expect(html).toContain("something_new");
    expect(html).toContain("<svg");
  });

  it("can drop the icon for dense rows without losing the word", () => {
    const html = renderToStaticMarkup(
      createElement(StatusBadge, { status: "accepted", showIcon: false }),
    );
    expect(html).toContain("已通过");
    expect(html).not.toContain("<svg");
  });
});

describe("CapabilityBadge", () => {
  it("says 未配置 in words rather than relying on colour", () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityBadge, { state: "not_configured" }),
    );
    expect(html).toContain("未配置");
    expect(html).toContain("<svg");
  });

  it("does not paint a missing connector as an error", () => {
    // Neutral, not danger: nothing broke, the deployment simply has no key.
    expect(capabilityTone("not_configured")).toBe("neutral");
    expect(capabilityTone("unavailable")).toBe("neutral");
    expect(capabilityTone("configured")).toBe("teal");
    expect(capabilityTone("simulated")).toBe("violet");
    expect(capabilityTone("degraded")).toBe("accent");
  });
});

describe("EmptyState", () => {
  it("keeps the original neutral markup for three-prop callers", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, { title: "还没有任务", hint: "从上面创建第一个" }),
    );
    expect(html).toContain("border-dashed border-line");
    expect(html).toContain("还没有任务");
    expect(html).toContain("从上面创建第一个");
    expect(html).not.toContain("text-danger");
  });

  it("marks a failure-shaped empty state with an icon, not just a colour", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, { title: "检索未连接", tone: "danger" }),
    );
    expect(html).toContain("border-danger/40");
    expect(html).toContain("<svg");
  });
});

describe("ErrorState", () => {
  it("announces itself and states what to do next", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorState, {
        title: "执行失败",
        description: "模型调用超时",
        hint: "你填写的内容已保留",
        retry: createElement("button", { type: "button" }, "重试"),
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("执行失败");
    expect(html).toContain("模型调用超时");
    expect(html).toContain("你填写的内容已保留");
    expect(html).toContain("重试");
  });
});

describe("LoadingBlock", () => {
  it("reserves space and tells assistive tech it is busy", () => {
    const html = renderToStaticMarkup(createElement(LoadingBlock, { rows: 2 }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("正在加载");
    expect((html.match(/animate-pulse/g) ?? []).length).toBe(2);
  });
});

describe("statusNextAction", () => {
  it("answers what the human should do, not just where the task is", () => {
    expect(statusNextAction("awaiting_approval")).toContain("批准");
    expect(statusNextAction("rejected")).toContain("重试");
    expect(statusNextAction("running")).toContain("等待");
  });

  it("returns null for states the page owns", () => {
    expect(statusNextAction("nonsense")).toBeNull();
  });
});

describe("SectionTitle keeps the document outline honest", () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(SectionTitle as never, props));

  it("renders an h2 by default", () => {
    const html = render({ title: "绩效与授权" });
    expect(html).toContain("<h2");
    expect(html).not.toContain("<h1");
  });

  it("can be the page's only top-level heading", () => {
    // The three settings screens have no other h1; rendering this as an h2
    // left the page with no top-level heading at all.
    const html = render({ title: "设置", as: "h1" });
    expect(html).toContain("<h1");
    expect(html).not.toContain("<h2");
  });

  it("sizes an h1 as a page title, not as a section", () => {
    expect(render({ title: "设置", as: "h1" })).toContain("text-page");
    expect(render({ title: "绩效与授权" })).toContain("text-section");
  });

  it("still renders the eyebrow, hint and right slot", () => {
    const html = render({
      eyebrow: "Agents",
      title: "绩效与授权",
      hint: "点开任一 Agent",
      right: "right-slot",
    });
    expect(html).toContain("Agents");
    expect(html).toContain("点开任一 Agent");
    expect(html).toContain("right-slot");
  });
});
