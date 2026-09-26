// ────────────────────────────────────────────────────────────────────────────
// Time-zone math for restaurant-local wall time ↔ UTC instants.
//
// Design (docs/TZ_DECISION.md):
//   • Zero dependencies — Intl.DateTimeFormat (ICU) ships with Node/browsers.
//   • All persistence is UTC (timestamptz). Wall time exists only at the
//     edges: materializing service-period windows and rendering labels.
//   • wallToUtc is a converging two-pass offset resolution, correct across
//     DST transitions (verified by tests/unit/tz.test.ts and T10).
// ────────────────────────────────────────────────────────────────────────────

export interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    // Validates the zone id early — Intl throws on unknown zones, which is
    // exactly the loud failure we want for a misconfigured restaurant.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Restaurant-local wall-clock parts of a UTC instant. */
export function wallParts(tz: string, instant: Date): WallParts {
  const parts = fmt(tz).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Offset of `tz` from UTC in minutes at `instant` (east positive:
 * Asia/Tokyo → 540, America/New_York (summer) → -240).
 */
export function tzOffsetMinutes(tz: string, instant: Date): number {
  const p = wallParts(tz, instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/**
 * Convert restaurant-local wall time on a local calendar date to a UTC
 * instant. Iterates the offset until it converges (2 passes cover every real
 * DST transition; a third is kept for paranoia).
 *
 * Nonexistent wall times (spring-forward gap, e.g. 02:30 on the missing
 * hour) resolve to the instant whose local wall time is the closest valid
 * one after the gap. Service hours (11:00–23:00) never hit that window.
 * Ambiguous fall-back times resolve to the first (earlier) occurrence.
 */
export function wallToUtc(tz: string, dateLocal: string, wall: string): Date {
  const [y, m, d] = dateLocal.split("-").map(Number);
  const [hh, mm] = wall.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) {
    throw new Error(`invalid date/wall: ${dateLocal} ${wall}`);
  }
  const nominal = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ts = nominal - tzOffsetMinutes(tz, new Date(nominal)) * 60_000;
  for (let i = 0; i < 2; i++) {
    const next = nominal - tzOffsetMinutes(tz, new Date(ts)) * 60_000;
    if (next === ts) break;
    ts = next;
  }
  return new Date(ts);
}

/** { dateLocal: "2026-10-02", wall: "19:00" } for an instant in tz. */
export function utcToWall(
  tz: string,
  instant: Date
): { dateLocal: string; wall: string } {
  const p = wallParts(tz, instant);
  return {
    dateLocal: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    wall: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

/** "19:00" (24h) for an instant in tz. */
export function wall24(tz: string, instant: Date): string {
  return utcToWall(tz, instant).wall;
}

/** "YYYY-MM-DD" local calendar date for an instant in tz. */
export function dateLocalOf(tz: string, instant: Date): string {
  return utcToWall(tz, instant).dateLocal;
}

/** Human label, e.g. "7:00 PM". */
export function formatLocalLabel(tz: string, instant: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(instant);
}

/** "18:00" → 1080. Throws on malformed input. */
export function parseWall(wall: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(wall);
  if (!m) throw new Error(`invalid wall time: ${wall}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`invalid wall time: ${wall}`);
  return h * 60 + min;
}

/** Minutes since local midnight for an instant in tz. */
export function wallMinutes(tz: string, instant: Date): number {
  const p = wallParts(tz, instant);
  return p.hour * 60 + p.minute;
}

/** Local calendar date N days after (or before, negative) a given date. */
export function addDays(dateLocal: string, days: number): string {
  const [y, m, d] = dateLocal.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Today's local calendar date in tz, given the current instant. */
export function todayLocal(tz: string, now: Date): string {
  return dateLocalOf(tz, now);
}
