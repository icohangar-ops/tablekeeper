# 🍽️ Tablekeeper

A clean-room clone of a restaurant reservation system (think OpenTable),
built for **Dark Factory** — the WeAreDevelopers x BAND hackathon
(Sept 26 – Oct 5, 2026).

The twist: this product is **built by a band of coding agents** (BAND Desktop)
that plans work, implements it, hands off evidence, and checks its own
results. The "check its own results" part is real infrastructure:
[ShipScore](../tools/shipscore) scores every PR across Design, Ship, Run,
Secure, Test and blocks the merge below threshold.

## The hard part

> A table must never be double-booked.

We treat that as a **database-guaranteed invariant**, not a coding convention:
a partial `EXCLUDE` constraint on `tstzrange(starts_at, ends_at)` makes
overlapping bookings for the same table physically impossible — then an
11-test adversarial concurrency suite tries its best to break it anyway
(50-way booking races, hold-expiry races, cancel-vs-confirm, DST boundaries,
idempotent retry storms).

```sql
ALTER TABLE reservations ADD CONSTRAINT reservation_no_overlap
EXCLUDE USING gist (
  table_id WITH =,
  tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status IN ('held','confirmed'));
```

- Build plan: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md)
- Invariants: [`docs/BUILD_PLAN.md` §3](docs/BUILD_PLAN.md)
- Time-zone decision: [`app/docs/TZ_DECISION.md`](app/docs/TZ_DECISION.md)
- Evidence / case study: `docs/EVIDENCE.md` (wip)

## Status

| WP | Scope | State |
|---|---|---|
| W1 | Scaffold + schema + invariant migration + CI | ✅ done |
| W2 | Availability engine (TZ/slot math, I5) | ✅ done |
| W3 | Booking core (hold/confirm/cancel, idempotency, 23P01→409) | ✅ done |
| W4 | Invariant proof T1–T11 | ✅ green locally (PGlite) · CI proof on push |
| W5–W8 | Frontend, deploy, evidence pack, red-team | ⏳ per plan |

## Quickstart

```bash
cd app
npm install

# No DATABASE_URL? You get an embedded Postgres 17 (PGlite/WASM):
npm run db:migrate     # applies db/schema.sql (idempotent) + verifies constraint
npm run db:seed        # 6 restaurants / 4 time zones, next 14 days + DST dates
npm run dev            # http://localhost:3100

# Tests
npm test               # unit: tz + slot math
npm run test:invariants # T1–T11 adversarial suite (embedded Postgres)
npm run typecheck && npm run lint
```

Set `DATABASE_URL=postgres://…` (CI service / Neon) and the exact same SQL
runs against a real server — one dialect, two engines.

## The API (BUILD_PLAN §4)

| Method & path | Purpose |
|---|---|
| `GET /api/restaurants?query=&party=` | discover |
| `GET /api/restaurants/:id` | detail + hours |
| `GET /api/restaurants/:id/availability?date=YYYY-MM-DD&party=2` | 15-min grid |
| `POST /api/reservations` (+ `Idempotency-Key`) | hold a table |
| `POST /api/reservations/:id/confirm` | hold → confirmed |
| `POST /api/reservations/:id/cancel` | terminal cancel |
| `GET /api/reservations/:id` · `GET /api/reservations?email=` / `?code=` | lookup |
| `GET /api/health` | liveness + **invariant self-check** |
| `GET /api/audit?limit=50` | append-only evidence log |

Errors: one shape — `{ "error": { "code", "message", "details?" } }` — with
`SLOT_TAKEN (409)` · `HOLD_EXPIRED (410)` · `INVALID_TRANSITION (409)` ·
`PARTY_TOO_LARGE (422)` · `OUTSIDE_SERVICE_HOURS (422)` ·
`DUPLICATE_IDEMPOTENCY_PAYLOAD (422)` · `NOT_FOUND (404)` ·
`VALIDATION_FAILED (400)`.

## The kill demo

```bash
npm run dev            # terminal 1
npm run attack -- 10   # terminal 2: 10 racers, one table → 1×201, 9×409
```
