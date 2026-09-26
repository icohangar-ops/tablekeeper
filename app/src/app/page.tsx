// Landing page — restaurants + the invariant story + API cheatsheet.
// Server component; reads directly from the store (embedded PGlite or Postgres).
import { ensureReady } from "@/lib/db";

export const dynamic = "force-dynamic";

interface Listing {
  id: string;
  slug: string;
  name: string;
  cuisine: string;
  timezone: string;
  table_count: number;
  max_capacity: number;
}

export default async function Home() {
  const db = await ensureReady();
  const res = await db.query<Listing>(
    `SELECT r.id, r.slug, r.name, r.cuisine, r.timezone,
            COUNT(t.id)::int AS table_count, MAX(t.capacity)::int AS max_capacity
     FROM restaurants r LEFT JOIN dining_tables t ON t.restaurant_id = r.id
     GROUP BY r.id ORDER BY r.name ASC`
  );
  const restaurants = res.rows;

  return (
    <>
      <h1>Reservations that cannot double-book.</h1>
      <p className="lede">
        Tablekeeper is a clean-room restaurant-reservation clone built for the
        Dark Factory hackathon. Its core promise isn&apos;t a feature — it&apos;s a{" "}
        <em>database constraint</em>: no two active bookings on the same table
        can ever overlap, because Postgres physically refuses to store them.
      </p>

      <h2 id="invariant">The invariant</h2>
      <div className="inv">
        Partial exclusion constraint on <code>reservations</code> — any two rows
        with status <code>held</code>/<code>confirmed</code> on the same{" "}
        <code>table_id</code> whose <code>[starts_at, ends_at)</code> ranges
        intersect are rejected by the storage engine itself (SQLSTATE 23P01 →
        HTTP 409 <code>SLOT_TAKEN</code>). The app translates; the database
        decides. An adversarial suite (50-way races, hold-expiry races,
        idempotent retry storms, DST boundaries) tries to break it on every
        commit.
      </div>

      <h2>Restaurants ({restaurants.length})</h2>
      <div className="grid">
        {restaurants.map((r) => (
          <div className="card" key={r.id}>
            <h3>{r.name}</h3>
            <p className="meta">
              {r.cuisine} · {r.timezone}
            </p>
            <p className="meta">
              {r.table_count} tables · up to {r.max_capacity} seats
            </p>
            <span className="pill">
              <a
                href={`/api/restaurants/${r.id}/availability`}
                style={{ color: "inherit", textDecoration: "none" }}
              >
                availability →
              </a>
            </span>
          </div>
        ))}
      </div>

      <h2 id="api">Try it (API)</h2>
      <code className="block">
        {`# liveness + invariant self-check
curl localhost:3100/api/health

# availability (restaurant-local date, party of 2)
curl "localhost:3100/api/restaurants/rst_harbor/availability?party=2"

# hold a table (retries are safe with Idempotency-Key)
curl -X POST localhost:3100/api/reservations \\
  -H 'content-type: application/json' \\
  -H 'idempotency-key: demo-1' \\
  -d '{"restaurantId":"rst_harbor","startsAt":"<UTC ISO>","partySize":2,
       "guest":{"name":"Ada","email":"ada@example.com"}}'

# confirm · cancel · audit trail
curl -X POST localhost:3100/api/reservations/<id>/confirm
curl -X POST localhost:3100/api/reservations/<id>/cancel
curl localhost:3100/api/audit?limit=20`}
      </code>
    </>
  );
}
