# tablekeeper — submission assets

Dark Factory hackathon (WeAreDevelopers × BAND · lablab.ai · tablekeeper track).

| File | What it is |
|---|---|
| `tablekeeper-demo-3min.mp4` | 3-minute demo video (180.0 s, 1600×900, h264+AAC). Live `/kill-demo` 50-way race, SQL invariant walkthrough, hold→confirm flow, 9-probe red-team segment. |
| `tablekeeper-deck.pdf` | 11-page presentation deck (960×540, vector text). Problem → invariant → architecture → evidence → closing. |
| `tablekeeper-cover.png` | 16:9 cover / thumbnail (3200×1800). |

## The one-line claim

Double-booking is **physically impossible** here — enforced by a Postgres exclusion
constraint, not application code:

```sql
EXCLUDE USING gist (
  table_id WITH =,
  tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status IN ('held', 'confirmed'));
```

Half-open `[)` ranges make back-to-back bookings legal (end == start → `201`);
any true overlap → `409 SLOT_TAKEN`. Verified live: 50 concurrent bookers →
exactly `1× 201 + 49× 409`, every round. 9/9 red-team probes failed to break it.

Runnable: see `DEPLOY.md` (one-click Vercel + Neon) or run locally with
`npm run dev` — PGlite fallback gives you the identical invariant with zero setup.
