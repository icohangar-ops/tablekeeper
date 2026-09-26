// POST /api/reservations/:id/confirm — hold → confirmed (I2: 410 past TTL;
// idempotent: re-confirm replays 200; terminal states → 409 I6)
import { ensureReady } from "@/lib/db";
import { errorResponse } from "@/lib/booking/errors";
import { confirmHold } from "@/lib/booking/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const result = await confirmHold({ db: await ensureReady() }, id);
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    return errorResponse(err);
  }
}
