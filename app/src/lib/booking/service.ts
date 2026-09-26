// ────────────────────────────────────────────────────────────────────────────
// Booking service — hold / confirm / cancel. The invariants live here AND in
// the database; the database has the final word (BUILD_PLAN §3, §4):
//
//   I1  no overlapping active intervals per table  → EXCLUDE constraint (23P01)
//   I2  expired holds block nothing, confirm → 410  → lazy sweep in-tx
//   I3  partySize within [min_party, capacity]      → table selection
//   I4  retries never double-book                   → idempotency_records
//   I5  every reservation inside one open period    → SQL window check
//   I6  terminal states are terminal                → transition guards
//   I7  conflicts scoped per-table                  → table_id-only exclusion
//
// Concurrency contract: every write path runs in ONE transaction; the app
// never "checks then writes" without the constraint behind it. On constraint
// or idempotency-key races the whole transaction retries from scratch —
// the loser always lands on a well-defined 409/422, never a corrupt state.
// ────────────────────────────────────────────────────────────────────────────
import { createHash, randomUUID } from "node:crypto";
import { audit } from "./audit";
import {
  ApiError,
  EXCLUSION_VIOLATION,
  UNIQUE_VIOLATION,
  pgErrorCode,
} from "./errors";
import { sweepExpiredHoldsForDb } from "./sweep";
import type { Executor, SqlClient } from "@/lib/db/sql";
import { DEFAULT_DURATION_MIN } from "@/lib/time/slots";
import { dateLocalOf, formatLocalLabel, wall24 } from "@/lib/time/tz";

export const HOLD_TTL_MIN = 10;
export const MAX_PARTY = 20;
const MAX_RACE_RETRIES = 3;

export interface RestaurantRow {
  id: string;
  slug: string;
  name: string;
  cuisine: string;
  timezone: string;
  address: string;
}

export interface TableRow {
  id: string;
  restaurant_id: string;
  label: string;
  capacity: number;
  min_party: number;
}

export interface ReservationRow {
  id: string;
  restaurant_id: string;
  table_id: string;
  party_size: number;
  starts_at: Date | string;
  ends_at: Date | string;
  status: string;
  hold_expires_at: Date | string | null;
  guest_name: string;
  guest_email: string;
  guest_phone: string | null;
  confirm_code: string;
  created_at: Date | string;
}

export interface GuestInput {
  name: string;
  email: string;
  phone?: string;
}

export interface HoldInput {
  restaurantId: string;
  startsAt: string; // ISO-8601 UTC instant
  partySize: number;
  guest: GuestInput;
}

export interface ReservationBody {
  id: string;
  status: string;
  restaurant: { id: string; name: string; timezone: string };
  table: { id: string; label: string; capacity: number };
  partySize: number;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  local: { date: string; wall: string; label: string };
  holdExpiresAt: string | null;
  confirmCode: string;
  guest: { name: string; email: string; phone?: string | null };
  createdAt: string;
}

export interface ServiceDeps {
  db: SqlClient;
  /** Injectable clock (tests); defaults to wall clock. */
  now?: () => Date;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const iso = (v: Date | string): string => new Date(v).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thrown internally to restart the whole transaction after a lost race. */
class RaceRetry extends Error {}

function requestHash(input: HoldInput): string {
  const canonical = JSON.stringify({
    restaurantId: input.restaurantId,
    startsAt: iso(input.startsAt),
    partySize: input.partySize,
    guest: {
      name: input.guest.name,
      email: input.guest.email.toLowerCase(),
      phone: input.guest.phone ?? null,
    },
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function confirmCode(): string {
  // Unambiguous alphabet for phone/desk reading during the demo.
  const alphabet = "ACDEFHJKLMNPRTUVWXY3479";
  let s = "";
  const bytes = randomUUID().replace(/-/g, "");
  for (let i = 0; i < 8; i++) s += alphabet[parseInt(bytes[i * 2], 16) % alphabet.length];
  return `TK-${s}`;
}

/**
 * Canonical field order for a ReservationBody. JSONB storage does not
 * preserve key order, so stored idempotency responses are canonicalized on
 * the way IN and parsed bodies on the way OUT — byte-identical HTTP responses
 * for retries (I4, T4).
 */
function canonBody(b: ReservationBody): ReservationBody {
  return {
    id: b.id,
    status: b.status,
    restaurant: { id: b.restaurant.id, name: b.restaurant.name, timezone: b.restaurant.timezone },
    table: { id: b.table.id, label: b.table.label, capacity: b.table.capacity },
    partySize: b.partySize,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    durationMin: b.durationMin,
    local: { date: b.local.date, wall: b.local.wall, label: b.local.label },
    holdExpiresAt: b.holdExpiresAt,
    confirmCode: b.confirmCode,
    guest: { name: b.guest.name, email: b.guest.email, phone: b.guest.phone ?? null },
    createdAt: b.createdAt,
  };
}

function toBody(
  r: ReservationRow,
  table: TableRow,
  restaurant: RestaurantRow
): ReservationBody {
  const startsAt = new Date(r.starts_at);
  const endsAt = new Date(r.ends_at);
  return {
    id: r.id,
    status: r.status,
    restaurant: { id: restaurant.id, name: restaurant.name, timezone: restaurant.timezone },
    table: { id: table.id, label: table.label, capacity: table.capacity },
    partySize: r.party_size,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    durationMin: Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000),
    local: {
      date: dateLocalOf(restaurant.timezone, startsAt),
      wall: wall24(restaurant.timezone, startsAt),
      label: formatLocalLabel(restaurant.timezone, startsAt),
    },
    holdExpiresAt: r.hold_expires_at ? iso(r.hold_expires_at) : null,
    confirmCode: r.confirm_code,
    guest: { name: r.guest_name, email: r.guest_email, phone: r.guest_phone },
    createdAt: iso(r.created_at),
  };
}

async function getRestaurant(tx: Executor, id: string): Promise<RestaurantRow> {
  const res = await tx.query<RestaurantRow>(
    `SELECT id, slug, name, cuisine, timezone, address FROM restaurants WHERE id = $1`,
    [id]
  );
  const row = res.rows[0];
  if (!row) throw new ApiError("NOT_FOUND", "restaurant not found", { restaurantId: id });
  return row;
}

/**
 * I2 lazy sweep (shared impl in ./sweep): flip expired holds out of the way
 * *inside the same transaction* as the conflicting write, so an expired hold
 * can never block a booking — and a live hold can never be smuggled past TTL.
 */
const sweepExpiredHolds = sweepExpiredHoldsForDb;

async function insertHold(
  tx: Executor,
  args: {
    restaurant: RestaurantRow;
    table: TableRow;
    id: string;
    code: string;
    startsAt: Date;
    endsAt: Date;
    holdExpiresAt: Date;
    now: Date;
    partySize: number;
    guest: GuestInput;
    idempotencyKey: string | null;
    requestHashValue: string;
    body: ReservationBody;
  }
): Promise<void> {
  try {
    await tx.query(
      `INSERT INTO reservations
         (id, restaurant_id, table_id, party_size, starts_at, ends_at,
          status, hold_expires_at, guest_name, guest_email, guest_phone,
          confirm_code, idempotency_key, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'held',$7,$8,$9,$10,$11,$12,$13,$13)`,
      [
        args.id,
        args.restaurant.id,
        args.table.id,
        args.partySize,
        args.startsAt.toISOString(),
        args.endsAt.toISOString(),
        args.holdExpiresAt.toISOString(),
        args.guest.name,
        args.guest.email.toLowerCase(),
        args.guest.phone ?? null,
        args.code,
        args.idempotencyKey,
        args.now.toISOString(),
      ]
    );
    if (args.idempotencyKey) {
      await tx.query(
        `INSERT INTO idempotency_records
           (key, request_hash, response_json, response_status, reservation_id)
         VALUES ($1,$2,$3::jsonb,$4,$5)`,
        [
          args.idempotencyKey,
          args.requestHashValue,
          JSON.stringify(args.body),
          201,
          args.id,
        ]
      );
    }
    await audit(tx, "hold_created", args.id, {
      restaurantId: args.restaurant.id,
      tableId: args.table.id,
      startsAt: args.startsAt.toISOString(),
      partySize: args.partySize,
      idempotencyKey: args.idempotencyKey,
    });
  } catch (err) {
    const code = pgErrorCode(err);
    if (code === EXCLUSION_VIOLATION || code === UNIQUE_VIOLATION) {
      // Lost a race (another hold took the interval, or another request with
      // the same idempotency key won). Abort and let the caller retry the
      // whole transaction from scratch — the DB remains the sole arbiter.
      throw new RaceRetry(code === EXCLUSION_VIOLATION ? "exclusion" : "unique");
    }
    throw err;
  }
}

// ── hold (POST /api/reservations) ────────────────────────────────────────────

export async function createHold(
  deps: ServiceDeps,
  input: HoldInput,
  idempotencyKey?: string | null
): Promise<{ status: number; body: ReservationBody }> {
  // Validation (400) — before touching the database.
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    throw new ApiError("VALIDATION_FAILED", "startsAt must be a valid ISO-8601 instant", {
      startsAt: input.startsAt,
    });
  }
  if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > MAX_PARTY) {
    throw new ApiError("VALIDATION_FAILED", `partySize must be an integer in [1, ${MAX_PARTY}]`, {
      partySize: input.partySize,
    });
  }
  if (!input.guest?.name?.trim() || !input.guest?.email?.includes("@")) {
    throw new ApiError("VALIDATION_FAILED", "guest.name and a valid guest.email are required");
  }
  const endsAt = new Date(startsAt.getTime() + DEFAULT_DURATION_MIN * 60_000);
  const now = deps.now?.() ?? new Date();
  const key = idempotencyKey?.trim() ? idempotencyKey.trim() : null;
  const hashValue = requestHash(input);

  for (let attempt = 1; attempt <= MAX_RACE_RETRIES; attempt++) {
    try {
      return await deps.db.transaction(async (tx) => {
        const restaurant = await getRestaurant(tx, input.restaurantId);

        // I4 — replay or reject before doing any work.
        if (key) {
          const found = await tx.query<{
            request_hash: string;
            response_json: unknown;
            response_status: number;
          }>(`SELECT request_hash, response_json, response_status
              FROM idempotency_records WHERE key = $1`, [key]);
          const rec = found.rows[0];
          if (rec) {
            if (rec.request_hash !== hashValue) {
              throw new ApiError(
                "DUPLICATE_IDEMPOTENCY_PAYLOAD",
                "This Idempotency-Key was already used with a different payload.",
                { idempotencyKey: key }
              );
            }
            const body = canonBody(
              typeof rec.response_json === "string"
                ? (JSON.parse(rec.response_json) as ReservationBody)
                : (rec.response_json as ReservationBody)
            );
            return { status: rec.response_status, body };
          }
        }

        // I5 — the reservation must fit inside one open service period.
        const period = await tx.query<{ id: string }>(
          `SELECT id FROM service_periods
           WHERE restaurant_id = $1
             AND starts_at_utc <= $2 AND ends_at_utc >= $3
           LIMIT 1`,
          [restaurant.id, startsAt.toISOString(), endsAt.toISOString()]
        );
        if (period.rows.length === 0) {
          throw new ApiError(
            "OUTSIDE_SERVICE_HOURS",
            "The requested time is outside the restaurant's service hours.",
            { startsAt: input.startsAt, durationMin: DEFAULT_DURATION_MIN }
          );
        }

        // I3 — candidate tables, smallest fitting first.
        const tables = await tx.query<TableRow>(
          `SELECT id, restaurant_id, label, capacity, min_party
           FROM dining_tables
           WHERE restaurant_id = $1 AND capacity >= $2 AND min_party <= $2
           ORDER BY capacity ASC, label ASC`,
          [restaurant.id, input.partySize]
        );
        if (tables.rows.length === 0) {
          throw new ApiError("PARTY_TOO_LARGE", "No table fits this party size.", {
            partySize: input.partySize,
          });
        }

        await sweepExpiredHolds(tx, restaurant.id, now);

        // Fast path: skip tables whose intervals already clash. The EXCLUDE
        // constraint remains the final arbiter if we guess wrong.
        for (const table of tables.rows) {
          const clash = await tx.query(
            `SELECT 1 FROM reservations
             WHERE table_id = $1 AND status IN ('held','confirmed')
               AND starts_at < $2 AND ends_at > $3
             LIMIT 1`,
            [table.id, endsAt.toISOString(), startsAt.toISOString()]
          );
          if (clash.rows.length > 0) continue;

          // Identity is generated BEFORE the body is built, so the stored
          // idempotency response carries the real id + confirmation code.
          const id = randomUUID();
          const code = confirmCode();
          const holdExpiresAt = new Date(now.getTime() + HOLD_TTL_MIN * 60_000);
          const provisional: ReservationRow = {
            id,
            restaurant_id: restaurant.id,
            table_id: table.id,
            party_size: input.partySize,
            starts_at: startsAt,
            ends_at: endsAt,
            status: "held",
            hold_expires_at: holdExpiresAt,
            guest_name: input.guest.name,
            guest_email: input.guest.email.toLowerCase(),
            guest_phone: input.guest.phone ?? null,
            confirm_code: code,
            created_at: now,
          };
          const body = canonBody(toBody(provisional, table, restaurant));
          await insertHold(tx, {
            restaurant,
            table,
            id,
            code,
            startsAt,
            endsAt,
            holdExpiresAt,
            now,
            partySize: input.partySize,
            guest: input.guest,
            idempotencyKey: key,
            requestHashValue: hashValue,
            body,
          });
          return { status: 201, body };
        }

        // Every candidate table clashed on the pre-check.
        throw new ApiError("SLOT_TAKEN", "That table was just taken.", {
          startsAt: input.startsAt,
        });
      });
    } catch (err) {
      if (err instanceof RaceRetry) {
        if (attempt === MAX_RACE_RETRIES) {
          throw new ApiError("SLOT_TAKEN", "That table was just taken.", {
            startsAt: input.startsAt,
          });
        }
        await sleep(5 + Math.random() * 20);
        continue;
      }
      throw err;
    }
  }
  throw new ApiError("SLOT_TAKEN", "That table was just taken.", { startsAt: input.startsAt });
}

// ── confirm (POST /api/reservations/:id/confirm) ─────────────────────────────

export async function confirmHold(
  deps: ServiceDeps,
  id: string
): Promise<{ status: number; body: ReservationBody }> {
  const now = deps.now?.() ?? new Date();
  return deps.db.transaction(async (tx) => {
    const joined = await tx.query<
      ReservationRow & {
        r_slug: string;
        r_name: string;
        r_tz: string;
        t_label: string;
        t_capacity: number;
      }
    >(
      `SELECT r.*, rst.slug AS r_slug, rst.name AS r_name, rst.timezone AS r_tz,
              t.label AS t_label, t.capacity AS t_capacity
       FROM reservations r
       JOIN restaurants rst ON rst.id = r.restaurant_id
       JOIN dining_tables t ON t.id = r.table_id
       WHERE r.id = $1`,
      [id]
    );
    const row = joined.rows[0];
    if (!row) {
      throw new ApiError("NOT_FOUND", "reservation not found", { id });
    }

    const restaurant: RestaurantRow = {
      id: row.restaurant_id,
      slug: row.r_slug,
      name: row.r_name,
      cuisine: "",
      timezone: row.r_tz,
      address: "",
    };
    const table: TableRow = {
      id: row.table_id,
      restaurant_id: row.restaurant_id,
      label: row.t_label,
      capacity: row.t_capacity,
      min_party: 1,
    };

    // I4-adjacent: confirming a confirmed reservation replays it (idempotent).
    if (row.status === "confirmed") {
      await audit(tx, "confirm_replayed", id, { confirmCode: row.confirm_code });
      return { status: 200, body: toBody(row, table, restaurant) };
    }

    if (row.status === "held") {
      const expired = row.hold_expires_at && new Date(row.hold_expires_at) < now;
      if (expired) {
        // I2 — expired holds are dead: transition, then 410.
        await tx.query(
          `UPDATE reservations SET status = 'expired', hold_expires_at = NULL, updated_at = $2
           WHERE id = $1`,
          [id, now.toISOString()]
        );
        await audit(tx, "hold_expired", id, { confirmCode: row.confirm_code });
        throw new ApiError("HOLD_EXPIRED", "This hold has expired.", {
          confirmCode: row.confirm_code,
        });
      }
      await tx.query(
        `UPDATE reservations SET status = 'confirmed', hold_expires_at = NULL, updated_at = $2
         WHERE id = $1`,
        [id, now.toISOString()]
      );
      await audit(tx, "confirmed", id, { confirmCode: row.confirm_code });
      const fresh = {
        ...row,
        status: "confirmed",
        hold_expires_at: null,
      } as ReservationRow;
      return { status: 200, body: toBody(fresh, table, restaurant) };
    }

    if (row.status === "expired") {
      // I2 — an expired hold can never be confirmed.
      throw new ApiError("HOLD_EXPIRED", "This hold has expired.", {
        confirmCode: row.confirm_code,
      });
    }

    // I6 — terminal states are terminal.
    throw new ApiError(
      "INVALID_TRANSITION",
      `Cannot confirm a reservation in status '${row.status}'.`,
      { id, status: row.status }
    );
  });
}

// ── cancel (POST /api/reservations/:id/cancel) ───────────────────────────────

export async function cancelReservation(
  deps: ServiceDeps,
  id: string
): Promise<{ status: number; body: ReservationBody }> {
  const now = deps.now?.() ?? new Date();
  return deps.db.transaction(async (tx) => {
    const joined = await tx.query<
      ReservationRow & { r_slug: string; r_name: string; r_tz: string; t_label: string; t_capacity: number }
    >(
      `SELECT r.*, rst.slug AS r_slug, rst.name AS r_name, rst.timezone AS r_tz,
              t.label AS t_label, t.capacity AS t_capacity
       FROM reservations r
       JOIN restaurants rst ON rst.id = r.restaurant_id
       JOIN dining_tables t ON t.id = r.table_id
       WHERE r.id = $1`,
      [id]
    );
    const row = joined.rows[0];
    if (!row) throw new ApiError("NOT_FOUND", "reservation not found", { id });

    if (row.status === "held" || row.status === "confirmed") {
      await tx.query(
        `UPDATE reservations SET status = 'cancelled', hold_expires_at = NULL, updated_at = $2
         WHERE id = $1`,
        [id, now.toISOString()]
      );
      await audit(tx, "cancelled", id, { confirmCode: row.confirm_code, from: row.status });
      const fresh = { ...row, status: "cancelled" } as ReservationRow;
      return {
        status: 200,
        body: toBody(fresh, {
          id: row.table_id,
          restaurant_id: row.restaurant_id,
          label: row.t_label,
          capacity: row.t_capacity,
          min_party: 1,
        }, {
          id: row.restaurant_id,
          slug: row.r_slug,
          name: row.r_name,
          cuisine: "",
          timezone: row.r_tz,
          address: "",
        }),
      };
    }

    // I6 — terminal states are terminal.
    throw new ApiError(
      "INVALID_TRANSITION",
      `Cannot cancel a reservation in status '${row.status}'.`,
      { id, status: row.status }
    );
  });
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function getReservation(
  deps: ServiceDeps,
  id: string
): Promise<ReservationBody | null> {
  const joined = await deps.db.query<
    ReservationRow & { r_slug: string; r_name: string; r_tz: string; t_label: string; t_capacity: number }
  >(
    `SELECT r.*, rst.slug AS r_slug, rst.name AS r_name, rst.timezone AS r_tz,
            t.label AS t_label, t.capacity AS t_capacity
     FROM reservations r
     JOIN restaurants rst ON rst.id = r.restaurant_id
     JOIN dining_tables t ON t.id = r.table_id
     WHERE r.id = $1`,
    [id]
  );
  const row = joined.rows[0];
  if (!row) return null;
  return toBody(row, {
    id: row.table_id,
    restaurant_id: row.restaurant_id,
    label: row.t_label,
    capacity: row.t_capacity,
    min_party: 1,
  }, {
    id: row.restaurant_id,
    slug: row.r_slug,
    name: row.r_name,
    cuisine: "",
    timezone: row.r_tz,
    address: "",
  });
}

export async function getReservationByCode(
  deps: ServiceDeps,
  code: string
): Promise<ReservationBody | null> {
  const joined = await deps.db.query<{ id: string }>(
    `SELECT id FROM reservations WHERE confirm_code = $1`,
    [code.trim().toUpperCase()]
  );
  const row = joined.rows[0];
  if (!row) return null;
  return getReservation(deps, row.id);
}

export async function listReservationsByEmail(
  deps: ServiceDeps,
  email: string
): Promise<ReservationBody[]> {
  const joined = await deps.db.query<
    ReservationRow & { r_slug: string; r_name: string; r_tz: string; t_label: string; t_capacity: number }
  >(
    `SELECT r.*, rst.slug AS r_slug, rst.name AS r_name, rst.timezone AS r_tz,
            t.label AS t_label, t.capacity AS t_capacity
     FROM reservations r
     JOIN restaurants rst ON rst.id = r.restaurant_id
     JOIN dining_tables t ON t.id = r.table_id
     WHERE r.guest_email = $1
     ORDER BY r.starts_at ASC`,
    [email.toLowerCase()]
  );
  return joined.rows.map((row) =>
    toBody(row, {
      id: row.table_id,
      restaurant_id: row.restaurant_id,
      label: row.t_label,
      capacity: row.t_capacity,
      min_party: 1,
    }, {
      id: row.restaurant_id,
      slug: row.r_slug,
      name: row.r_name,
      cuisine: "",
      timezone: row.r_tz,
      address: "",
    })
  );
}
