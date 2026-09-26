// Flow B fallback demo (BUILD_PLAN §6): the kill-demo replayed from the CLI.
// Fires N concurrent hold requests at a running tablekeeper instance and
// prints the verdict. Same race as the two-browser demo, no wifi required.
//
// Usage:  TK_BASE_URL=http://localhost:3100 node scripts/attack.mjs [N]
import crypto from "node:crypto";

const BASE = process.env.TK_BASE_URL ?? "http://localhost:3100";
const N = Number(process.argv[2] ?? "10");

// Default: the one-table restaurant — N racers, exactly one winner.
const restaurantId = process.env.TK_RESTAURANT ?? "rst_counter";
// A dinner slot 7 days out, 19:00 restaurant-local (NY), i.e. far enough to
// be bookable and inside a seeded service period.
const target = new Date(Date.now() + 7 * 24 * 3600 * 1000);
target.setUTCHours(23, 0, 0, 0); // 19:00 EDT ≈ 23:00Z (fall window: verify live)

async function hold(i) {
  const res = await fetch(`${BASE}/api/reservations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      restaurantId,
      startsAt: target.toISOString(),
      partySize: 2,
      guest: {
        name: `racer-${i}-${crypto.randomBytes(2).toString("hex")}`,
        email: `racer${i}@example.com`,
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { i, status: res.status, code: body?.error?.code ?? "-", id: body?.id ?? "-" };
}

console.log(`kill-demo: ${N} racers → ${restaurantId} @ ${target.toISOString()}`);
const results = await Promise.all([...Array(N).keys()].map(hold));

const won = results.filter((r) => r.status === 201);
const lost = results.filter((r) => r.status === 409);
const other = results.filter((r) => r.status !== 201 && r.status !== 409);

for (const r of results) {
  console.log(
    `  racer ${String(r.i).padStart(2)}: ${r.status} ${r.code === "-" ? "HOLD" : r.code} ${r.id}`
  );
}
console.log(`\nverdict: ${won.length}×201 · ${lost.length}×409 · ${other.length}×other`);
console.log(
  won.length <= 1
    ? "✅ invariant held — at most one winner"
    : "🚨 DOUBLE-BOOKED — invariant broken, investigate immediately"
);
