// T11 — soak: 150 mixed operations (holds, confirms, cancels, expiry-races)
// over random tables/slots, including concurrent batches. Contention is
// expected and legal; what must NEVER happen is a corrupt state. Afterwards
// the invariant is RE-VERIFIED FROM THE DATA: a SQL self-join proves zero
// overlapping active intervals, and the constraint + audit trail are present.
import { beforeAll, it, expect } from "vitest";
import { D1, NY, codeOf, freshDb, makeRestaurant, overlapPairs, slotOn } from "./helpers";
import { addDays } from "@/lib/time/tz";
import { PgLiteClient } from "@/lib/db/pglite";
import { cancelReservation, confirmHold, createHold } from "@/lib/booking/service";

let db: PgLiteClient;
const D2 = addDays(D1, 1);

beforeAll(async () => {
  db = await freshDb();
  await makeRestaurant(db, {
    id: "soak",
    tables: [
      { id: "soak_t1", label: "T1", capacity: 2 },
      { id: "soak_t2", label: "T2", capacity: 4 },
      { id: "soak_t3", label: "T3", capacity: 6 },
    ],
    dates: [D1, D2],
  });
});

it(
  "T11: 150-op soak — contention handled, zero overlapping active intervals in final data",
  async () => {
    // Full 15-min grid over both dinner services — slot + 90min must fit
    // inside 17:30–23:00, so the last valid start is 21:30 (34 slots total).
    const walls = ["17:30", "17:45", "18:00", "18:15", "18:30", "18:45", "19:00", "19:15",
      "19:30", "19:45", "20:00", "20:15", "20:30", "20:45", "21:00", "21:15", "21:30"];
    const slots = [
      ...walls.map((w) => slotOn(NY, D1, w)),
      ...walls.map((w) => slotOn(NY, D2, w)),
    ];

    const held: string[] = [];
    const stats = { hold: 0, confirm: 0, cancel: 0, expire: 0, rejected: 0 };

    const oneOp = async (i: number): Promise<void> => {
      const kind = i % 10;
      const slot = slots[Math.floor(Math.random() * slots.length)];
      try {
        if (kind < 5 || held.length < 2) {
          // 50% hold pressure
          const r = await createHold(
            { db },
            {
              restaurantId: "soak",
              startsAt: slot,
              partySize: 2,
              guest: { name: `g${i}`, email: `g${i}@example.com` },
            },
            i % 7 === 0 ? `soak-key-${i}` : undefined
          );
          held.push(r.body.id);
          stats.hold++;
        } else if (kind < 8) {
          const id = held.pop();
          if (id) {
            await confirmHold({ db }, id);
            stats.confirm++;
          }
        } else if (kind < 9) {
          const id = held.pop();
          if (id) {
            await cancelReservation({ db }, id);
            stats.cancel++;
          }
        } else {
          // expiry race: force TTL into the past, then try to confirm
          const id = held.pop();
          if (id) {
            await db.query(
              `UPDATE reservations SET hold_expires_at = now() - interval '1 minute'
               WHERE id = $1 AND status = 'held'`,
              [id]
            );
            await confirmHold({ db }, id).catch((e) => {
              // 410 HOLD_EXPIRED / 409 INVALID_TRANSITION are both fine
              expect(["HOLD_EXPIRED", "INVALID_TRANSITION"]).toContain(codeOf(e));
            });
            stats.expire++;
          }
        }
      } catch (e) {
        // Contention outcomes are EXPECTED — the invariant is that they never
        // corrupt state. Anything else is a bug.
        stats.rejected++;
        expect(["SLOT_TAKEN", "PARTY_TOO_LARGE", "VALIDATION_FAILED", "OUTSIDE_SERVICE_HOURS"]).toContain(codeOf(e));
      }
    };

    for (let i = 0; i < 100; i++) await oneOp(i);
    for (let b = 0; b < 10; b++) {
      await Promise.all(Array.from({ length: 5 }, (_, k) => oneOp(100 + b * 5 + k)));
    }

    // A meaningful share of ops must have executed, and contention must have
    // actually been exercised: with 90-min durations on a 15-min grid each
    // booking blocks 6 slot-starts per table, so ~90% of late hold attempts
    // are correctly rejected. That IS the adversarial scenario.
    const executed = stats.hold + stats.confirm + stats.cancel + stats.expire;
    expect(executed).toBeGreaterThan(20);
    expect(stats.rejected).toBeGreaterThan(20);

    // ── THE ACTUAL POINT: re-verify the invariant from the data, not the code.
    expect(await overlapPairs(db)).toBe(0);

    const chk = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_constraint
       WHERE conname = 'reservation_no_overlap'
         AND conrelid = 'reservations'::regclass`
    );
    expect(chk.rows[0]?.n).toBe(1);

    // State-machine consistency in the final data:
    // every 'held' row carries a TTL; no other status does.
    const consistency = await db.query<{ bad: number }>(
      `SELECT COUNT(*)::int AS bad FROM reservations
       WHERE (status = 'held') <> (hold_expires_at IS NOT NULL)`
    );
    expect(consistency.rows[0]?.bad).toBe(0);

    // The evidence trail exists.
    const aud = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_events`);
    expect(aud.rows[0]?.n).toBeGreaterThan(0);

    const idem = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM idempotency_records`
    );
    expect(idem.rows[0]?.n).toBeGreaterThan(0);
  },
  60_000
);
