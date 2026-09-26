// Sweep helper used outside service.ts (availability / health paths).
import { audit } from "./audit";
import type { Executor } from "@/lib/db/sql";

export async function sweepExpiredHoldsForDb(
  tx: Executor,
  restaurantId: string,
  now: Date
): Promise<string[]> {
  const res = await tx.query<{ id: string }>(
    `UPDATE reservations SET status = 'expired', hold_expires_at = NULL, updated_at = $1
     WHERE status = 'held'
       AND hold_expires_at < $1
       AND table_id IN (SELECT id FROM dining_tables WHERE restaurant_id = $2)
     RETURNING id`,
    [now.toISOString(), restaurantId]
  );
  if (res.rows.length > 0) {
    await audit(tx, "holds_swept", null, {
      restaurantId,
      count: res.rows.length,
      ids: res.rows.map((r) => r.id),
    });
  }
  return res.rows.map((r) => r.id);
}

export { audit };
