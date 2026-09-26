# Evidence pack — how the factory proves its work

Dark Factory's thesis: agents don't just produce features, they **hand off
verifiable evidence** that the features hold. This file is the running
evidence log for the tablekeeper build. Everything cited here is reproducible
from the repo.

## 1 · The claim

> A table can never be double-booked — not by races, not by retries, not by
> clock skew, not by two guests hitting the same button in the same
> millisecond.

## 2 · Enforcement layers (defense in depth)

| # | Layer | Mechanism | Fails with |
|---|---|---|---|
| I1 | **Storage** | Partial `EXCLUDE USING gist (table_id =, tstzrange(starts_at, ends_at, '[)') &&) WHERE status IN ('held','confirmed')` + `btree_gist` | SQLSTATE `23P01` → API maps to `409 SLOT_TAKEN` |
| I2 | **Time-to-live** | Lazy in-transaction sweep expires `held` rows past TTL before any availability decision; confirm checks TTL | `410 HOLD_EXPIRED` |
| I3 | **Selection** | Smallest-fitting-table candidate loop inside the same transaction | `409` |
| I4 | **Idempotency** | `idempotency_records` keyed by client key; replay returns the original body byte-identically (canonicalized JSON) | same payload → `200` replay · different payload → `422 DUPLICATE_IDEMPOTENCY_PAYLOAD` |
| I5 | **Service hours** | Reservation interval must fit one materialized service period (DST-aware UTC windows) | `422 OUTSIDE_SERVICE_HOURS` |
| I6 | **State machine** | held → confirmed → (cancelled/seated) is one-way; terminal rows are exempt from the constraint (slot freed instantly) | `409` on invalid transitions |
| — | **Boot** | Schema + seed applied under `pg_advisory_xact_lock` — concurrent serverless cold starts serialize | — |

The decisive property: **the app cannot override I1**. Even a bug that skips
every check above still hits the storage engine's refusal.

## 3 · Adversarial proof (T-suite, 28/28 green)

Run locally on embedded Postgres 17 (PGlite) and in CI on real postgres:16.

| Test | Attack | Expected | State |
|---|---|---|---|
| T1 | 50 concurrent holds, one table/slot | 1×201, 49×409, exactly 1 row | ✅ |
| T2 | hold expires → slot rebooked → original confirms | 410 HOLD_EXPIRED | ✅ |
| T3 | simultaneous confirm+cancel | consistent terminal state either way | ✅ |
| T4 | same idempotency key ×20 parallel | 1 reservation, 20 identical bodies | ✅ |
| T5 | same key, different payload | 422 DUPLICATE_IDEMPOTENCY_PAYLOAD | ✅ |
| T6 | same interval, different tables | both 201 | ✅ |
| T7 | cancel frees slot instantly | rebook 201 | ✅ |
| T8 | boundary adjacency 18:00–19:30 vs 19:30–21:00 | both 201; 19:15 overlap → 409 | ✅ |
| T9 | interval outside/overrunning service hours | 422 OUTSIDE_SERVICE_HOURS | ✅ |
| T10 | DST fall-back day (2026-11-01, America/New_York) | slots exist once, wall times coherent | ✅ |
| T11 | soak: repeated mixed storm | invariant holds, audit consistent | ✅ |
| unit | tz math, slots, canon, service rules | 17/17 | ✅ |

CI reproduces the suite on every push: `app → GitHub Actions → CI` workflow
(postgres:16 service container, `btree_gist` enabled, migrate → lint → unit →
invariants → typecheck).

## 4 · Live kill demo

`/kill-demo` fires N real parallel HTTP requests (distinct idempotency keys,
as distinct clients) at the single table of The Chef's Counter.

Latest local run through the dev server (Sept 26, 2026):

```
12 racers → VERDICT: {201: 1, 409: 11}
```

The UI computes the verdict live and offers confirm-winner / re-arm, so the
demo can be repeated endlessly on camera.

## 5 · The factory checking itself (ShipScore)

- `tools/shipscore` vendors the ShipScore action (same engine as
  shipscore-gamma.vercel.app) — **wired into CI from the very first commit**.
- Gate policy ratchets: W1–W4 ≥ 60 → W5–W6 ≥ 70 → W7+ ≥ 75 (BUILD_PLAN §8).
- Official runner verdict on the current head: **ShipScore 100/100 (A)**,
  rubric 1.0.0, categories design/ship/run/secure/test (see workflow log:
  "ShipScore gate").
- Honesty note: the first gate run **failed** (vendored CLI path bug). The fix
  (`55c3f9e`) is itself part of the record — the gate earning its keep on day
  one is the best evidence it gates anything.

## 6 · Red-team pass (W8, pre-deploy)

`app/scripts/redteam.mjs` — 9 adversarial probes over the live HTTP surface of
a fresh production build (no test fixtures, no in-process shortcuts; real
fetches against `next start`). Report artifact: `app/scripts/redteam-report.json`.

| Probe | Attack | Result |
|---|---|---|
| RT1 | 50 concurrent bookers, distinct keys, one table | 1×201 + 49×409 SLOT_TAKEN |
| RT2 | 12-way stampede, SAME idempotency key + payload | 12×201, one reservation id (I4 holds under a stampede) |
| RT3 | same key, different payload | 422 DUPLICATE_IDEMPOTENCY_PAYLOAD |
| RT4a | double confirm | 200 + 200, identical confirm code (idempotent) |
| RT4b | confirm after terminal cancel | 409 INVALID_TRANSITION |
| RT5 | confirm-vs-cancel race | one coherent terminal state, no 5xx |
| RT6 | back-to-back seatings (end == start) vs 30-min overlap | adjacency 201/201, overlap 409 |
| RT7 | fuzz battery: party 0/-3/99/"two", garbage date, past date, unknown restaurant, missing guest, malformed JSON, 3 am slot | 10/10 answered 4xx — zero 5xx |
| RT8 | health self-check + audit feed | constraintPresent=true, audit events logged |

**Verdict: RED TEAM FAILED TO BREAK IT (9/9).**

Honesty note: the first draft of RT6 "failed" — adjacent bookings appeared to
be rejected. Investigation (audit-trail replay) showed the probes assumed
60-minute slots, while `DEFAULT_DURATION_MIN = 90`: the "adjacent" slots
actually overlapped by 30 minutes, so 409 was the *correct* answer and the
invariant layer was more precise than the red team. With 90-minute-aware
placement, true adjacency (end == start) is accepted — back-to-back seatings
work, which is exactly the `[)` range semantics the DB constraint encodes.

Rebuild note: the suite was re-provisioned from its spec (sandbox reset wiped
the local copy) and the re-run reproduced the same class of lesson — the first
re-run scored 7/9, and both "failures" (RT3, RT4b) were probe bugs again: the
probes were booking over each other on the one-table arena (RT3 used a fresh
key on a slot RT2 had just taken; RT4b requested a slot RT4a had already
confirmed). The product answered 409/404 *correctly* in both cases. The suite
now walks the live availability feed and reserves non-overlapping windows per
probe (RT3 reuses RT2's recorded idempotency key); clean run: 9/9.

## 7 · Reproduce everything

```bash
cd app
npm install
npm run test:all        # 28/28 — unit + T1–T11 adversarial + soak
npm run dev             # http://localhost:3100
npm run attack          # scripted kill-demo against the running server
TK_BASE_URL=http://localhost:3100 npm run redteam   # 9-probe red-team pass
curl localhost:3100/api/health   # invariant self-check
curl localhost:3100/api/audit?limit=20   # append-only evidence feed
```
