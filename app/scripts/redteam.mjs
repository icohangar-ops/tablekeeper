// W8 red-team pass — 9 adversarial probes over the LIVE HTTP surface.
//
// No test fixtures, no in-process shortcuts: every probe is a real fetch
// against a running tablekeeper instance (ideally a fresh production build:
//   cd app && npm run build && npm start          # ephemeral PGlite, deterministic
//   TK_BASE_URL=http://localhost:3100 node scripts/redteam.mjs
// ).
//
// Report artifact: scripts/redteam-report.json
//
// Probe map (evidence: docs/EVIDENCE.md §6):
//   RT1  50 concurrent bookers, distinct keys, one table   → 1×201 + 49×409 SLOT_TAKEN
//   RT2  12-way stampede, SAME idempotency key + payload   → 12×201, one reservation id
//   RT3  same key, different payload                       → 422 DUPLICATE_IDEMPOTENCY_PAYLOAD
//   RT4a double confirm                                    → 200 + 200, identical confirm code
//   RT4b confirm after terminal cancel                     → 409 INVALID_TRANSITION
//   RT5  confirm-vs-cancel race                            → one coherent terminal state, no 5xx
//   RT6  back-to-back seatings (end == start) vs overlap   → adjacency 201/201, overlap 409
//   RT7  fuzz battery (10 malformed/invalid cases)         → all 4xx, zero 5xx
//   RT8  health self-check + audit feed                    → constraintPresent=true, events logged
//
// NOTE on duration: DEFAULT_DURATION_MIN = 90. Probes that need a *truly
// adjacent* slot step +90 minutes — stepping +60 would overlap the first
// booking by 30 minutes, and a 409 there would be the database being RIGHT.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.TK_BASE_URL ?? "http://localhost:3100";
const RST = process.env.TK_RESTAURANT ?? "rst_counter"; // one-table kill-demo arena
const key = () => crypto.randomUUID();
const DAY = 24 * 3600 * 1000;

// A dinner slot `dayOffset` days out at 19:00 restaurant-local (NY).
// 19:00 EDT ≡ 23:00Z (the fall-back window is later in November).
function slotUTC(dayOffset) {
  const t = new Date(Date.now() + dayOffset * DAY);
  t.setUTCHours(23, 0, 0, 0);
  return t.toISOString();
}

async function req(method, path, { key: idemKey, body, raw } = {}) {
  const headers = {};
  if (idemKey) headers["idempotency-key"] = idemKey;
  let payload;
  if (raw !== undefined) {
    headers["content-type"] = "application/json";
    payload = raw;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body (e.g. HTML error page) — keep null */
  }
  return { status: res.status, body: json, text };
}

const holdBody = (startsAt, i, partySize = 2) => ({
  restaurantId: RST,
  startsAt,
  partySize,
  guest: { name: `redteam-${i}`, email: `redteam${i}@example.com` },
});

const code = (r) => r.body?.error?.code ?? "-";

// --- slot allocator: probes must not collide with each other --------------
// The arena (rst_counter) has ONE table; every hold takes [S, S+90). Probes
// that book sequentially need genuinely free slots, so we walk the live
// availability feed and skip anything overlapping a window we already took.
const consumed = []; // {start: ms, end: ms}
const collides = (s0) => {
  const t = new Date(s0).getTime();
  return consumed.some((w) => t < w.end && t + 90 * 60000 > w.start);
};
const consume = (s0) =>
  consumed.push({
    start: new Date(s0).getTime(),
    end: new Date(s0).getTime() + 90 * 60000,
  });

function nyDate(dayOffset) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + dayOffset * DAY));
}

// First free, non-past 19:00-grid slot from `preferDay` onward that does not
// overlap a window a previous probe already booked. Marks it consumed.
async function takeFreeSlot(preferDay = 7) {
  for (let day = preferDay; day <= preferDay + 7; day++) {
    const avail = await req(
      "GET",
      `/api/restaurants/${RST}/availability?date=${nyDate(day)}&party=2`
    );
    for (const s of avail.body?.slots ?? []) {
      if (s.isPast || s.freeTables <= 0 || collides(s.startsAtUTC)) continue;
      consume(s.startsAtUTC);
      return s.startsAtUTC;
    }
  }
  throw new Error("no free slot available for probe — re-arm the arena");
}

const state = {}; // cross-probe handles (e.g. RT2's idempotency key → RT3)

// ---------------------------------------------------------------- probes

async function rt1() {
  const target = slotUTC(7); // primary kill slot, 7 days out (fresh instance assumption)
  consume(target);
  const res = await Promise.all(
    [...Array(50).keys()].map((i) =>
      req("POST", "/api/reservations", { key: key(), body: holdBody(target, `rt1-${i}`) })
    )
  );
  const won = res.filter((r) => r.status === 201);
  const rejected = res.filter((r) => r.status === 409);
  const other = res.filter((r) => r.status !== 201 && r.status !== 409);
  const allSlotTaken = rejected.every((r) => code(r) === "SLOT_TAKEN");
  const pass = won.length === 1 && rejected.length === 49 && other.length === 0 && allSlotTaken;
  const ids = new Set(won.map((r) => r.body?.id));
  return {
    pass,
    detail: `${won.length}×201 (unique ids: ${ids.size}) · ${rejected.length}×409 SLOT_TAKEN · ${other.length}×other`,
    hint: pass ? undefined : "if 0×201: the target slot was already taken — re-arm (cancel winner) or use a fresh instance",
  };
}

async function rt2() {
  const target = await takeFreeSlot(8);
  const k = key();
  state.rt2Key = k; // RT3 reuses this key for the payload-mismatch check
  const res = await Promise.all(
    [...Array(12).keys()].map(() =>
      req("POST", "/api/reservations", { key: k, body: holdBody(target, "rt2") })
    )
  );
  const ids = new Set(res.map((r) => r.body?.id));
  const all201 = res.every((r) => r.status === 201);
  return {
    pass: all201 && ids.size === 1,
    detail: `${res.filter((r) => r.status === 201).length}×201 · unique reservation ids: ${ids.size} (I4 replay under stampede)`,
  };
}

async function rt3() {
  // Same key as RT2 (a key the server has definitely recorded), DIFFERENT
  // payload — the idempotency layer must refuse before availability is even
  // consulted.
  const k = state.rt2Key;
  if (!k) return { pass: false, detail: "skipped — RT2 did not produce a key" };
  const clash = await req("POST", "/api/reservations", {
    key: k,
    body: holdBody(slotUTC(8), "rt3", 4),
  });
  return {
    pass: clash.status === 422 && code(clash) === "DUPLICATE_IDEMPOTENCY_PAYLOAD",
    detail: `${clash.status} ${code(clash)} (reused RT2's recorded key)`,
  };
}

async function rt4a() {
  const { body: h } = await req("POST", "/api/reservations", {
    key: key(),
    body: holdBody(await takeFreeSlot(9), "rt4a"),
  });
  const c1 = await req("POST", `/api/reservations/${h.id}/confirm`);
  const c2 = await req("POST", `/api/reservations/${h.id}/confirm`);
  const pass = c1.status === 200 && c2.status === 200 && c1.body?.confirmCode === c2.body?.confirmCode;
  return {
    pass,
    detail: `${c1.status} + ${c2.status}, confirmCode identical: ${c1.body?.confirmCode === c2.body?.confirmCode}`,
  };
}

async function rt4b() {
  const { body: h } = await req("POST", "/api/reservations", {
    key: key(),
    body: holdBody(await takeFreeSlot(9), "rt4b"),
  });
  await req("POST", `/api/reservations/${h.id}/cancel`);
  const late = await req("POST", `/api/reservations/${h.id}/confirm`);
  return {
    pass: late.status === 409 && code(late) === "INVALID_TRANSITION",
    detail: `confirm-after-cancel → ${late.status} ${code(late)}`,
  };
}

async function rt5() {
  const { body: h } = await req("POST", "/api/reservations", {
    key: key(),
    body: holdBody(await takeFreeSlot(10), "rt5"),
  });
  const [c, x] = await Promise.all([
    req("POST", `/api/reservations/${h.id}/confirm`),
    req("POST", `/api/reservations/${h.id}/cancel`),
  ]);
  const no5xx = [c, x].every((r) => r.status < 500);
  const final = await req("GET", `/api/reservations/${h.id}`);
  const st = final.body?.reservation?.status;
  const coherent = st === "confirmed" || st === "cancelled";
  const statusLine = `confirm=${c.status} cancel=${x.status} → final=${st}`;
  return { pass: no5xx && coherent, detail: `${statusLine} (exactly one terminal state wins the race)` };
}

async function rt6() {
  // Find a free slot S such that S+90 is ALSO a listed free slot (both inside
  // one service period) — then adjacency must pass and a 45-min intrusion
  // must fail. DEFAULT_DURATION_MIN = 90: end == start is legal, overlap is not.
  for (let day = 11; day <= 14; day++) {
    const avail = await req(
      "GET",
      `/api/restaurants/${RST}/availability?date=${nyDate(day)}&party=2`
    );
    const slots = (avail.body?.slots ?? []).filter((s) => !s.isPast && s.freeTables > 0);
    const starts = new Set(slots.map((s) => s.startsAtUTC));
    const base = slots.find((s) => {
      const nxt = new Date(new Date(s.startsAtUTC).getTime() + 90 * 60000).toISOString();
      return starts.has(nxt) && !collides(s.startsAtUTC) && !collides(nxt);
    });
    if (!base) continue;

    const s0 = new Date(base.startsAtUTC).toISOString();
    const s90 = new Date(new Date(s0).getTime() + 90 * 60000).toISOString();
    const s45 = new Date(new Date(s0).getTime() + 45 * 60000).toISOString();
    consume(s0);
    consume(s90);

    const a = await req("POST", "/api/reservations", { key: key(), body: holdBody(s0, "rt6a") });
    const b = await req("POST", "/api/reservations", { key: key(), body: holdBody(s90, "rt6b") });
    const c = await req("POST", "/api/reservations", { key: key(), body: holdBody(s45, "rt6c") });
    const adjacencyTrue = a.body?.endsAt === b.body?.startsAt; // [) semantics made visible
    const pass = a.status === 201 && b.status === 201 && c.status === 409 && adjacencyTrue;
    return {
      pass,
      detail: `adjacent ${a.status}/${b.status} (A.endsAt === B.startsAt: ${adjacencyTrue}) · overlap ${c.status} ${code(c)}`,
    };
  }
  return { pass: false, detail: "no free S/S+90 slot pair found in +11..+14 days — re-arm and re-run" };
}

async function rt7() {
  const future = slotUTC(12);
  const past = "2020-01-01T00:00:00.000Z";
  const threeAm = new Date(new Date(future).getTime() - 20 * 3600 * 1000).toISOString(); // ≈03:00 NY
  const cases = [
    ["party 0", { body: holdBody(future, "f1", 0) }],
    ["party -3", { body: holdBody(future, "f2", -3) }],
    ["party 99", { body: holdBody(future, "f3", 99) }],
    ['party "two"', { body: { ...holdBody(future, "f4"), partySize: "two" } }],
    ["garbage date", { body: holdBody("not-a-date", "f5") }],
    ["past date", { body: holdBody(past, "f6") }],
    ["unknown restaurant", { body: { ...holdBody(future, "f7"), restaurantId: "rst_nope" } }],
    ["missing guest", { body: { restaurantId: RST, startsAt: future, partySize: 2, guest: {} } }],
    ["malformed JSON", { raw: `{"restaurantId":"${RST}","startsAt":` }],
    ["3 am slot", { body: holdBody(threeAm, "f10") }],
  ];
  const res = [];
  for (const [label, opts] of cases) {
    const r = await req("POST", "/api/reservations", { key: key(), ...opts });
    res.push({ label, status: r.status, code: code(r) });
  }
  const all4xx = res.every((r) => r.status >= 400 && r.status <= 499);
  return {
    pass: all4xx,
    detail: all4xx
      ? `10/10 answered 4xx — zero 5xx (${res.map((r) => r.status).join(",")})`
      : `5xx leak: ${res.filter((r) => r.status >= 500).map((r) => `${r.label}=${r.status}`).join(", ")}`,
    cases: res,
  };
}

async function rt8() {
  const health = await req("GET", "/api/health");
  const audit = await req("GET", "/api/audit?limit=20");
  const constraintPresent = health.body?.invariant?.constraintPresent === true;
  const auditOk = audit.status === 200 && audit.body?.count > 0 && Array.isArray(audit.body?.events);
  return {
    pass: health.status === 200 && constraintPresent && auditOk,
    detail: `health ${health.status} constraintPresent=${constraintPresent} · audit ${audit.status} count=${audit.body?.count}`,
  };
}

// ---------------------------------------------------------------- runner

const PROBES = [
  ["RT1", "50-way booking race, distinct keys", rt1],
  ["RT2", "12-way stampede, same idempotency key", rt2],
  ["RT3", "same key, different payload", rt3],
  ["RT4a", "double confirm is idempotent", rt4a],
  ["RT4b", "confirm after terminal cancel", rt4b],
  ["RT5", "confirm-vs-cancel race", rt5],
  ["RT6", "adjacency (end==start) vs 45-min overlap", rt6],
  ["RT7", "fuzz battery — 10 invalid clients", rt7],
  ["RT8", "health invariant self-check + audit feed", rt8],
];

console.log(`red-team: 9 probes → ${BASE} (${RST})`);
const results = [];
for (const [id, label, fn] of PROBES) {
  let r;
  try {
    r = await fn();
  } catch (err) {
    r = { pass: false, detail: `probe crashed: ${err.message}` };
  }
  results.push({ id, label, ...r });
  console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${label} — ${r.detail}`);
}

const passed = results.filter((r) => r.pass).length;
const verdict =
  passed === PROBES.length
    ? "RED TEAM FAILED TO BREAK IT"
    : "RED TEAM FOUND GAPS — investigate before shipping";
console.log(`\nverdict: ${passed}/${PROBES.length} — ${verdict}`);

const report = {
  base: BASE,
  startedAt: new Date().toISOString(),
  passed,
  total: PROBES.length,
  verdict,
  probes: results,
};
const out = path.join(process.cwd(), "scripts", "redteam-report.json");
fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(`report: ${out}`);

process.exit(passed === PROBES.length ? 0 : 1);
