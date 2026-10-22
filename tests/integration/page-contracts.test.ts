import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_USER_ID } from "@/lib/demo";
import {
  loadAgent,
  loadCabinet,
  loadCouncil,
  loadMemory,
  loadReview,
  loadTask,
  loadToday,
} from "@/server/readmodels";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("page DTO contracts", () => {
  it("passes every seeded page through its runtime DTO", async () => {
    await expect(loadToday(DEMO_USER_ID)).resolves.toBeTruthy();
    await expect(loadReview(DEMO_USER_ID)).resolves.toBeTruthy();
    await expect(loadCabinet(DEMO_USER_ID)).resolves.toBeTruthy();
    await expect(loadCouncil(DEMO_USER_ID)).resolves.toBeTruthy();
    await expect(loadMemory(DEMO_USER_ID)).resolves.toBeTruthy();
    await expect(loadTask("tsk_read", DEMO_USER_ID)).resolves.toBeTruthy();
    await expect(loadAgent("ag_coach", DEMO_USER_ID)).resolves.toBeTruthy();
  });
});
