// ────────────────────────────────────────────────────────────────────────────
// Availability — computes the presented 15-min booking grid from interval
// math (BUILD_PLAN §2.3: slots are presented, never stored). Expired holds
// are swept first (I2) so they never block a slot.
// ────────────────────────────────────────────────────────────────────────────
import { ApiError } from "./errors";
import { sweepExpiredHoldsForDb } from "./sweep";
import type { ReservationRow, RestaurantRow, ServiceDeps, TableRow } from "./service";
import {
  DEFAULT_DURATION_MIN,
  PeriodWindow,
  SLOT_STEP_MIN,
  buildSlotStarts,
  overlaps,
} from "@/lib/time/slots";
import { formatLocalLabel, wall24 } from "@/lib/time/tz";

export interface SlotView {
  startsAtUTC: string;
  localWall: string; // "7:00 PM"
  localWall24: string; // "19:00"
  freeTables: number;
  isPast: boolean;
}

export interface AvailabilityView {
  restaurantId: string;
  date: string;
  timezone: string;
  durationMin: number;
  slotStepMin: number;
  periods: { meal: string; startLocal: string; endLocal: string }[];
  slots: SlotView[];
}

export async function getAvailability(
  deps: ServiceDeps,
  restaurantId: string,
  dateLocal: string,
  partySize: number | undefined
): Promise<AvailabilityView> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateLocal)) {
    throw new ApiError("VALIDATION_FAILED", "date must be YYYY-MM-DD", { date: dateLocal });
  }
  if (partySize !== undefined && (!Number.isInteger(partySize) || partySize < 1 || partySize > 20)) {
    throw new ApiError("VALIDATION_FAILED", "party must be an integer in [1, 20]", {
      party: partySize,
    });
  }

  const now = deps.now?.() ?? new Date();

  const restaurant = await deps.db.query<RestaurantRow>(
    `SELECT id, slug, name, cuisine, timezone, address FROM restaurants WHERE id = $1`,
    [restaurantId]
  );
  const r = restaurant.rows[0];
  if (!r) throw new ApiError("NOT_FOUND", "restaurant not found", { restaurantId });

  // I2 — expired holds vanish before we compute anything.
  await deps.db.transaction(async (tx) => {
    await sweepExpiredHoldsForDb(tx, r.id, now);
  });

  const periods = await deps.db.query<{
    id: string;
    meal: string;
    start_local: string;
    end_local: string;
    starts_at_utc: Date | string;
    ends_at_utc: Date | string;
  }>(
    `SELECT id, meal, start_local, end_local, starts_at_utc, ends_at_utc
     FROM service_periods
     WHERE restaurant_id = $1 AND date_local = $2
     ORDER BY starts_at_utc ASC`,
    [r.id, dateLocal]
  );

  const views: AvailabilityView["periods"] = periods.rows.map((p) => ({
    meal: p.meal,
    startLocal: p.start_local,
    endLocal: p.end_local,
  }));

  // Tables relevant to this party size (all tables when no party given).
  const tables = await deps.db.query<TableRow>(
    partySize !== undefined
      ? `SELECT id, restaurant_id, label, capacity, min_party
         FROM dining_tables
         WHERE restaurant_id = $1 AND capacity >= $2 AND min_party <= $2
         ORDER BY capacity ASC, label ASC`
      : `SELECT id, restaurant_id, label, capacity, min_party
         FROM dining_tables
         WHERE restaurant_id = $1
         ORDER BY capacity ASC, label ASC`,
    partySize !== undefined ? [r.id, partySize] : [r.id]
  );

  if (periods.rows.length === 0 || tables.rows.length === 0) {
    return {
      restaurantId: r.id,
      date: dateLocal,
      timezone: r.timezone,
      durationMin: DEFAULT_DURATION_MIN,
      slotStepMin: SLOT_STEP_MIN,
      periods: views,
      slots: [],
    };
  }

  const windowStart = periods.rows
    .map((p) => new Date(p.starts_at_utc).getTime())
    .reduce((a, b) => Math.min(a, b));
  const windowEnd = periods.rows
    .map((p) => new Date(p.ends_at_utc).getTime())
    .reduce((a, b) => Math.max(a, b));

  // One range read for the whole day; overlap is decided in memory.
  const active = await deps.db.query<ReservationRow>(
    `SELECT id, restaurant_id, table_id, party_size, starts_at, ends_at,
            status, hold_expires_at, guest_name, guest_email, guest_phone,
            confirm_code, created_at
     FROM reservations
     WHERE restaurant_id = $1
       AND status IN ('held','confirmed')
       AND starts_at < $2 AND ends_at > $3`,
    [r.id, new Date(windowEnd).toISOString(), new Date(windowStart).toISOString()]
  );
  const byTable = new Map<string, ReservationRow[]>();
  for (const res of active.rows) {
    const list = byTable.get(res.table_id) ?? [];
    list.push(res);
    byTable.set(res.table_id, list);
  }

  const durationMs = DEFAULT_DURATION_MIN * 60_000;
  const slots: SlotView[] = [];
  for (const p of periods.rows) {
    const window: PeriodWindow = {
      startUtc: new Date(p.starts_at_utc),
      endUtc: new Date(p.ends_at_utc),
    };
    for (const slot of buildSlotStarts(window)) {
      const slotEnd = new Date(slot.getTime() + durationMs);
      let free = 0;
      for (const t of tables.rows) {
        const busy = (byTable.get(t.id) ?? []).some((res) =>
          overlaps(slot, slotEnd, new Date(res.starts_at), new Date(res.ends_at))
        );
        if (!busy) free++;
      }
      slots.push({
        startsAtUTC: slot.toISOString(),
        localWall: formatLocalLabel(r.timezone, slot),
        localWall24: wall24(r.timezone, slot),
        freeTables: free,
        isPast: slot < now,
      });
    }
  }

  return {
    restaurantId: r.id,
    date: dateLocal,
    timezone: r.timezone,
    durationMin: DEFAULT_DURATION_MIN,
    slotStepMin: SLOT_STEP_MIN,
    periods: views,
    slots,
  };
}
