"use client";

// /lookup — guest-facing booking management: find by confirmation code or
// email, then cancel (which instantly frees the slot — the EXCLUDE predicate
// only covers active rows).
import { useState } from "react";
import Link from "next/link";
import type { ReservationBody } from "@/lib/booking/service";

interface Banner {
  kind: "ok" | "conflict" | "warn" | "info";
  msg: string;
}

export default function LookupPage() {
  const [mode, setMode] = useState<"code" | "email">("code");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReservationBody[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setBanner(null);
    setResults(null);
    try {
      const res = await fetch(`/api/reservations?${mode}=${encodeURIComponent(q)}`, {
        cache: "no-store",
      });
      const body = await res.json();
      if (res.status === 200) {
        if (mode === "code") setResults([body.reservation as ReservationBody]);
        else setResults((body.reservations ?? []) as ReservationBody[]);
      } else {
        setBanner({
          kind: res.status === 404 ? "info" : "warn",
          msg: `${res.status} — ${body?.error?.message ?? "search failed"}`,
        });
      }
    } catch {
      setBanner({ kind: "warn", msg: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/reservations/${id}/cancel`, { method: "POST" });
      const body = await res.json();
      if (res.status === 200) {
        setResults((prev) =>
          prev ? prev.map((r) => (r.id === id ? (body as ReservationBody) : r)) : prev
        );
        setBanner({ kind: "ok", msg: "Cancelled — the table is instantly bookable again." });
      } else {
        setBanner({
          kind: "warn",
          msg: `${res.status} ${body?.error?.code ?? ""} — ${body?.error?.message ?? "cancel failed"}`,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Link className="crumbs" href="/">← home</Link>
      <h1 style={{ marginBottom: 2 }}>My bookings</h1>
      <p className="lede">Find a reservation by confirmation code, or list everything under an email.</p>

      <div className="row" style={{ margin: "18px 0 4px" }}>
        <button
          className={`chipbtn${mode === "code" ? " sel" : ""}`}
          onClick={() => {
            setMode("code");
            setResults(null);
            setBanner(null);
          }}
        >
          by code
        </button>
        <button
          className={`chipbtn${mode === "email" ? " sel" : ""}`}
          onClick={() => {
            setMode("email");
            setResults(null);
            setBanner(null);
          }}
        >
          by email
        </button>
      </div>
      <form onSubmit={search} className="row" style={{ marginTop: 8 }}>
        <input
          className="mono"
          style={{
            border: "1px solid var(--line)",
            borderRadius: 10,
            padding: "9px 12px",
            fontSize: 14,
            minWidth: 260,
            background: "var(--panel)",
          }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === "code" ? "TK-XXXXXX" : "ada@example.com"}
        />
        <button className="btn primary" disabled={busy || !query.trim()} type="submit">
          {busy ? "Searching…" : "Search"}
        </button>
      </form>

      {banner && <div className={`banner ${banner.kind}`}>{banner.msg}</div>}

      {results && results.length === 0 && (
        <div className="banner info">No reservations found for that {mode}.</div>
      )}

      {results && results.length > 0 && (
        <div className="grid" style={{ marginTop: 18 }}>
          {results.map((r) => (
            <div className="card" key={r.id}>
              <h3>
                {r.restaurant.name} · {r.table.label}
              </h3>
              <p className="meta">
                {r.local.date} · {r.local.label} · {r.partySize} guests
              </p>
              <p className="meta">
                code <b className="mono">{r.confirmCode}</b> · status{" "}
                <b>{r.status}</b>
                {r.status === "held" && r.holdExpiresAt ? " (TTL running)" : ""}
              </p>
              {(r.status === "held" || r.status === "confirmed") && (
                <button className="btn ghost" disabled={busy} onClick={() => cancel(r.id)}>
                  Cancel booking
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
