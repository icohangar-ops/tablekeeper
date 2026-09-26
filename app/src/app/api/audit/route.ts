// GET /api/audit?limit=50 — the append-only evidence log.
// The factory's self-check trail: every state transition, visible to judges.
import { ensureReady } from "@/lib/db";
import { errorResponse } from "@/lib/booking/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limitRaw = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 50;
    const db = await ensureReady();
    const res = await db.query(
      `SELECT id, kind, ref_id, detail, created_at
       FROM audit_events ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    return Response.json({ events: res.rows, count: res.rows.length });
  } catch (err) {
    return errorResponse(err);
  }
}
