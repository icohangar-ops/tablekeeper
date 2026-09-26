// E2E smoke (W1–W3 self-check): availability → hold → confirm → replay →
// cancel. Run against a live dev server (default :3100).
const BASE = process.env.TK_BASE_URL ?? "http://localhost:3100";
const RID = process.env.TK_RESTAURANT ?? "rst_counter";

const j = async (res) => {
  const body = await res.json();
  return { status: res.status, body };
};

const fail = (msg) => {
  console.error("E2E FAIL:", msg);
  process.exit(1);
};

// 1. health
const health = await j(await fetch(`${BASE}/api/health`));
if (!health.body.ok) fail(`health: ${JSON.stringify(health.body)}`);
console.log("health ok —", health.body.engine, "/ constraint present");

// 2. availability
const av = await j(await fetch(`${BASE}/api/restaurants/${RID}/availability?party=2`));
const slot = (av.body.slots ?? []).find((s) => !s.isPast && s.freeTables > 0);
if (!slot) fail("no bookable slot found");
console.log("availability ok — slot", slot.localWall, "free:", slot.freeTables);

// 3. hold (with idempotency key)
const hold = await j(
  await fetch(`${BASE}/api/reservations`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "e2e-smoke-1" },
    body: JSON.stringify({
      restaurantId: RID,
      startsAt: slot.startsAtUTC,
      partySize: 2,
      guest: { name: "E2E Tester", email: "e2e@example.com" },
    }),
  })
);
if (hold.status !== 201) fail(`hold: ${hold.status} ${JSON.stringify(hold.body)}`);
console.log("hold ok —", hold.body.id, hold.body.confirmCode, "until", hold.body.holdExpiresAt);

// 4. idempotent replay
const replay = await j(
  await fetch(`${BASE}/api/reservations`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "e2e-smoke-1" },
    body: JSON.stringify({
      restaurantId: RID,
      startsAt: slot.startsAtUTC,
      partySize: 2,
      guest: { name: "E2E Tester", email: "e2e@example.com" },
    }),
  })
);
if (replay.body.id !== hold.body.id) fail("replay returned a DIFFERENT reservation");
if (JSON.stringify(replay.body) !== JSON.stringify(hold.body)) fail("replay body differs");
console.log("replay ok — identical body");

// 5. confirm
const conf = await j(await fetch(`${BASE}/api/reservations/${hold.body.id}/confirm`, { method: "POST" }));
if (conf.body.status !== "confirmed") fail(`confirm: ${conf.status} ${JSON.stringify(conf.body)}`);
console.log("confirm ok — status:", conf.body.status);

// 6. lookup by confirm code
const byCode = await j(await fetch(`${BASE}/api/reservations?code=${encodeURIComponent(conf.body.confirmCode)}`));
if (byCode.body.reservation?.id !== hold.body.id) fail("code lookup mismatch");
console.log("code lookup ok");

// 7. cancel
const cancel = await j(await fetch(`${BASE}/api/reservations/${hold.body.id}/cancel`, { method: "POST" }));
if (cancel.body.status !== "cancelled") fail(`cancel: ${JSON.stringify(cancel.body)}`);
console.log("cancel ok — slot freed");

// 8. audit trail
const audit = await j(await fetch(`${BASE}/api/audit?limit=5`));
if (!audit.body.count) fail("audit empty");
console.log("audit ok —", audit.body.count, "recent events");

console.log("\nE2E SMOKE: ALL GREEN");
