import { describe, expect, it } from "vitest";
import {
  localDateKey,
  startOfLocalWeek,
  weekRange,
  zonedTimeToUtc,
} from "@/lib/domain/time";

describe("timezone helpers", () => {
  it("converts Asia/Shanghai midnight to UTC", () => {
    const utc = zonedTimeToUtc(2026, 10, 23, 0, 0, "Asia/Shanghai");
    expect(utc.toISOString()).toBe("2026-10-22T16:00:00.000Z");
  });

  it("converts New York midnight across DST", () => {
    const before = zonedTimeToUtc(2026, 3, 8, 0, 0, "America/New_York");
    const after = zonedTimeToUtc(2026, 3, 9, 0, 0, "America/New_York");
    expect(before.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(after.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("computes local date keys across the UTC boundary", () => {
    expect(
      localDateKey(new Date("2026-10-22T16:30:00Z"), "Asia/Shanghai"),
    ).toBe("2026-10-23");
    expect(
      localDateKey(new Date("2026-10-22T16:30:00Z"), "UTC"),
    ).toBe("2026-10-22");
  });

  it("starts the week on Monday in the user timezone", () => {
    const start = startOfLocalWeek(
      new Date("2026-10-22T12:00:00Z"),
      "Asia/Shanghai",
    );
    expect(start.toISOString()).toBe("2026-10-18T16:00:00.000Z");
  });

  it("returns a 7-day week range", () => {
    const range = weekRange(new Date("2026-10-22T12:00:00Z"), "Asia/Shanghai");
    expect(range.start.toISOString()).toBe("2026-10-18T16:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-10-25T16:00:00.000Z");
    expect(range.key).toBe("2026-W43");
  });
});
