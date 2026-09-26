import { describe, expect, it } from "vitest";
import {
  buildSlotStarts,
  fitsInWindow,
  overlaps,
  periodUtcWindow,
} from "@/lib/time/slots";

describe("slots: period windows", () => {
  it("NY dinner window on a summer date is 21:30Z → 03:00Z(+1)", () => {
    const w = periodUtcWindow("America/New_York", {
      date_local: "2026-07-15",
      start_local: "17:30",
      end_local: "23:00",
    });
    expect(w.startUtc.toISOString()).toBe("2026-07-15T21:30:00.000Z");
    expect(w.endUtc.toISOString()).toBe("2026-07-16T03:00:00.000Z");
  });

  it("NY fall-back date (2026-11-01) shifts the window one hour later in UTC", () => {
    const w = periodUtcWindow("America/New_York", {
      date_local: "2026-11-01",
      start_local: "17:30",
      end_local: "23:00",
    });
    expect(w.startUtc.toISOString()).toBe("2026-11-01T22:30:00.000Z");
    expect(w.endUtc.toISOString()).toBe("2026-11-02T04:00:00.000Z");
  });

  it("rejects end <= start", () => {
    expect(() =>
      periodUtcWindow("America/New_York", {
        date_local: "2026-10-06",
        start_local: "23:00",
        end_local: "17:30",
      })
    ).toThrow();
  });
});

describe("slots: presented grid", () => {
  const w = periodUtcWindow("America/New_York", {
    date_local: "2026-10-06",
    start_local: "17:30",
    end_local: "23:00",
  });

  it("90-min durations on a 15-min grid: 17 slots (17:30 … 21:30 starts)", () => {
    const starts = buildSlotStarts(w);
    expect(starts).toHaveLength(17);
    expect(starts[0].toISOString()).toBe("2026-10-06T21:30:00.000Z");
    // last start = 21:30 local (EDT) = 01:30Z next day; +90min lands on window end
    expect(starts[16].toISOString()).toBe("2026-10-07T01:30:00.000Z");
    // last start + 90min must land exactly on window end
    expect(starts[starts.length - 1].getTime() + 90 * 60_000).toBe(w.endUtc.getTime());
  });

  it("fitsInWindow: inside yes, straddling no", () => {
    const insideStart = new Date(w.startUtc.getTime() + 30 * 60_000);
    const insideEnd = new Date(insideStart.getTime() + 90 * 60_000);
    expect(fitsInWindow(insideStart, insideEnd, [w])).toBe(true);

    const straddleStart = new Date(w.endUtc.getTime() - 60 * 60_000);
    const straddleEnd = new Date(straddleStart.getTime() + 90 * 60_000);
    expect(fitsInWindow(straddleStart, straddleEnd, [w])).toBe(false);
  });

  it("overlaps: half-open [) semantics — touching is not overlapping", () => {
    const a = { s: new Date("2026-10-06T22:00:00Z"), e: new Date("2026-10-06T23:30:00Z") };
    const touching = { s: a.e, e: new Date("2026-10-07T00:30:00Z") };
    const cutting = { s: new Date("2026-10-06T23:00:00Z"), e: new Date("2026-10-07T00:00:00Z") };
    expect(overlaps(a.s, a.e, touching.s, touching.e)).toBe(false);
    expect(overlaps(a.s, a.e, cutting.s, cutting.e)).toBe(true);
  });
});
