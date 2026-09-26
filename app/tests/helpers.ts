// Shared test fixtures. Every invariant test boots a fresh embedded Postgres
// (PGlite) and builds its own restaurants — no shared state between suites.
//
// HONEST CONCURRENCY NOTE: PGlite serializes transactions internally (single
// embedded session), so local races prove the LOGIC (sweep → pre-check →
// constraint arbiter → retry). True parallelism (multiple connections) is
// proven in CI against the postgres:16 service container — same SQL, same
// constraint, same suite. See .github/workflows/ci.yml.
import { PgLiteClient } from "@/lib/db/pglite";
import { migrate } from "@/lib/db";
import { periodUtcWindow } from "@/lib/time/slots";
import { wallToUtc } from "@/lib/time/tz";
import type { SqlClient } from "@/lib/db/sql";

export const NY = "America/New_York";

/** A generic future local date (relative to the event window, fall 2026). */
export const D1 = "2026-10-06";

export async function freshDb(): Promise<PgLiteClient> {
  const db = new PgLiteClient();
  await migrate(db);
  return db;
}

export interface TestTableSpec {
  id: string;
  label: string;
  capacity: number;
  minParty?: number;
}

export async function makeRestaurant(
  db: SqlClient,
  args: {
    id: string;
    timezone?: string;
    tables: TestTableSpec[];
    dates: string[];
    meals?: { meal: string; start: string; end: string }[];
  }
): Promise<void> {
  const tz = args.timezone ?? NY;
  const meals =
    args.meals ?? [
      { meal: "lunch", start: "11:30", end: "14:30" },
      { meal: "dinner", start: "17:30", end: "23:00" },
    ];
  await db.query(
    `INSERT INTO restaurants (id, slug, name, cuisine, timezone, address)
     VALUES ($1,$1,$1,'test',$2,'')`,
    [args.id, tz]
  );
  for (const t of args.tables) {
    await db.query(
      `INSERT INTO dining_tables (id, restaurant_id, label, capacity, min_party)
       VALUES ($1,$2,$3,$4,$5)`,
      [t.id, args.id, t.label, t.capacity, t.minParty ?? 1]
    );
  }
  let n = 0;
  for (const date of args.dates) {
    for (const m of meals) {
      const w = periodUtcWindow(tz, {
        date_local: date,
        start_local: m.start,
        end_local: m.end,
      });
      n++;
      await db.query(
        `INSERT INTO service_periods
           (id, restaurant_id, date_local, meal, start_local, end_local, starts_at_utc, ends_at_utc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          `${args.id}_${date}_${m.meal}_${n}`,
          args.id,
          date,
          m.meal,
          m.start,
          m.end,
          w.startUtc.toISOString(),
          w.endUtc.toISOString(),
        ]
      );
    }
  }
}

export function guest(n: string) {
  return { name: n, email: `${n.toLowerCase()}@example.com` };
}

/** UTC ISO instant for a restaurant-local wall time on a local date. */
export function slotOn(tz: string, date: string, wall: string): string {
  return wallToUtc(tz, date, wall).toISOString();
}

export function codeOf(err: unknown): string {
  const c = (err as { code?: string })?.code;
  return typeof c === "string" ? c : `THROWN:${String(err)}`;
}

/** SQL-level audit: count overlapping ACTIVE interval pairs (must always be 0). */
export async function overlapPairs(db: SqlClient): Promise<number> {
  const res = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM reservations a
     JOIN reservations b
       ON a.table_id = b.table_id AND a.id < b.id
     WHERE a.status IN ('held','confirmed')
       AND b.status IN ('held','confirmed')
       AND a.starts_at < b.ends_at
       AND b.starts_at < a.ends_at`
  );
  return res.rows[0]?.n ?? 0;
}
