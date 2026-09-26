// POST /api/reservations — hold a table (the anti-double-booking primitive)
//   headers: Idempotency-Key (optional but recommended; retries are safe)
//   body: { restaurantId, startsAt, partySize, guest: { name, email, phone? } }
// GET  /api/reservations?email= — guest booking list
// GET  /api/reservations?code=TK-… — lookup by confirmation code
import { ensureReady } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/booking/errors";
import {
  createHold,
  getReservationByCode,
  listReservationsByEmail,
  type HoldInput,
} from "@/lib/booking/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = (await req.json().catch(() => null)) as Partial<HoldInput> | null;
    if (!raw || typeof raw !== "object") {
      throw new ApiError("VALIDATION_FAILED", "a JSON body is required");
    }
    const input: HoldInput = {
      restaurantId: String(raw.restaurantId ?? ""),
      startsAt: String(raw.startsAt ?? ""),
      partySize: Number(raw.partySize),
      guest: {
        name: String(raw.guest?.name ?? ""),
        email: String(raw.guest?.email ?? ""),
        phone: raw.guest?.phone ? String(raw.guest.phone) : undefined,
      },
    };
    const idempotencyKey = req.headers.get("idempotency-key");
    const deps = { db: await ensureReady() };
    const result = await createHold(deps, input, idempotencyKey);
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const email = url.searchParams.get("email");
    const code = url.searchParams.get("code");
    const deps = { db: await ensureReady() };

    if (code) {
      const found = await getReservationByCode(deps, code);
      if (!found) {
        throw new ApiError("NOT_FOUND", "no reservation with that confirmation code", { code });
      }
      return Response.json({ reservation: found });
    }
    if (email) {
      return Response.json({ reservations: await listReservationsByEmail(deps, email) });
    }
    throw new ApiError("VALIDATION_FAILED", "pass ?email= or ?code=");
  } catch (err) {
    return errorResponse(err);
  }
}
