// Seed fixtures — 6 restaurants across 4 time zones (BUILD_PLAN §1),
// including America/New_York deliberately (DST-relevant: fall-back Nov 1, 2026).
// Service periods are materialized per date via periodUtcWindow, so DST is
// baked into every row.
import type { Executor } from "@/lib/db/sql";
import { periodUtcWindow } from "@/lib/time/slots";
import { addDays, dateLocalOf } from "@/lib/time/tz";

export const LUNCH = { meal: "lunch", start_local: "11:30", end_local: "14:30" };
export const DINNER = { meal: "dinner", start_local: "17:30", end_local: "23:00" };

/** Extra dates seeded for the DST boundary demo/tests (US fall-back 2026). */
export const DST_DEMO_DATES = ["2026-10-31", "2026-11-01"];

interface SeedRestaurant {
  id: string;
  slug: string;
  name: string;
  cuisine: string;
  timezone: string;
  address: string;
  tables: { id: string; label: string; capacity: number; minParty?: number }[];
}

export const SEED_RESTAURANTS: SeedRestaurant[] = [
  {
    id: "rst_harbor",
    slug: "harbor-and-vine",
    name: "Harbor & Vine",
    cuisine: "New American",
    timezone: "America/New_York",
    address: "12 Seaport Blvd, Boston",
    tables: [
      { id: "tbl_harbor_1", label: "T1", capacity: 2 },
      { id: "tbl_harbor_2", label: "T2", capacity: 4 },
      { id: "tbl_harbor_3", label: "T3", capacity: 4 },
      { id: "tbl_harbor_4", label: "T4", capacity: 6 },
    ],
  },
  {
    id: "rst_nonna",
    slug: "nonna-lucia",
    name: "Nonna Lucia",
    cuisine: "Italian",
    timezone: "America/New_York",
    address: "88 Mulberry St, New York",
    tables: [
      { id: "tbl_nonna_1", label: "T1", capacity: 4 },
      { id: "tbl_nonna_2", label: "T2", capacity: 4 },
      { id: "tbl_nonna_3", label: "T3", capacity: 8 },
    ],
  },
  {
    id: "rst_sakura",
    slug: "sakura-tei",
    name: "Sakura-Tei",
    cuisine: "Japanese",
    timezone: "Asia/Tokyo",
    address: "3-11 Shinjuku, Tokyo",
    tables: [
      { id: "tbl_sakura_1", label: "H1", capacity: 2 },
      { id: "tbl_sakura_2", label: "H2", capacity: 2 },
      { id: "tbl_sakura_3", label: "H3", capacity: 4 },
      { id: "tbl_sakura_4", label: "H4", capacity: 6 },
    ],
  },
  {
    id: "rst_ganges",
    slug: "ganges-ember",
    name: "Ganges Ember",
    cuisine: "Indian",
    timezone: "Asia/Kolkata",
    address: "45 Colaba Causeway, Mumbai",
    tables: [
      { id: "tbl_ganges_1", label: "T1", capacity: 4 },
      { id: "tbl_ganges_2", label: "T2", capacity: 4 },
      { id: "tbl_ganges_3", label: "T3", capacity: 6 },
    ],
  },
  {
    id: "rst_zinc",
    slug: "le-petit-zinc",
    name: "Le Petit Zinc",
    cuisine: "French",
    timezone: "Europe/Paris",
    address: "9 Rue Sainte-Anne, Paris",
    tables: [
      { id: "tbl_zinc_1", label: "S1", capacity: 2 },
      { id: "tbl_zinc_2", label: "S2", capacity: 4 },
      { id: "tbl_zinc_3", label: "S3", capacity: 4 },
      { id: "tbl_zinc_4", label: "S4", capacity: 6 },
    ],
  },
  {
    id: "rst_counter",
    slug: "chefs-counter",
    name: "The Chef's Counter",
    cuisine: "Omakase",
    timezone: "America/New_York",
    address: "1 Beacon St, Boston",
    // ONE table — the kill-demo arena: N racers, exactly one winner.
    tables: [{ id: "tbl_counter_1", label: "Counter", capacity: 8 }],
  },
  {
    id: "rst_thames",
    slug: "thames-table",
    name: "The Thames Table",
    cuisine: "British",
    timezone: "Europe/London",
    address: "2 Bankside, London",
    tables: [
      { id: "tbl_thames_1", label: "T1", capacity: 4 },
      { id: "tbl_thames_2", label: "T2", capacity: 4 },
      { id: "tbl_thames_3", label: "T3", capacity: 8 },
    ],
  },
];

export function seedDatesFor(tz: string, now: Date): string[] {
  const today = dateLocalOf(tz, now);
  const dates: string[] = [];
  for (let i = 0; i < 14; i++) dates.push(addDays(today, i));
  if (tz === "America/New_York") {
    for (const d of DST_DEMO_DATES) if (!dates.includes(d)) dates.push(d);
  }
  return dates;
}

export async function seedIfEmpty(db: Executor, now: Date = new Date()): Promise<void> {
  const existing = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM restaurants`
  );
  if ((existing.rows[0]?.n ?? 0) > 0) return;

  let periodNo = 0;
  for (const r of SEED_RESTAURANTS) {
    await db.query(
      `INSERT INTO restaurants (id, slug, name, cuisine, timezone, address)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [r.id, r.slug, r.name, r.cuisine, r.timezone, r.address]
    );
    for (const t of r.tables) {
      await db.query(
        `INSERT INTO dining_tables (id, restaurant_id, label, capacity, min_party)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [t.id, r.id, t.label, t.capacity, t.minParty ?? 1]
      );
    }
    for (const date of seedDatesFor(r.timezone, now)) {
      for (const meal of [LUNCH, DINNER]) {
        const window = periodUtcWindow(r.timezone, {
          date_local: date,
          start_local: meal.start_local,
          end_local: meal.end_local,
        });
        periodNo++;
        await db.query(
          `INSERT INTO service_periods
             (id, restaurant_id, date_local, meal, start_local, end_local, starts_at_utc, ends_at_utc)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (restaurant_id, date_local, meal) DO NOTHING`,
          [
            `spd_${r.id}_${periodNo}`,
            r.id,
            date,
            meal.meal,
            meal.start_local,
            meal.end_local,
            window.startUtc.toISOString(),
            window.endUtc.toISOString(),
          ]
        );
      }
    }
  }
}
