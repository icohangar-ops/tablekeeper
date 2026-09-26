// GET /api/restaurants/:id/availability?date=YYYY-MM-DD&party=2
// `date` is the restaurant-LOCAL calendar date; defaults to "today" there.
import { ensureReady } from "@/lib/db";
import { errorResponse } from "@/lib/booking/errors";
import { getAvailability } from "@/lib/booking/availability";
import { dateLocalOf } from "@/lib/time/tz";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const partyParam = url.searchParams.get("party");
    const party = partyParam === null ? undefined : Number(partyParam);

    const db = await ensureReady();
    const rest = await db.query<{ timezone: string }>(
      `SELECT timezone FROM restaurants WHERE id = $1`,
      [id]
    );
    const row = rest.rows[0];
    if (!row) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "restaurant not found" } },
        { status: 404 }
      );
    }

    const date = url.searchParams.get("date") ?? dateLocalOf(row.timezone, new Date());
    const view = await getAvailability({ db }, id, date, party);
    return Response.json(view);
  } catch (err) {
    return errorResponse(err);
  }
}
