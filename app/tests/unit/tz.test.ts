import { describe, expect, it } from "vitest";
import {
  addDays,
  parseWall,
  tzOffsetMinutes,
  utcToWall,
  wallToUtc,
} from "@/lib/time/tz";

describe("tz: offset resolution", () => {
  it("NY is EDT (-240) in summer", () => {
    expect(tzOffsetMinutes("America/New_York", new Date("2026-07-15T18:00:00Z"))).toBe(-240);
  });

  it("NY is EST (-300) in winter", () => {
    expect(tzOffsetMinutes("America/New_York", new Date("2026-01-15T18:00:00Z"))).toBe(-300);
  });

  it("Tokyo has no DST (+540 all year)", () => {
    expect(tzOffsetMinutes("Asia/Tokyo", new Date("2026-07-15T18:00:00Z"))).toBe(540);
    expect(tzOffsetMinutes("Asia/Tokyo", new Date("2026-01-15T18:00:00Z"))).toBe(540);
  });

  it("unknown zone throws (loud config failure)", () => {
    expect(() => tzOffsetMinutes("Mars/Olympus", new Date())).toThrow();
  });
});

describe("tz: wall → UTC (the direction that matters for bookings)", () => {
  it("NY dinner 18:00 summer = 22:00Z", () => {
    expect(wallToUtc("America/New_York", "2026-07-15", "18:00").toISOString()).toBe(
      "2026-07-15T22:00:00.000Z"
    );
  });

  it("NY dinner 18:00 winter = 23:00Z", () => {
    expect(wallToUtc("America/New_York", "2026-01-15", "18:00").toISOString()).toBe(
      "2026-01-15T23:00:00.000Z"
    );
  });

  it("Tokyo 18:00 = 09:00Z", () => {
    expect(wallToUtc("Asia/Tokyo", "2026-07-15", "18:00").toISOString()).toBe(
      "2026-07-15T09:00:00.000Z"
    );
  });

  it("US fall-back day (2026-11-01): evening is EST = 23:00Z (one hour later UTC than summer)", () => {
    // DST ends 2026-11-01 at 02:00 local; by 18:00 the zone is back on EST.
    expect(wallToUtc("America/New_York", "2026-11-01", "18:00").toISOString()).toBe(
      "2026-11-01T23:00:00.000Z"
    );
  });

  it("round-trips through utcToWall for ordinary times", () => {
    for (const tz of ["America/New_York", "Asia/Tokyo", "Europe/Paris"]) {
      for (const wall of ["11:30", "17:30", "23:00"]) {
        const instant = wallToUtc(tz, "2026-10-06", wall);
        expect(utcToWall(tz, instant)).toEqual({ dateLocal: "2026-10-06", wall });
      }
    }
  });
});

describe("tz: small utilities", () => {
  it("parseWall", () => {
    expect(parseWall("18:00")).toBe(1080);
    expect(parseWall("0:00")).toBe(0);
    expect(() => parseWall("18:99")).toThrow();
    expect(() => parseWall("18h00")).toThrow();
  });

  it("addDays crosses month boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-10-06", -7)).toBe("2026-09-29");
  });
});
