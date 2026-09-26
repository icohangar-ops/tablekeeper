// GET /api/restaurants?query=&party= — discover (BUILD_PLAN §4)
import { ensureReady } from "@/lib/db";
import { errorResponse, ApiError } from "@/lib/booking/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const query = (url.searchParams.get("query") ?? "").trim();
    const party = Number(url.searchParams.get("party") ?? "0") || 0;
    if (party < 0 || party > 20) {
      throw new ApiError("VALIDATION_FAILED", "party must be in [0, 20]", { party });
    }
    const db = await ensureReady();
    const res = await db.query(
      `SELECT r.id, r.slug, r.name, r.cuisine, r.timezone, r.address,
              COUNT(t.id)::int AS table_count,
              MIN(t.capacity)::int AS min_capacity,
              MAX(t.capacity)::int AS max_capacity
       FROM restaurants r
       LEFT JOIN dining_tables t ON t.restaurant_id = r.id
       WHERE ($1::text = '' OR r.name ILIKE '%' || $1 || '%' OR r.cuisine ILIKE '%' || $1 || '%')
         AND ($2::int = 0 OR EXISTS (
                SELECT 1 FROM dining_tables x
                WHERE x.restaurant_id = r.id AND x.capacity >= $2::int))
       GROUP BY r.id
       ORDER BY r.name ASC`,
      [query, party]
    );
    return Response.json({ restaurants: res.rows });
  } catch (err) {
    return errorResponse(err);
  }
}
