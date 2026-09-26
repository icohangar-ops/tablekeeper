// POST /api/reservations/:id/cancel — terminal cancel; frees the slot
// instantly (the partial EXCLUDE predicate drops terminal rows).
import { ensureReady } from "@/lib/db";
import { errorResponse } from "@/lib/booking/errors";
import { cancelReservation } from "@/lib/booking/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const result = await cancelReservation({ db: await ensureReady() }, id);
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    return errorResponse(err);
  }
}
