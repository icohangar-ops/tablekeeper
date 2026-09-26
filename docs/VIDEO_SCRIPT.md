# Demo video script — 90 seconds

Target: lablab submission video (single take + screen capture, 90 s max).
Hero shot is `/kill-demo` with 50 racers — it is the whole pitch in one move:
**the audience watches the system refuse to break, live.**

Prep before recording (2 minutes):

1. `cd app && npm run dev` → <http://localhost:3100> (embedded Postgres, no
   external deps — nothing can fail on camera).
2. Open three tabs: `/kill-demo`, `/restaurants/chefs-counter` (booking flow),
   `/lookup`. Pre-load each so first paint is instant.
3. The counter table must be free: if a hold is active, re-arm from
   `/kill-demo` first. `curl localhost:3100/api/health` on screen for 1 s —
   it shows `constraintPresent: true` before every run.
4. Browser at 100% zoom, dark theme, bookmarks bar hidden, terminal font ≥ 16pt.

| ⏱ | Shot | Voiceover |
|---|---|---|
| 0:00–0:10 | Terminal, type `npm run attack -- 50` output visible — or go straight to the browser | "Here are fifty people trying to book the same table at the same time. One table. Fifty requests. In a normal reservation system, this is the moment double-booking is born." |
| 0:10–0:25 | `/kill-demo`: hit **50 racers**. Live log fills; verdict banner: **1×201, 49×409** | "Watch the verdict. Exactly one winner. Forty-nine honest rejections — every single one answered by the database, not by hope." |
| 0:25–0:45 | Scroll to the SQL in the README on screen (the EXCLUDE constraint block) | "This isn't application logic trying hard. It's a Postgres exclusion constraint — overlapping bookings on the same table are *physically impossible*. Two ranges can't overlap on one table; the database itself refuses the transaction. Back-to-back seatings still work — the constraint is exactly as strict as reality, and not stricter." |
| 0:45–1:05 | Show `/restaurants/chefs-counter`: pick a date, party, slot → hold → TTL countdown → confirm → confirmation code. Then "test idempotent replay" button → same reservation | "And the normal flow feels normal. Hold a table, ten-minute countdown, confirm. Press the replay button — same idempotency key, same reservation, no duplicate. Retries are safe by design." |
| 1:05–1:20 | Split screen or cut: GitHub Actions log — T1–T11 suite green, ShipScore gate "100/100 (A)" | "An adversarial suite of eleven attacks — race storms, hold expiry, DST boundaries — runs on every push, and a ShipScore quality gate blocks the merge if the factory ships unsafe code. The band that built this checks its own work — with infrastructure, not vibes." |
| 1:20–1:30 | Back to `/kill-demo`, re-arm, verdict banner clears | "Tablekeeper. Double-booking is impossible. Repo and live demo in the links." |

Recording notes:

- The 50-racer shot needs the target slot free; re-arm between takes from the
  UI. If a racer wins but you want the table back, hit **Cancel** — the slot
  is instantly bookable again (that cancel-frees-slot moment is itself a nice
  cutaway for 0:45).
- Do NOT cut during the verdict banner; let it sit for a full second.
- If you prefer CLI for the opening: `npm run attack -- 50` prints the same
  verdict; but the browser log table reads better on camera.
- Backup line if the wifi dies: everything runs on the embedded Postgres —
  the demo is fully offline-capable.
