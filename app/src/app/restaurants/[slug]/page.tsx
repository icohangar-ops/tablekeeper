// Restaurant page — server shell loads the venue, client <Booker> runs the
// hold → confirm flow against the real API (idempotent retries included).
import { ensureReady } from "@/lib/db";
import { ApiError } from "@/lib/booking/errors";
import Link from "next/link";
import Booker from "./Booker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function RestaurantPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const db = await ensureReady();
  const res = await db.query<{
    id: string;
    slug: string;
    name: string;
    cuisine: string;
    timezone: string;
    address: string;
  }>(
    `SELECT id, slug, name, cuisine, timezone, address
     FROM restaurants WHERE slug = $1`,
    [slug]
  );
  const r = res.rows[0];
  if (!r) throw new ApiError("NOT_FOUND", "restaurant not found", { slug });

  const tables = await db.query<{ label: string; capacity: number }>(
    `SELECT label, capacity FROM dining_tables
     WHERE restaurant_id = $1 ORDER BY capacity ASC, label ASC`,
    [r.id]
  );

  return (
    <>
      <Link className="crumbs" href="/">
        ← all restaurants
      </Link>
      <h1 style={{ marginBottom: 2 }}>{r.name}</h1>
      <p className="subtle" style={{ margin: "0 0 4px" }}>
        {r.cuisine} · {r.address}
      </p>
      <p className="subtle" style={{ margin: 0 }}>
        All times shown in restaurant-local time ({r.timezone}) · tables:{" "}
        {tables.rows.map((t) => `${t.label} (${t.capacity})`).join(", ")}
      </p>
      <Booker
        restaurant={{ id: r.id, name: r.name, timezone: r.timezone, slug: r.slug }}
      />
    </>
  );
}
