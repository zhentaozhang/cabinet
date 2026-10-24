import { describe, expect, it } from "vitest";

import {
  DRAWER_ID,
  FOCUSABLE,
  NAV,
  isExactHref,
  matchesHref,
} from "@/components/shell/nav";

describe("the active nav item follows the route", () => {
  // Getting this wrong makes the wrong destination look current, which is
  // worse than showing none: the person thinks they are somewhere they are not.
  it("matches a nested route to its section", () => {
    expect(matchesHref("/cabinet/agt_atlas", "/cabinet")).toBe(true);
    expect(matchesHref("/review/audit", "/review")).toBe(true);
    expect(matchesHref("/settings/connectors", "/settings")).toBe(true);
    expect(matchesHref("/tasks/tsk_quiz", "/tasks")).toBe(true);
  });

  it("treats the root as exact, not as a prefix of everything", () => {
    // "/".startsWith would make Today look active on every page.
    expect(matchesHref("/", "/")).toBe(true);
    expect(matchesHref("/cabinet", "/")).toBe(false);
    expect(matchesHref("/review", "/")).toBe(false);
  });

  it("does not let a sibling section claim another's prefix", () => {
    expect(matchesHref("/reviews", "/review")).toBe(false);
    expect(matchesHref("/cabinet", "/cab")).toBe(false);
  });

  it("marks exactly one destination as current for each route", () => {
    for (const route of ["/", "/cabinet", "/review", "/memory", "/council", "/settings"]) {
      const active = NAV.filter((item) => matchesHref(route, item.href));
      expect(active, route).toHaveLength(1);
    }
  });

  it("marks no destination as current on an unknown route", () => {
    expect(NAV.filter((item) => matchesHref("/login", item.href))).toHaveLength(0);
  });
});

describe("navigation data", () => {
  it("lists every surface exactly once with a distinct href", () => {
    expect(NAV.length).toBeGreaterThan(0);
    expect(new Set(NAV.map((item) => item.href)).size).toBe(NAV.length);
  });

  it("gives each destination a visible label and a hint", () => {
    for (const item of NAV) {
      expect(item.label.trim(), item.href).not.toBe("");
      expect(item.hint.trim(), item.href).not.toBe("");
      expect(item.href.startsWith("/"), item.href).toBe(true);
    }
  });

  it("keeps the drawer id and focus selector usable", () => {
    expect(DRAWER_ID).toMatch(/^[a-z][a-z0-9-]*$/);
    // The trap and the initial focus both read this, so it must select the
    // controls a person can actually reach.
    expect(FOCUSABLE).toContain("button:not([disabled])");
    expect(FOCUSABLE).toContain("[href]");
    expect(FOCUSABLE).toContain('[tabindex]:not([tabindex="-1"])');
  });
});

describe("aria-current announces the page, not the section", () => {
  // The sidebar highlights the section a sub-page belongs to, but
  // aria-current="page" claims "you are on this page". On /settings/connectors
  // the /settings entry is the right thing to highlight and the wrong thing to
  // announce as current, so the two questions are answered separately.
  it("marks the section index as the current page only on the index itself", () => {
    expect(isExactHref("/settings", "/settings")).toBe(true);
    expect(isExactHref("/settings/connectors", "/settings")).toBe(false);
    expect(isExactHref("/", "/")).toBe(true);
  });

  it("keeps highlighting the owning section on a sub-page", () => {
    expect(matchesHref("/settings/connectors", "/settings")).toBe(true);
    expect(isExactHref("/settings/connectors", "/settings")).toBe(false);
  });
});
