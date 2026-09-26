# Tablekeeper — Build Plan

**Track:** 🍽️ tablekeeper — "a restaurant reservation system, like OpenTable"
**Event:** Dark Factory — WeAreDevelopers x BAND (online build Sept 26 – Oct 5, 2026; close 23:59 PDT Oct 5)
**The hard part:** a table must never be double-booked.
**Team method:** a band of coding agents (BAND Desktop) plans work, implements, hands off evidence, checks its own results — with ShipScore as the always-on quality gate.

---

## 0. Winning strategy (one paragraph)

Most teams will demo a CRUD booking app that works when clicked politely.
Judges for this track were told the hard part is concurrency: tables, times,
retries, time zones. Our submission leads with **correctness as a
database-guaranteed invariant** (a partial exclusion constraint makes
double-booking physically impossible), **proves it** with a 10-test
adversarial concurrency suite in CI (50-way races, hold-expiry races, DST
boundaries), and **shows the factory checking its own results** via ShipScore
gates on every PR plus an evidence trail (plan → diff → test result → review).
The demo ends with two phones racing for the last table: exactly one wins.

---

## 1. Product scope (MVP)

**In scope**

| Feature | Notes |
|---|---|
| Discover | List/search restaurants by name/cuisine; show capacity, hours, timezone |
| Availability | For `restaurant + date + party size`: bookable start times with free-table counts |
| Hold | Pin a table for 10 minutes (TTL) — the anti-double-booking primitive |
| Book / Confirm | Confirm a hold within TTL → `confirmed` reservation + confirmation code |
| Cancel | Guest-initiated; frees the slot instantly (terminal state) |
| My bookings | Lookup by email or confirmation code (no auth system — deliberate) |
| Seeded content | 6 restaurants across 3 time zones (one deliberately in a DST-relevant zone) |

**Explicitly out of scope (say it in the README before judges ask):**
accounts/auth (guest fields + confirmation codes instead), real payments,
emails/SMS (log + fake outbox), reviews, admin UI (staff transitions via API only).

**Non-goals that protect the invariant story:** no walk-in editing, no
table-merging, no overbooking heuristic. Every feature that touches time
either preserves I1–I7 or doesn't ship.

---

## 2. Data model

### 2.1 Entity overview

```
Restaurant 1──* DiningTable
Restaurant 1──* ServicePeriod        (one row per date per meal service)
Restaurant 1──* Reservation  *──1 DiningTable
Reservation 1──1 IdempotencyRecord   (via unique key, see §3/I4)
Restaurant/Reservation → AuditEvent  (append-only evidence log)
```

### 2.2 Schema (Prisma draft — Postgres)

```prisma
model Restaurant {
  id        String   @id @default(cuid())
  name      String
  cuisine   String
  timezone  String                     // IANA, e.g. "America/New_York"
  address   String
  tables    DiningTable[]
  periods   ServicePeriod[]
  reservations Reservation[]
}

model DiningTable {
  id            String  @id @default(cuid())
  restaurantId  String
  restaurant    Restaurant @relation(fields: [restaurantId], references: [id])
  label         String              // "T1", "Patio 3"
  capacity      Int                 // max party size at this table
  minParty      Int     @default(1)
  reservations  Reservation[]

  @@index([restaurantId, capacity])
}

model ServicePeriod {
  id           String @id @default(cuid())
  restaurantId String
  restaurant   Restaurant @relation(fields: [restaurantId], references: [id])
  date         DateTime @db.Date      // the LOCAL calendar date of the restaurant
  meal         String                  // "lunch" | "dinner"
  startLocal   String                  // "18:00" local wall time
  endLocal     String                  // "23:00" local wall time
  // UTC window is DERIVED from (date, startLocal/endLocal, restaurant.timezone)
  // and materialized at seed time — see §3/I5 and the DST test in §5.

  @@unique([restaurantId, date, meal])
}

model Reservation {
  id            String   @id @default(cuid())
  restaurantId  String
  restaurant    Restaurant @relation(fields: [restaurantId], references: [id])
  tableId       String
  table         DiningTable @relation(fields: [tableId], references: [id])
  partySize     Int
  startsAt      DateTime               // UTC (timestamptz)
  endsAt        DateTime               // UTC; startsAt < endsAt, default 90 min
  status        String                 // held | confirmed | seated | cancelled | no_show
  holdExpiresAt DateTime?              // set for held; NULL otherwise
  guestName     String
  guestEmail    String
  guestPhone    String?
  confirmCode   String   @unique @default(cuid())
  idempotencyKey String? @unique
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([tableId, startsAt])
  @@index([restaurantId, startsAt])
  @@index([guestEmail])
}
```

### 2.3 The constraint that IS the invariant (raw SQL migration)

Prisma cannot express exclusion constraints — add one raw migration. This is
the single most important line of the whole project:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- (idempotent; also in CI workflow)

ALTER TABLE "Reservation" ADD CONSTRAINT reservation_no_overlap
EXCLUDE USING gist (
  "tableId" WITH =,
  tstzrange("startsAt", "endsAt", '[)') WITH &&
) WHERE (status IN ('held', 'confirmed'));
```

- `EXCLUDE USING gist … WITH &&` — rejects any two active rows on the same
  table whose half-open intervals `[startsAt, endsAt)` intersect.
- `WHERE (status IN ('held','confirmed'))` — partial: cancelled/seated rows
  stop occupying space the instant they're terminal.
- Half-open `[)` intervals: a reservation 18:00–19:30 and another starting
  19:30 do **not** conflict (turnover is instant, tested in §5/T8).
- Attempted violations fail at the DB with error `23P01`
  (`exclusion_violation`) — the API maps it to `409 SLOT_TAKEN`.

**Why intervals, not precomputed slots?** Slot grids hide the invariant
("just don't book the same slot twice") and fall apart for variable dining
durations. Intervals make the conflict condition first-class and let the
database enforce it. Availability slots are still *presented* on a 15-min
grid — but computed from interval math, not stored.

**Local dev without Postgres:** SQLite + `BEGIN IMMEDIATE` transactions with
an overlap `SELECT` inside the transaction — implemented as a fallback
adapter for unit tests only. CI and prod always run Postgres, where the
constraint itself is the guarantee. (Never claim correctness from the app
layer when the DB can provide it.)

---

## 3. Invariants (the contract the band must defend)

| # | Invariant | Enforcement layer |
|---|---|---|
| **I1** | No two reservations with `status ∈ {held, confirmed}` on the same `tableId` have overlapping `[startsAt, endsAt)` | **DB exclusion constraint** (§2.3) + `23P01 → 409` mapping |
| **I2** | An expired hold is invisible: it blocks nothing and can never be confirmed | Lazy rule: every availability query and `confirm` filters/transitions on `holdExpiresAt < now()`; `confirm` past TTL → `410 HOLD_EXPIRED`. No sweeper needed for correctness |
| **I3** | `partySize ≤ table.capacity` (and `≥ table.minParty`) | Table assignment only picks qualifying tables + app check + test |
| **I4** | Retries never double-book: same `Idempotency-Key` + same payload → same response replayed; same key + different payload → `422` | `idempotencyKey` unique index + stored response replay |
| **I5** | Every reservation fits inside one open `ServicePeriod` of its restaurant (in restaurant-local time) | App validation against the materialized UTC window + test; DST covered in §5/T10 |
| **I6** | Terminal states are terminal: `cancelled/seated/no_show` never transition again | State machine in code; `cancel` on terminal → `409 INVALID_TRANSITION` |
| **I7** | Conflicts are scoped per-table, never per-restaurant or global | `tableId` is the only exclusion key; cross-table independence tested in §5/T7 |

**Rule for the band:** any PR that touches booking paths must state in the
description which of I1–I7 it affects and why they still hold. ShipScore's
review + the invariant suite are the check; the PR template has the checklist.

---

## 4. API surface

All endpoints under `/api`, JSON, UTC ISO-8601 timestamps in responses
(+ restaurant-local wall time for display). Errors follow one shape:

```json
{ "error": { "code": "SLOT_TAKEN", "message": "That table was just taken.",
             "details": { "tableId": "…", "startsAt": "…" } } }
```

Error codes: `SLOT_TAKEN (409)` · `HOLD_EXPIRED (410)` ·
`INVALID_TRANSITION (409)` · `PARTY_TOO_LARGE (422)` ·
`OUTSIDE_SERVICE_HOURS (422)` · `DUPLICATE_IDEMPOTENCY_PAYLOAD (422)` ·
`NOT_FOUND (404)` · `VALIDATION_FAILED (400)`.

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /api/restaurants?query=&party=` | Discover | name/cuisine match, min capacity |
| `GET /api/restaurants/:id` | Detail + hours | includes timezone + service periods |
| `GET /api/restaurants/:id/availability?date=YYYY-MM-DD&party=2` | Bookable grid | local date; returns 15-min slots: `{ startsAtUTC, localWall, freeTables }`; expired holds never counted (I2) |
| `POST /api/reservations` | Hold a table | body `{ restaurantId, startsAt, partySize, guest{name,email,phone?} }`; header `Idempotency-Key`; server picks smallest fitting free table (I3); returns `201 {id, status:"held", holdExpiresAt, table, confirmCode}` · `409 SLOT_TAKEN` |
| `POST /api/reservations/:id/confirm` | Hold → confirmed | idempotent; `410` past TTL (I2); `200` returns final reservation |
| `POST /api/reservations/:id/cancel` | Terminal cancel | frees slot instantly (partial constraint, I1); `409` if terminal (I6) |
| `GET /api/reservations/:id` | Status lookup | or `GET /api/reservations?email=` for guest list |
| `GET /api/health` | Liveness + invariant self-check | DB ping, constraint present check |

**Concurrency contract for writes:** hold/confirm/cancel run in a single
transaction; on Postgres the exclusion constraint is the final arbiter — the
app never "checks then writes" without the constraint behind it.

---

## 5. Adversarial test suite — `npm run test:invariants`

The suite that earns the track's respect. Real Postgres (CI service
container), real parallelism (`Promise.all` with N workers), no mocks.

| # | Test | Expected |
|---|---|---|
| T1 | **50-way race**: 50 concurrent holds on the same table/slot | exactly 1× `201`, 49× `409`; exactly 1 row in DB |
| T2 | Two clients hold → hold A expires → B books, A tries confirm | B `201`; A `410 HOLD_EXPIRED` (I2) |
| T3 | Cancel-vs-confirm race on the same hold (simultaneous) | exactly one of the two succeeds; reservation ends in a consistent terminal/confirmed state (I6) |
| T4 | Retry storm: same `Idempotency-Key` sent 20× in parallel | exactly 1 reservation; all 20 responses identical (I4) |
| T5 | Same key, different payload | `422 DUPLICATE_IDEMPOTENCY_PAYLOAD` (I4) |
| T6 | Overlapping intervals, different tables | both `201` — cross-table independence (I7) |
| T7 | Party of 6 at a 4-top → assignment skips it | smallest fitting table chosen; `PARTY_TOO_LARGE` if none (I3) |
| T8 | Adjacent intervals: 18:00–19:30 and 19:30–21:00, same table | both `201` — half-open `[)` correctness (I1) |
| T9 | Booking outside service hours / across two periods | `422 OUTSIDE_SERVICE_HOURS` (I5) |
| T10 | **DST boundary**: restaurant in `America/New_York`, service 18:00–23:00 local on the fall-back date | UTC window shifts by 1h vs. a normal day; both dates accept bookings exactly inside the derived window; nothing double-booked (I5 + I1) |

Plus T11 (soak): 500 random ops (holds/cancels/confirms over random tables)
end with a DB-level audit query proving zero overlaps — the invariant
re-verified from the data, not the code.

---

## 6. Demo flows (scripted for the video + live Q&A)

**Flow A — the happy path (~60 s).** Search "sushi" → pick restaurant →
availability grid for Friday 19:00, party 2 → hold → confirm → confirmation
code → "My bookings" shows it. Mention timezone display (NY restaurant, PST
viewer).

**Flow B — the kill demo (~90 s, the one that wins).** Two browser windows
side by side, same restaurant, last table at 20:00. Click "Book" in both
simultaneously. One gets a confirmation; the other gets a clean `409
SLOT_TAKEN` card. Then the terminal: `psql` running the overlap audit query
against prod — zero rows. "The database refused; the app just translated."
Fallback if wifi dies: the identical race replayed with `hey`/`autocannon`
against localhost — same verdict.

**Flow C — the factory story (~60 s).** GitHub repo → a real PR where
ShipScore's gate commented a score and CI ran the invariant suite (green);
show the ratchet policy (60→70→75); show `docs/EVIDENCE.md`. "The band
checks its own results — here's the evidence trail."

---

## 7. Work packages (band-ready, with evidence handoff)

Kickoff Sept 26, 09:00 PDT · freeze Oct 4 evening · Oct 5 = submission buffer.

| WP | Window | Deliverable | Evidence (handoff artifact) |
|---|---|---|---|
| **W1 scaffold** | Sep 26 | Repo (this scaffold) + Next.js app skeleton + Prisma schema + **migration §2.3** + CI green + ShipScore gate commenting | CI run links; migration reviewed in PR; first score comment |
| **W2 availability engine** | Sep 27 | Pure functions: local date → UTC window; slot math; I5 validation; unit tests | test report; TZ decision note (date-fns-tz) |
| **W3 booking core** | Sep 28 | hold/confirm/cancel + idempotency middleware + `23P01 → 409` mapping | API contract tests; error-shape doc |
| **W4 invariant proof** | Sep 29 | T1–T11 green in CI (Postgres service) | **the milestone screenshot**: 11/11 concurrency tests |
| **W5 frontend** | Sep 30 | Search, availability grid, hold/confirm UX, my bookings; threshold ratchets to **70** | ShipScore ≥ 70 on the PR; Lighthouse pass |
| **W6 deploy + seed** | Oct 1 | Vercel + Neon prod branch; 6 restaurants / 3 time zones incl. DST-zone; `/api/health` self-check | live URL; health endpoint output |
| **W7 evidence + video** | Oct 2 | `docs/EVIDENCE.md`, demo video (3 flows), README case-study draft; threshold **75** | video; EVIDENCE.md; scoreboard |
| **W8 red-team + freeze** | Oct 3–4 | Band attacks its own system (new adversarial attempts); fix or document; freeze | red-team log; final scores |

**Band methodology mapping (BAND Desktop):** each WP = one plan packet (this
doc's section + acceptance criteria) → implementer agent produces diff →
checker agent runs the evidence step (tests/score) → reviewer agent signs
with findings → merge only with green gate. The evidence column is the
handoff — no "done" without it.

---

## 8. ShipScore gate — wiring & ratchet policy

Already wired in this scaffold (`.github/workflows/shipscore-gate.yml`):

```yaml
- uses: ./tools/shipscore        # local path — zero external dependencies
  with:
    threshold: 60                # ratchet: 60 → 70 (W5) → 75 (W7)
    categories: design,ship,run,secure,test
```

- **Why it matters for this track:** the event brief rewards factories that
  "check their own results." The gate + scoreboard + PR comments are that
  claim made visible, on every PR, from commit one.
- **Ratchet policy** shows discipline: quality floor only rises during the
  build; it never drops to let a PR through.
- Vendored tooling is **clearly labeled pre-existing infrastructure**
  (`tools/shipscore/README.md`); the product in `app/` is clean-room, written
  during the window by the band. This distinction is stated up front —
  transparency is part of the evidence story.

---

## 9. Case-study prep (the winners' format, pre-drafted)

| Field | Draft (fill as we go) |
|---|---|
| **The task** | Clean-room OpenTable clone where a table can never be double-booked — concurrency, retries, time zones |
| **The band** | `<agents used, roles: planner/implementer/checker/reviewer>` |
| **Key design decision** | Half-open interval model + partial EXCLUDE constraint in Postgres: correctness moved from app conventions into the database; expired holds handled lazily so no sweeper can race the booking path |
| **The verified result** | T1–T11 green in CI incl. 50-way race (1 winner of 50); live kill-demo (two browsers, one 409); ShipScore floor 75 |
| **The cost** | `<BAND/compute/clock time — track from W1>` |
| **The limitation** | No auth (guest codes), single-region deploy, no table merging, notifications fake — deliberate MVP cuts, each mapped to a non-goal |

---

## 10. Amendments & status log

**A1 — SQL layer instead of Prisma (2026-09-27, W1).** The data layer is
hand-rolled SQL behind a small `SqlClient` interface (`app/src/lib/db/`),
not Prisma. Rationale: the whole product hinges on one exact constraint
(§2.3) and on a Postgres-exact test engine; an ORM adds indirection over the
one line that matters and cannot run against PGlite. The §2.2 Prisma draft
was implemented 1:1 as DDL in `app/db/schema.sql`.

**A2 — PGlite replaces the SQLite fallback (2026-09-27, W1).** §2.3's
"local dev without Postgres" fallback (SQLite + `BEGIN IMMEDIATE` + overlap
SELECT) is superseded: we verified PGlite (embedded Postgres 17, WASM) loads
`btree_gist` from its `contrib/` bundle, so the **exact** `EXCLUDE USING
gist` constraint, the `23P01` error code, and interactive transactions run
identically locally and in CI. One dialect, two engines:
`DATABASE_URL=postgres://…` → node-postgres (CI postgres:16, Neon prod);
unset → PGlite. The SQLite adapter will never be needed.

**A3 — T3 semantics refined (2026-09-27, W4).** Cancelling a *confirmed*
reservation is legal product behavior (guest changes their mind), so the
original T3 wording ("exactly one of the two succeeds") is wrong under our
state machine. The invariant T3 now asserts: whatever the interleaving of
confirm/cancel, the final status is a legitimate outcome of the executed
order (confirm→cancel both succeed → `cancelled`; cancel first → confirm
bounces `INVALID_TRANSITION`), and no unhandled error ever surfaces.

**Status 2026-09-27 (W1–W4 executed by the band):**

- `app/` Next.js 16 + TypeScript: booking core, availability engine, 9 API
  routes, minimal landing page, `ensureReady()` boot (migrate + seed-if-empty)
- Schema with `reservation_no_overlap` EXCLUDE constraint + idempotency +
  audit tables (`app/db/schema.sql`)
- Seed: 7 restaurants / 4 time zones incl. DST-zone NY, next 14 days +
  2026-10-31 / 2026-11-01 (T10 arena), incl. one single-table restaurant
  (`rst_counter`) as the kill-demo arena
- **T1–T11 green locally on PGlite (28/28 tests)**; CI (postgres:16) proves
  true-parallelism on first push
- CI updated: `npm run db:migrate` (A1) replaces prisma migrate
- ShipScore gate unchanged (vendored `./tools/shipscore`, ratchet 60→70→75)
