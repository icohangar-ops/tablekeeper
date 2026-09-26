// GET /api/reservations/:id — status lookup
import { ensureReady } from "@/lib/db";
import { errorResponse } from "@/lib/booking/errors";
import { getReservation } from "@/lib/booking/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const found = await getReservation({ db: await ensureReady() }, id);
    if (!found) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "reservation not found", details: { id } } },
        { status: 404 }
      );
    }
    return Response.json({ reservation: found });
  } catch (err) {
    return errorResponse(err);
  }
}
