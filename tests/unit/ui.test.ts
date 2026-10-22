import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar, Badge, Button, Progress, Stat } from "@/components/ui";
import { cn } from "@/lib/format";

/**
 * Render-level coverage for the shared primitives. No DOM, no new dependency:
 * these are the a11y and class-merge contracts every page relies on.
 */
describe("cn", () => {
  it("lets the caller override a conflicting utility", () => {
    expect(cn("px-3.5", "px-9")).toBe("px-9");
    expect(cn("text-micro text-muted", "text-caption")).toBe("text-muted text-caption");
  });

  it("does not confuse a project font size with a project text colour", () => {
    // Both live under the `text-` prefix; without the extended merge config one
    // of them would be silently dropped.
    expect(cn("text-micro text-muted")).toBe("text-micro text-muted");
    expect(cn("text-caption", "text-faint")).toBe("text-caption text-faint");
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
      createElement(Progress, { value: 62 }),
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="62"');
    expect(html).toContain('aria-valuemax="100"');
  });

  it("clamps out-of-range input instead of emitting invalid aria", () => {
    const html = renderToStaticMarkup(
      createElement(Progress, { value: 180 }),
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
