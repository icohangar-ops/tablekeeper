"use client";

// /kill-demo — the two-browser kill demo, simulated honestly: N parallel
// racers slam POST /api/reservations for the SAME table at the SAME instant
// (distinct idempotency keys, as distinct clients would). Exactly one 201
// survives; every loser gets a clean 409 from the database constraint.
//
// Lint notes (react-hooks v6): the winner/verdict are DERIVED from racer
// results during render (no effect-driven state), and all fetch effects
// setState strictly after awaits.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AvailabilityView } from "@/lib/booking/availability";
import { addDays, todayLocal } from "@/lib/time/tz";

const ARENA_SLUG = "chefs-counter"; // The Chef's Counter — ONE table (seed)
const ARENA_TZ = "America/New_York";
const COUNTS = [2, 8, 12, 24, 50];

interface Racer {
  n: number;
  status: number;
  kind: "created" | "conflict" | "other";
  detail: string;
  reservationId?: string;
}

interface Banner {
  kind: "ok" | "conflict" | "warn" | "info";
  msg: string;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function buildDates(): string[] {
  const today = todayLocal(ARENA_TZ, new Date());
  return Array.from({ length: 10 }, (_, i) => addDays(today, i));
}

export default function KillDemoPage() {
  const [dates] = useState(buildDates);
  const [date, setDate] = useState(() => todayLocal(ARENA_TZ, new Date()));
  const [restaurantId, setRestaurantId] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [slot, setSlot] = useState<{ startsAtUTC: string; label: string } | null>(null);
  const [count, setCount] = useState(12);
  const [racers, setRacers] = useState<Racer[]>([]);
  const [running, setRunning] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [winnerConfirmed, setWinnerConfirmed] = useState(false);
  const slotSeq = useRef(0);

  // Locate the arena restaurant once (setStates only after awaits).
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/restaurants?query=counter", { cache: "no-store" });
        const json = await res.json();
        const r = (json.restaurants ?? []).find((x: { slug: string }) => x.slug === ARENA_SLUG);
        if (r) {
          setRestaurantId(r.id);
          setRestaurantName(r.name);
        } else {
          setBanner({
            kind: "warn",
            msg: "Arena restaurant (The Chef's Counter) not found in seed data.",
          });
        }
      } catch {
        setBanner({ kind: "warn", msg: "Could not reach the API." });
      }
    })();
  }, []);

  const loadSlot = useCallback(
    async (d: string, rid: string) => {
      if (!rid) return;
      const mySeq = ++slotSeq.current;
      try {
        const res = await fetch(
          `/api/restaurants/${rid}/availability?date=${encodeURIComponent(d)}&party=2`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as AvailabilityView;
        if (mySeq !== slotSeq.current) return;
        setRacers([]);
        setWinnerConfirmed(false);
        setBanner(null);
        const playable = json.slots.find((s) => !s.isPast && s.freeTables > 0);
        if (playable) {
          setSlot({ startsAtUTC: playable.startsAtUTC, label: playable.localWall });
        } else {
          const anyFuture = json.slots.find((s) => !s.isPast);
          if (anyFuture) {
            setSlot({ startsAtUTC: anyFuture.startsAtUTC, label: anyFuture.localWall });
            setBanner({
              kind: "info",
              msg: `Every future slot on ${d} is already occupied. Cancel a booking below (or in /lookup) to re-arm, or pick another date.`,
            });
          } else {
            setSlot(null);
            setBanner({ kind: "warn", msg: `No service on ${d}. Pick another date.` });
          }
        }
      } catch {
        if (mySeq === slotSeq.current) setBanner({ kind: "warn", msg: "Availability fetch failed." });
      }
    },
    []
  );

  useEffect(() => {
    if (!restaurantId || !date) return;
    // Inline async IIFE: setState strictly after awaits (react-hooks v6-safe).
    void (async () => {
      await loadSlot(date, restaurantId);
    })();
  }, [restaurantId, date, loadSlot]);

  // Derived verdict — no effect needed.
  const created = racers.filter((r) => r.kind === "created").length;
  const conflicts = racers.filter((r) => r.kind === "conflict").length;
  const others = racers.filter((r) => r.kind === "other").length;
  const settled = created + conflicts + others;
  const winner = racers.find((r) => r.kind === "created") ?? null;
  const perfect = !running && racers.length > 0 && settled === count && created === 1 && others === 0;
  const noWinner = !running && racers.length > 0 && created === 0;

  async function fire() {
    if (!slot || !restaurantId || running) return;
    setRunning(true);
    setRacers([]);
    setWinnerConfirmed(false);
    setBanner(null);
    const stamp = `${Date.now()}`;

    const fireOne = (n: number): Promise<void> =>
      (async () => {
        try {
          const res = await fetch("/api/reservations", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": `kill-${stamp}-${String(n).padStart(3, "0")}`,
            },
            body: JSON.stringify({
              restaurantId,
              startsAt: slot.startsAtUTC,
              partySize: 2,
              guest: {
                name: `Racer-${String(n).padStart(2, "0")}`,
                email: `racer${String(n).padStart(2, "0")}@kill.demo`,
              },
            }),
          });
          const body = await res.json();
          const racer: Racer =
            res.status === 201
              ? {
                  n,
                  status: 201,
                  kind: "created",
                  detail: `hold ${body.id} · code ${body.confirmCode} · ${body.table?.label ?? ""}`,
                  reservationId: body.id,
                }
              : res.status === 409
                ? {
                    n,
                    status: 409,
                    kind: "conflict",
                    detail: `${body?.error?.code ?? "SLOT_TAKEN"} — overlap rejected`,
                  }
                : {
                    n,
                    status: res.status,
                    kind: "other",
                    detail: `${body?.error?.code ?? "ERR"} — ${body?.error?.message ?? ""}`,
                  };
          setRacers((prev) => [...prev, racer]);
        } catch {
          setRacers((prev) => [
            ...prev,
            { n, status: 0, kind: "other", detail: "network error" },
          ]);
        }
      })();

    await Promise.all(Array.from({ length: count }, (_, i) => fireOne(i + 1)));
    setRunning(false);
  }

  async function confirmWinner() {
    if (!winner?.reservationId) return;
    setRunning(true);
    try {
      const res = await fetch(`/api/reservations/${winner.reservationId}/confirm`, {
        method: "POST",
      });
      const body = await res.json();
      if (res.status === 200) {
        setWinnerConfirmed(true);
        setBanner({
          kind: "ok",
          msg: `Winner confirmed — ${body.local?.label ?? ""} on ${body.table?.label ?? "the table"}. Code ${body.confirmCode}.`,
        });
      } else {
        setBanner({
          kind: "warn",
          msg: `${res.status} ${body?.error?.code ?? ""} — ${body?.error?.message ?? "confirm failed"}`,
        });
      }
    } finally {
      setRunning(false);
    }
  }

  async function rearm() {
    if (!winner?.reservationId) return;
    setRunning(true);
    try {
      const res = await fetch(`/api/reservations/${winner.reservationId}/cancel`, {
        method: "POST",
      });
      if (res.status === 200) {
        setWinnerConfirmed(false);
        await loadSlot(date, restaurantId);
      } else {
        const body = await res.json();
        setBanner({
          kind: "warn",
          msg: `${res.status} — ${body?.error?.message ?? "re-arm failed"}`,
        });
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <Link className="crumbs" href="/">
        ← home
      </Link>
      <h1 style={{ marginBottom: 2 }}>The Kill Demo</h1>
      <p className="lede" style={{ marginBottom: 4 }}>
        One table. N racers. Same instant. <b>{restaurantName || "…"}</b> seats
        exactly one party — the database refuses every other booking with a
        clean 409, no matter how the requests interleave.
      </p>
      <p className="subtle" style={{ marginTop: 0 }}>
        Each racer is a real HTTP request with its own Idempotency-Key — exactly
        what two browsers, or fifty, would send.
      </p>

      <p className="kicker">date (arena local: {ARENA_TZ})</p>
      <div className="datestrip">
        {dates.map((d) => (
          <button
            key={d}
            className={`datechip${d === date ? " sel" : ""}`}
            disabled={running}
            onClick={() => setDate(d)}
          >
            <span className="dow">{DOW[new Date(d + "T00:00:00Z").getUTCDay()]}</span>
            {d.slice(5)}
          </button>
        ))}
      </div>

      <p className="kicker">slot & racers</p>
      <div className="row">
        <span className="pill" style={{ marginTop: 0, fontSize: 13 }}>
          {slot ? `target: ${slot.label}` : "loading slot…"}
        </span>
        {COUNTS.map((c) => (
          <button
            key={c}
            className={`chipbtn${c === count ? " sel" : ""}`}
            disabled={running}
            onClick={() => setCount(c)}
          >
            {c} racers
          </button>
        ))}
        <button className="btn primary" disabled={running || !slot} onClick={fire}>
          {running ? `Racing… (${settled}/${count})` : `▶ Fire ${count} concurrent bookers`}
        </button>
      </div>

      {banner && <div className={`banner ${banner.kind}`}>{banner.msg}</div>}
      {noWinner && !banner && (
        <div className="banner conflict">
          No 201 in this run — the slot was already occupied before the race
          (re-arm below or pick another date).
        </div>
      )}

      {settled > 0 && (
        <>
          <div className="statrow">
            <div className="stat">
              <b className="s201">{created}</b>
              <span>201 created</span>
            </div>
            <div className="stat">
              <b className="s409">{conflicts}</b>
              <span>409 rejected</span>
            </div>
            <div className="stat">
              <b className="sother">{others}</b>
              <span>other</span>
            </div>
          </div>

          {perfect && (
            <div className="verdict">
              VERDICT: <b>exactly one booking survived</b> — {created}×201,{" "}
              {conflicts}×409, {others}×anything-else. {count} racers, one table,{" "}
              zero double-bookings. The constraint is doing the deciding.
            </div>
          )}

          {winner && !winnerConfirmed && (
            <div className="holdcard">
              <b>Winner:</b> {winner.reservationId} (held, TTL running)
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn primary" disabled={running} onClick={confirmWinner}>
                  Confirm the winner
                </button>
                <button className="btn ghost" disabled={running} onClick={rearm}>
                  Cancel winner & re-arm arena
                </button>
              </div>
            </div>
          )}

          <table className="racelog">
            <thead>
              <tr>
                <th>#</th>
                <th>racer</th>
                <th>HTTP</th>
                <th>outcome</th>
              </tr>
            </thead>
            <tbody>
              {[...racers]
                .sort((a, b) => a.n - b.n)
                .map((r) => (
                  <tr key={r.n}>
                    <td>{r.n}</td>
                    <td>Racer-{String(r.n).padStart(2, "0")}</td>
                    <td
                      className={
                        r.kind === "created" ? "s201" : r.kind === "conflict" ? "s409" : "sother"
                      }
                    >
                      {r.status || "—"}
                    </td>
                    <td>{r.detail}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
