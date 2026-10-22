import { afterEach, describe, expect, it } from "vitest";

import {
  demoModeEnabled,
  loadConnectors,
  testConnector,
} from "@/server/readmodels/connectors";

const saved = {
  brave: process.env.BRAVE_API_KEY,
  tavily: process.env.TAVILY_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  demo: process.env.DEMO_MODE,
};

afterEach(() => {
  restore("BRAVE_API_KEY", saved.brave);
  restore("TAVILY_API_KEY", saved.tavily);
  restore("OPENAI_API_KEY", saved.openai);
  restore("DEMO_MODE", saved.demo);
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("connector status", () => {
  it("names the variable to set even when nothing is configured", () => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.TAVILY_API_KEY;

    const status = loadConnectors(false);

    expect(status.search.configured).toBe(false);
    expect(status.search.provider).toBe("brave");
    expect(status.search.envVar).toBe("BRAVE_API_KEY");
  });

  it("reports the fallback only when a second provider exists", () => {
    process.env.BRAVE_API_KEY = "test-brave";
    delete process.env.TAVILY_API_KEY;
    expect(loadConnectors(false).search.fallbackConfigured).toBe(false);

    process.env.TAVILY_API_KEY = "test-tavily";
    const both = loadConnectors(false).search;
    expect(both.provider).toBe("brave");
    expect(both.fallback).toBe("tavily");
    expect(both.fallbackConfigured).toBe(true);
  });

  it("uses Tavily alone as the primary when Brave is absent", () => {
    delete process.env.BRAVE_API_KEY;
    process.env.TAVILY_API_KEY = "test-tavily";

    const search = loadConnectors(false).search;
    expect(search.provider).toBe("tavily");
    expect(search.envVar).toBe("TAVILY_API_KEY");
    expect(search.fallbackConfigured).toBe(false);
  });

  it("never leaks a key value", () => {
    process.env.BRAVE_API_KEY = "super-secret-value";
    expect(JSON.stringify(loadConnectors(false))).not.toContain("super-secret-value");
  });

  it("reads demo mode from one place", () => {
    process.env.DEMO_MODE = "true";
    expect(demoModeEnabled()).toBe(true);
    expect(loadConnectors().demoMode).toBe(true);
    process.env.DEMO_MODE = "false";
    expect(demoModeEnabled()).toBe(false);
  });
});

describe("connector test", () => {
  it("reports not_configured instead of pretending to work", async () => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.TAVILY_API_KEY;

    const result = await testConnector();

    expect(result.status).toBe("not_configured");
    expect(result.provider).toBeNull();
    expect(result.hits).toBe(0);
    expect(result.message).toContain("BRAVE_API_KEY");
  });
});
