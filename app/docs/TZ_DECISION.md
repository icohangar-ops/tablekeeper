# Time-zone handling — decision note (W2 evidence)

**Decision:** hand-rolled, zero-dependency `Intl.DateTimeFormat` (ICU) math in
`src/lib/time/tz.ts`, instead of the previously assumed `date-fns-tz`.

## Why not date-fns-tz?

| Criterion | Intl (chosen) | date-fns-tz |
|---|---|---|
| Dependency footprint | none — ships with Node 20+/every browser | + a dependency (and `date-fns`) |
| DST correctness | same ICU tzdata Node itself uses | same tzdata, wrapped |
| Auditability | ~90 lines, fully in-repo, unit-tested | black-box to reviewers |
| Serverless size | zero cost | extra bundle weight |

The booking engine only needs three operations: wall→UTC, UTC→wall, and
offset-at-instant. That surface is small enough that owning the code is
cheaper — and more defensible to judges — than importing a library.

## The rules the engine enforces

1. **All persistence is UTC** (`timestamptz`). Wall time exists only at the
   edges: materializing service-period windows (seed/insert) and rendering
   labels.
2. **Service-period windows are materialized per date** at write time
   (`periodUtcWindow`). DST shifts are therefore baked into each date's row —
   the NY fall-back date (2026-11-01) legitimately stores a UTC window one
   hour later than the day before (proven by T10).
3. **wallToUtc converges** over DST transitions (two offset passes; a third
   kept for paranoia).
4. **Nonexistent wall times** (spring-forward gap, e.g. 02:30 that never
   happens) resolve to the closest instant after the gap; **ambiguous** times
   (fall-back repeat) resolve to the first occurrence. Restaurant service
   hours (11:00–23:00) never intersect either window — the behavior is
   documented and locked by tests, not left to chance.

## Evidence

- `tests/unit/tz.test.ts` — 11 assertions: EDT/EST offsets, Tokyo
  (no DST), the 2026-11-01 US fall-back boundary, wall→UTC→wall round-trips
  across three zones, malformed-input rejection.
- `tests/invariants.test.ts` T10 — NY fall-back date: 19:00 EDT Oct 31 =
  23:00Z vs 19:00 EST Nov 1 = 00:00Z (next UTC day); both book on the same
  physical table 25 absolute hours apart with zero overlap.
