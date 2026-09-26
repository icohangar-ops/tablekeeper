"use client";

// Booker — the full guest flow: pick date/party → pick slot → hold (idempotent)
// → TTL countdown → confirm. Errors surface as banners: 409 SLOT_TAKEN,
// 410 HOLD_EXPIRED, 422 IDEMPOTENCY_KEY_REUSED.
//
// Lint notes (react-hooks v6): no synchronous setState inside effects —
// availability data is fetched in a fully-async effect and tagged with the
// request key it belongs to; staleness is handled by comparing keys, not by
// clearing state during render.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { AvailabilityView } from "@/lib/booking/availability";
import type { ReservationBody } from "@/lib/booking/service";
import { addDays, todayLocal } from "@/lib/time/tz";

interface RestaurantInfo {
  id: string;
  name: string;
  timezone: string;
  slug: string;
}

// Seeded adversarial dates (US fall-back 2026) — flagged in the date strip.
const DST_DATES = new Set(["2026-10-31", "2026-11-01"]);
const PARTIES = [1, 2, 3, 4, 5, 6];

interface Banner {
  kind: "ok" | "conflict" | "warn" | "info";
  msg: string;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dowOf(dateLocal: string): string {
  const [y, m, d] = dateLocal.split("-").map(Number);
  return DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function labelOf(dateLocal: string): string {
  const [, m, d] = dateLocal.split("-").map(Number);
  return `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`;
}

function buildDates(tz: string): string[] {
  const today = todayLocal(tz, new Date());
  return Array.from({ length: 14 }, (_, i) => addDays(today, i));
}

export default function Booker({ restaurant }: { restaurant: RestaurantInfo }) {
  const [dates] = useState(() => buildDates(restaurant.timezone));
  const [date, setDate] = useState(() => todayLocal(restaurant.timezone, new Date()));
  const [party, setParty] = useState(2);

  // Availability + the key (date|party) it was fetched for. Anything whose key
  // ≠ current selection is stale and simply not rendered.
  const [availData, setAvailData] = useState<{ key: string; view: AvailabilityView } | null>(
    null
  );
  const [selSlot, setSelSlot] = useState<string>("");
  const [selKey, setSelKey] = useState<string>("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [holdKey, setHoldKey] = useState<string>("");
  const [hold, setHold] = useState<ReservationBody | null>(null);
  const [replay, setReplay] = useState<string>("");
  const [confirmed, setConfirmed] = useState<ReservationBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const availSeq = useRef(0);

  const currentKey = `${date}|${party}`;
  const view = availData && availData.key === currentKey ? availData.view : null;
  const loading = !view;
  const activeSlot = selKey === currentKey ? selSlot : "";

  // TTL countdown ticker (interval callback → not a sync effect render)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const loadAvailability = useCallback(
    async (d: string, p: number) => {
      const seq = ++availSeq.current;
      const key = `${d}|${p}`;
      try {
        const res = await fetch(
          `/api/restaurants/${restaurant.id}/availability?date=${encodeURIComponent(d)}&party=${p}`,
          { cache: "no-store" }
        );
        const json = await res.json();
        if (seq === availSeq.current) {
          setAvailData({ key, view: json as AvailabilityView });
        }
      } catch {
        if (seq === availSeq.current) setAvailData({ key, view: { ...EMPTY_VIEW, restaurantId: restaurant.id, date: d } });
      }
    },
    [restaurant.id]
  );

  useEffect(() => {
    if (!date) return;
    // Inline async IIFE: setState strictly after awaits (react-hooks v6-safe).
    void (async () => {
      await loadAvailability(date, party);
    })();
  }, [date, party, loadAvailability]);

  const resetFlow = () => {
    setHold(null);
    setConfirmed(null);
    setReplay("");
    setBanner(null);
  };

  const pickDate = (d: string) => {
    setDate(d);
    setHold(null);
    setConfirmed(null);
    setReplay("");
    setBanner(null);
  };

  const pickParty = (p: number) => {
    setParty(p);
    setHold(null);
    setConfirmed(null);
    setReplay("");
    setBanner(null);
  };

  async function submitHold(e: React.FormEvent) {
    e.preventDefault();
    if (!activeSlot) return;
    if (!name.trim() || !email.trim()) {
      setBanner({ kind: "warn", msg: "Name and email are required to hold a table." });
      return;
    }
    setBusy(true);
    setConfirmed(null);
    setReplay("");
    const key = crypto.randomUUID();
    setHoldKey(key);
    try {
      const res = await fetch("/api/reservations", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          restaurantId: restaurant.id,
          startsAt: activeSlot,
          partySize: party,
          guest: { name: name.trim(), email: email.trim(), phone: phone.trim() || undefined },
        }),
      });
      const body = await res.json();
      if (res.status === 201 || res.status === 200) {
        setHold(body as ReservationBody);
        setBanner(null);
      } else if (res.status === 409) {
        setBanner({
          kind: "conflict",
          msg: "409 SLOT_TAKEN — someone booked that slot first. The database refused the overlap; pick another slot.",
        });
        void loadAvailability(date, party);
      } else {
        setBanner({
          kind: "warn",
          msg: `${res.status} ${body?.error?.code ?? ""} — ${body?.error?.message ?? "hold failed"}`,
        });
      }
    } catch {
      setBanner({ kind: "warn", msg: "Network error — safe to retry, the key is idempotent." });
    } finally {
      setBusy(false);
    }
  }

  // Proves I4: same key + same payload → 200 replay of the SAME reservation.
  async function tryReplay() {
    if (!holdKey || !activeSlot || !hold) return;
    setBusy(true);
    try {
      const res = await fetch("/api/reservations", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": holdKey },
        body: JSON.stringify({
          restaurantId: restaurant.id,
          startsAt: activeSlot,
          partySize: party,
          guest: { name: name.trim(), email: email.trim(), phone: phone.trim() || undefined },
        }),
      });
      const body = await res.json();
      setReplay(
        res.status === 200 && body?.id === hold.id
          ? `HTTP 200 — idempotent replay returned the SAME reservation (${body.id}). No second hold was created.`
          : `HTTP ${res.status} — unexpected replay result.`
      );
    } catch {
      setReplay("Network error during replay.");
    } finally {
      setBusy(false);
    }
  }

  async function doConfirm() {
    if (!hold) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/reservations/${hold.id}/confirm`, { method: "POST" });
      const body = await res.json();
      if (res.status === 200) {
        setConfirmed(body as ReservationBody);
        setHold(null);
        setBanner(null);
        void loadAvailability(date, party);
      } else {
        setBanner({
          kind: res.status === 410 ? "warn" : "conflict",
          msg: `${res.status} ${body?.error?.code ?? ""} — ${body?.error?.message ?? "confirm failed"}`,
        });
        if (res.status === 410) {
          setHold(null);
          void loadAvailability(date, party);
        }
      }
    } catch {
      setBanner({ kind: "warn", msg: "Network error during confirm." });
    } finally {
      setBusy(false);
    }
  }

  async function doCancel(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/reservations/${id}/cancel`, { method: "POST" });
      if (res.status === 200) {
        resetFlow();
        setBanner({ kind: "info", msg: "Reservation cancelled — the slot is free again instantly." });
        void loadAvailability(date, party);
      } else {
        const body = await res.json();
        setBanner({ kind: "warn", msg: `${res.status} — ${body?.error?.message ?? "cancel failed"}` });
      }
    } finally {
      setBusy(false);
    }
  }

  const secondsLeft = useMemo(() => {
    if (!hold?.holdExpiresAt) return null;
    const ms = new Date(hold.holdExpiresAt).getTime() - now;
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  }, [hold, now]);

  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <>
      <p className="kicker">1 · pick a date (restaurant-local)</p>
      <div className="datestrip">
        {dates.map((d) => (
          <button
            key={d}
            className={`datechip${d === date ? " sel" : ""}${DST_DATES.has(d) ? " dst" : ""}`}
            onClick={() => pickDate(d)}
          >
            <span className="dow">{dowOf(d)}</span>
            {labelOf(d)}
          </button>
        ))}
      </div>

      <p className="kicker">2 · party size</p>
      <div className="row">
        {PARTIES.map((p) => (
          <button
            key={p}
            className={`chipbtn${p === party ? " sel" : ""}`}
            onClick={() => pickParty(p)}
          >
            {p} {p === 1 ? "guest" : "guests"}
          </button>
        ))}
      </div>

      <p className="kicker">3 · pick a time (15-min grid · [start, end) semantics)</p>
      {loading && <p className="subtle">Loading availability…</p>}
      {!loading && view && view.slots.length === 0 && (
        <p className="subtle">No service on this date (closed day).</p>
      )}
      {!loading && view && view.slots.length > 0 && (
        <div className="slotgrid">
          {view.slots.map((s) => {
            const disabled = s.isPast || s.freeTables === 0;
            const sel = activeSlot === s.startsAtUTC;
            return (
              <button
                key={s.startsAtUTC}
                className={`slot${disabled ? (s.isPast ? " past" : " taken") : ""}${sel ? " sel" : ""}`}
                disabled={disabled}
                onClick={() => {
                  if (sel) {
                    setSelSlot("");
                    setSelKey("");
                  } else {
                    setSelSlot(s.startsAtUTC);
                    setSelKey(currentKey);
                  }
                  resetFlow();
                }}
              >
                {s.localWall}
                <small>{s.isPast ? "past" : s.freeTables === 0 ? "full" : `${s.freeTables} free`}</small>
              </button>
            );
          })}
        </div>
      )}

      {activeSlot && !hold && !confirmed && (
        <>
          <p className="kicker">4 · who&apos;s dining?</p>
          <form className="card" style={{ maxWidth: 460 }} onSubmit={submitHold}>
            <div className="field">
              <span>Name *</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
            </div>
            <div className="field">
              <span>Email *</span>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" />
            </div>
            <div className="field">
              <span>Phone (optional)</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 …" />
            </div>
            <p className="subtle" style={{ marginTop: 10 }}>
              Holding generates an <b>Idempotency-Key</b> — a retry can never
              create a second hold.
            </p>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn primary" disabled={busy} type="submit">
                {busy ? "Holding…" : "Hold this table"}
              </button>
            </div>
          </form>
        </>
      )}

      {banner && <div className={`banner ${banner.kind}`}>{banner.msg}</div>}

      {hold && !confirmed && (
        <div className="holdcard">
          <b>Table held.</b> {hold.table.label} for {hold.partySize} ·{" "}
          {hold.local.label} · code <span className="code">{hold.confirmCode}</span>
          {secondsLeft !== null && (
            <p style={{ margin: "6px 0" }}>
              Expires in <span className="countdown">{secondsLeft > 0 ? mmss(secondsLeft) : "0:00"}</span>{" "}
              — confirm before the TTL, or the sweep returns the table.
            </p>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={busy} onClick={doConfirm}>
              Confirm booking
            </button>
            <button className="btn ghost" disabled={busy} onClick={tryReplay}>
              Test idempotent replay
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => doCancel(hold.id)}>
              Release
            </button>
          </div>
          {replay && <p className="subtle" style={{ marginTop: 8 }}>{replay}</p>}
        </div>
      )}

      {confirmed && (
        <div className="banner ok">
          <b>Confirmed ✓</b> — {confirmed.table.label} for {confirmed.partySize} at{" "}
          {confirmed.local.label} ({confirmed.local.date}). Confirmation code:{" "}
          <span className="code">{confirmed.confirmCode}</span>. Lookup anytime at{" "}
          <Link href="/lookup">/lookup</Link>.
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn ghost" disabled={busy} onClick={() => doCancel(confirmed.id)}>
              Cancel this booking
            </button>
          </div>
        </div>
      )}
    </>
  );
}

const EMPTY_VIEW: AvailabilityView = {
  restaurantId: "",
  date: "",
  timezone: "",
  durationMin: 0,
  slotStepMin: 15,
  periods: [],
  slots: [],
};
