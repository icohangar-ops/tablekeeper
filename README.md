# 🍽️ Tablekeeper

A clean-room clone of a restaurant reservation system (think OpenTable),
built for **Dark Factory** — the WeAreDevelopers x BAND hackathon
(Sept 26 – Oct 5, 2026).

The twist: this product is **built by a band of coding agents** (BAND Desktop)
that plans work, implements it, hands off evidence, and checks its own
results. The "check its own results" part is real infrastructure:
[ShipScore](tools/shipscore) scores every PR across Design, Ship, Run,
Secure, Test and blocks the merge below threshold.

## The hard part

> A table must never be double-booked.

We treat that as a **database-guaranteed invariant**, not a coding convention:
a partial `EXCLUDE` constraint on `tstzrange(starts_at, ends_at)` makes
overlapping bookings for the same table physically impossible — then a
10-test adversarial concurrency suite tries its best to break it anyway
(50-way booking races, hold-expiry races, cancel-vs-confirm, DST boundaries,
idempotent retry storms).

- Build plan: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md)
- Invariants: [`docs/BUILD_PLAN.md` §3](docs/BUILD_PLAN.md)
- Evidence / case study: `docs/EVIDENCE.md` (wip)

## Status

🏗️ Scaffold phase — plan + CI + quality gate. Product code lands as the band
executes work packages W1–W8 (see build plan).
