// ────────────────────────────────────────────────────────────────────────────
// Service periods + availability slot math (pure functions).
//
// Why intervals, not stored slots (BUILD_PLAN §2.3): the conflict condition
// — "two active bookings on the same table whose [starts_at, ends_at)
// intersect" — is first-class SQL, enforced by the EXCLUDE constraint.
// Slots are only *presented*, computed from interval math, never stored.
// ────────────────────────────────────────────────────────────────────────────
import { parseWall, wallToUtc } from "./tz";

export const SLOT_STEP_MIN = 15; // presented grid granularity
export const DEFAULT_DURATION_MIN = 90; // default dining duration

export interface PeriodWindow {
  startUtc: Date;
  endUtc: Date;
}

export interface PeriodLike {
  date_local: string;
  start_local: string;
  end_local: string;
}

/**
 * Derive the UTC window of a service period from its restaurant-local
 * definition. Materialized at seed/insert time — DST is baked in per date
 * (see T10: the NY fall-back date shifts the window by one hour, by design).
 */
export function periodUtcWindow(tz: string, p: PeriodLike): PeriodWindow {
  const startMin = parseWall(p.start_local);
  const endMin = parseWall(p.end_local);
  if (endMin <= startMin) {
    throw new Error(
      `service period must end after it starts (${p.start_local}–${p.end_local})`
    );
  }
  return {
    startUtc: wallToUtc(tz, p.date_local, p.start_local),
    endUtc: wallToUtc(tz, p.date_local, p.end_local),
  };
}

/**
 * Bookable slot starts on a 15-min grid from the window start, for which the
 * full dining duration fits inside the window: slot + duration ≤ windowEnd.
 */
export function buildSlotStarts(
  window: PeriodWindow,
  durationMin = DEFAULT_DURATION_MIN,
  stepMin = SLOT_STEP_MIN
): Date[] {
  const out: Date[] = [];
  const start = window.startUtc.getTime();
  const end = window.endUtc.getTime();
  const step = stepMin * 60_000;
  const duration = durationMin * 60_000;
  for (let t = start; t + duration <= end; t += step) {
    out.push(new Date(t));
  }
  return out;
}

/** I5: a reservation fits fully inside ONE open period window. */
export function fitsInWindow(
  startsAt: Date,
  endsAt: Date,
  windows: PeriodWindow[]
): boolean {
  return windows.some((w) => startsAt >= w.startUtc && endsAt <= w.endUtc);
}

/**
 * Interval overlap for two half-open [start, end) ranges.
 * Shared with the SQL predicate: starts_at < other.ends_at AND ends_at > other.starts_at.
 */
export function overlaps(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date
): boolean {
  return aStart < bEnd && bStart < aEnd;
}
