// GET /api/restaurants/:id — detail + upcoming service periods
import { ensureReady } from "@/lib/db";
import { errorResponse } from "@/lib/booking/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const db = await ensureReady();

    const rest = await db.query(
      `SELECT id, slug, name, cuisine, timezone, address FROM restaurants WHERE id = $1`,
      [id]
    );
    const restaurant = rest.rows[0];
    if (!restaurant) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "restaurant not found" } },
        { status: 404 }
      );
    }

    const [tables, periods] = await Promise.all([
      db.query(
        `SELECT id, label, capacity, min_party FROM dining_tables
         WHERE restaurant_id = $1 ORDER BY capacity ASC, label ASC`,
        [id]
      ),
      db.query(
        `SELECT id, date_local, meal, start_local, end_local, starts_at_utc, ends_at_utc
         FROM service_periods
         WHERE restaurant_id = $1 AND starts_at_utc >= now()
         ORDER BY starts_at_utc ASC LIMIT 30`,
        [id]
      ),
    ]);

    return Response.json({
      restaurant,
      tables: tables.rows,
      upcomingPeriods: periods.rows,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
