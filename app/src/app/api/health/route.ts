// GET /api/health — liveness + invariant self-check.
// Reports whether the exclusion constraint that makes double-booking
// impossible is actually present — the app refuses to claim health without it.
import { ensureReady } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const db = await ensureReady();
  try {
    await db.query(`SELECT 1`);
    const chk = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_constraint
       WHERE conname = 'reservation_no_overlap'
         AND conrelid = 'reservations'::regclass`
    );
    const constraintPresent = chk.rows[0]?.n === 1;
    return Response.json(
      {
        ok: constraintPresent,
        engine: db.engineName(),
        invariant: {
          name: "reservation_no_overlap",
          constraintPresent,
          note: "partial EXCLUDE USING gist on tstzrange(starts_at, ends_at) — I1",
        },
        time: new Date().toISOString(),
      },
      { status: constraintPresent ? 200 : 500 }
    );
  } catch {
    return Response.json(
      { ok: false, error: { code: "INTERNAL", message: "database unreachable" } },
      { status: 503 }
    );
  }
}
