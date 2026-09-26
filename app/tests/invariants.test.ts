// ────────────────────────────────────────────────────────────────────────────
// The adversarial invariant suite (BUILD_PLAN §5, T1–T10).
//
// T11 (soak) lives in soak.test.ts. CI runs this same suite against a real
// postgres:16 with true parallel connections; locally it runs on embedded
// PGlite with serialized transactions (logic-equivalent proof).
//
// Each test owns its own restaurant (tables are cheap) so fixture state
// never leaks between tests — determinism is part of the evidence.
// ────────────────────────────────────────────────────────────────────────────
import { beforeAll, expect, it } from "vitest";
import {
  D1,
  NY,
  codeOf,
  freshDb,
  guest,
  makeRestaurant,
  overlapPairs,
  slotOn,
} from "./helpers";
import { PgLiteClient } from "@/lib/db/pglite";
import {
  cancelReservation,
  confirmHold,
  createHold,
  type HoldInput,
} from "@/lib/booking/service";
import { wallToUtc } from "@/lib/time/tz";

let db: PgLiteClient;

const hold = (
  restaurantId: string,
  startsAt: string,
  partySize = 2,
  name = "Ada"
): HoldInput => ({ restaurantId, startsAt, partySize, guest: guest(name) });

beforeAll(async () => {
  db = await freshDb();
  await makeRestaurant(db, {
    id: "solo", // ONE table — the T1 race arena
    tables: [{ id: "solo_t1", label: "T1", capacity: 4, minParty: 2 }],
    dates: [D1],
  });
  await makeRestaurant(db, {
    id: "duo", // expiry / storm / hours arena
    tables: [
      { id: "duo_t1", label: "T1", capacity: 4 },
      { id: "duo_t2", label: "T2", capacity: 4 },
    ],
    dates: [D1],
  });
  await makeRestaurant(db, {
    id: "twin", // cross-table independence
    tables: [
      { id: "twin_t1", label: "T1", capacity: 4 },
      { id: "twin_t2", label: "T2", capacity: 4 },
    ],
    dates: [D1],
  });
  await makeRestaurant(db, {
    id: "sizes", // capacity selection
    tables: [
      { id: "sizes_t1", label: "T1", capacity: 4 },
      { id: "sizes_t2", label: "T2", capacity: 6 },
    ],
    dates: [D1],
  });
  await makeRestaurant(db, {
    id: "seam", // half-open interval semantics (single table)
    tables: [{ id: "seam_t1", label: "T1", capacity: 4 }],
    dates: [D1],
  });
  await makeRestaurant(db, {
    id: "nysolo", // DST boundary arena (fall-back: 2026-11-01)
    tables: [{ id: "nysolo_t1", label: "T1", capacity: 4 }],
    dates: ["2026-10-31", "2026-11-01"],
  });
});

// T1 — 50-way race on the same table/slot: exactly one winner.
it("T1: 50 concurrent holds on one table/slot → 1×201, 49×409, 1 row", async () => {
  const startsAt = slotOn(NY, D1, "19:00");
  const results = await Promise.allSettled(
    Array.from({ length: 50 }, (_, i) =>
      createHold({ db }, hold("solo", startsAt, 2, `racer${i}`))
    )
  );
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(49);
  for (const r of lost as PromiseRejectedResult[]) {
    expect(codeOf(r.reason)).toBe("SLOT_TAKEN");
  }
  const rows = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM reservations WHERE restaurant_id = 'solo'`
  );
  expect(rows.rows[0]?.n).toBe(1);
  expect(await overlapPairs(db)).toBe(0);
});

// T2 — expired holds are invisible and unconfirmable (I2).
it("T2: hold expires → another guest books the slot → original confirm is 410", async () => {
  const startsAt = slotOn(NY, D1, "19:00");
  const a = await createHold({ db }, hold("duo", startsAt, 2, "expiree"));
  // Force A's TTL into the past (simulates 10 minutes elapsing).
  await db.query(
    `UPDATE reservations SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`,
    [a.body.id]
  );
  const b = await createHold({ db }, hold("duo", startsAt, 2, "winner"));
  expect(b.status).toBe(201); // the expired hold did NOT block the slot
  const err = await confirmHold({ db }, a.body.id).catch((e) => e);
  expect(codeOf(err)).toBe("HOLD_EXPIRED");
  const ok = await confirmHold({ db }, b.body.id);
  expect(ok.body.status).toBe("confirmed");
});

// T3 — cancel-vs-confirm race on the same hold (I6).
// Refined during W4: cancelling a CONFIRMED reservation is legal product
// behavior (guest changes their mind), so "exactly one wins" is NOT the
// invariant. The invariant is state consistency: whatever the interleaving,
// the final status is a legitimate outcome of the order that executed —
// never a corruption, never an unhandled error.
it("T3: simultaneous confirm+cancel → consistent state under any interleaving", async () => {
  const h = await createHold({ db }, hold("duo", slotOn(NY, D1, "18:00"), 2, "racers"));
  const [confirmRes, cancelRes] = await Promise.allSettled([
    confirmHold({ db }, h.body.id),
    cancelReservation({ db }, h.body.id),
  ]);
  const rejected = [confirmRes, cancelRes].filter((r) => r.status === "rejected");
  for (const r of rejected) {
    // the ONLY legal rejection is a transition guard
    expect(codeOf((r as PromiseRejectedResult).reason)).toBe("INVALID_TRANSITION");
  }
  const final = await db.query<{ status: string }>(
    `SELECT status FROM reservations WHERE id = $1`,
    [h.body.id]
  );
  const status = final.rows[0]?.status;
  if (rejected.length === 2) {
    // impossible by construction — at least one op must succeed
    throw new Error("both confirm and cancel failed");
  } else if (rejected.length === 1) {
    // cancel ran first → confirm bounced; or (impossible) vice versa
    expect(["cancelled", "confirmed"]).toContain(status);
    if (status === "confirmed") {
      // confirm succeeded, cancel bounced — only valid single-rejection shape
      expect(confirmRes.status).toBe("fulfilled");
    }
  } else {
    // both succeeded → confirm executed first, then cancel overrode it
    expect(status).toBe("cancelled");
  }
  expect(await overlapPairs(db)).toBe(0);
});

// T4 — retry storm with one Idempotency-Key (I4): 1 reservation, identical responses.
it("T4: same idempotency key 20× in parallel → 1 reservation, 20 identical bodies", async () => {
  const startsAt = slotOn(NY, D1, "20:00");
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      createHold({ db }, hold("duo", startsAt, 2, "stormy"), "storm-key-1")
    )
  );
  const bodies = results.map((r) => JSON.stringify(r.body));
  expect(new Set(bodies).size).toBe(1); // every client saw the SAME response
  const rows = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM reservations WHERE idempotency_key = 'storm-key-1'`
  );
  expect(rows.rows[0]?.n).toBe(1);
  expect(await overlapPairs(db)).toBe(0);
});

// T5 — same key, different payload → 422 (I4).
it("T5: idempotency key reuse with different payload → DUPLICATE_IDEMPOTENCY_PAYLOAD", async () => {
  await createHold({ db }, hold("duo", slotOn(NY, D1, "17:30"), 2, "orig"), "dup-key");
  const err = await createHold(
    { db },
    hold("duo", slotOn(NY, D1, "20:30"), 4, "imposter"),
    "dup-key"
  ).catch((e) => e);
  expect(codeOf(err)).toBe("DUPLICATE_IDEMPOTENCY_PAYLOAD");
});

// T6 — overlapping intervals on DIFFERENT tables both succeed (I7).
it("T6: same interval, different tables → both 201", async () => {
  const startsAt = slotOn(NY, D1, "18:30");
  const a = await createHold({ db }, hold("twin", startsAt, 2, "t6a"));
  const b = await createHold({ db }, hold("twin", startsAt, 2, "t6b"));
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  expect(a.body.table.id).not.toBe(b.body.table.id);
});

// T7 — smallest fitting table; nothing fits → PARTY_TOO_LARGE (I3).
it("T7: party of 5 gets the 6-top; party of 7 finds nothing", async () => {
  const got6 = await createHold({ db }, hold("sizes", slotOn(NY, D1, "18:00"), 5, "party5"));
  expect(got6.body.table.capacity).toBe(6);
  expect(got6.body.table.label).toBe("T2");
  const err = await createHold(
    { db },
    hold("sizes", slotOn(NY, D1, "19:00"), 7, "party7")
  ).catch((e) => e);
  expect(codeOf(err)).toBe("PARTY_TOO_LARGE");
});

// T8 — half-open [): back-to-back bookings share an instant (I1).
it("T8: 18:00–19:30 and 19:30–21:00 on one table → both 201; 19:15 → 409", async () => {
  const a = await createHold({ db }, hold("seam", slotOn(NY, D1, "18:00"), 2, "early"));
  const b = await createHold({ db }, hold("seam", slotOn(NY, D1, "19:30"), 2, "late"));
  expect(a.status).toBe(201); // [18:00, 19:30)
  expect(b.status).toBe(201); // [19:30, 21:00) — touching A, not overlapping
  // The interval-cutting attempt overlaps both active rows → the constraint
  // (via the pre-check) refuses it.
  const c = await createHold({ db }, hold("seam", slotOn(NY, D1, "19:15"), 2, "cutter"))
    .catch((e) => e);
  expect(codeOf(c)).toBe("SLOT_TAKEN");
});

// T9 — outside service hours / straddling a period gap (I5).
it("T9: 15:00 (between services) and 14:00 (overruns lunch) → OUTSIDE_SERVICE_HOURS", async () => {
  const between = await createHold(
    { db },
    hold("duo", slotOn(NY, D1, "15:00"), 2, "gap")
  ).catch((e) => e);
  expect(codeOf(between)).toBe("OUTSIDE_SERVICE_HOURS");

  const overrun = await createHold(
    { db },
    hold("duo", slotOn(NY, D1, "14:00"), 2, "straddle")
  ).catch((e) => e);
  expect(codeOf(overrun)).toBe("OUTSIDE_SERVICE_HOURS");
});

// T10 — DST boundary (I5 + I1): fall-back shifts the materialized UTC window
// by one hour, and the same local hour on two adjacent dates books cleanly
// on the SAME single table — different absolute instants, zero overlap.
it("T10: NY fall-back — 19:00 EDT Oct 31 = 23:00Z; 19:00 EST Nov 1 = 00:00Z Nov 2; both book", async () => {
  const edt = wallToUtc(NY, "2026-10-31", "19:00");
  const est = wallToUtc(NY, "2026-11-01", "19:00");
  expect(edt.toISOString()).toBe("2026-10-31T23:00:00.000Z"); // UTC-4
  expect(est.toISOString()).toBe("2026-11-02T00:00:00.000Z"); // UTC-5 → next UTC day

  const a = await createHold({ db }, hold("nysolo", edt.toISOString(), 2, "dstA"));
  const b = await createHold({ db }, hold("nysolo", est.toISOString(), 2, "dstB"));
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  // Same physical table, same local wall time, 25 absolute hours apart —
  // nothing double-booked.
  expect(a.body.table.id).toBe("nysolo_t1");
  expect(b.body.table.id).toBe("nysolo_t1");
  expect(await overlapPairs(db)).toBe(0);
});

