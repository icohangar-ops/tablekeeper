// Append-only evidence log. Every state transition lands in audit_events —
// the demo's "the system shows its own work" trail.
import type { Executor } from "@/lib/db/sql";

export type AuditKind =
  | "hold_created"
  | "hold_expired" // single hold expired at confirm attempt
  | "holds_swept" // batched lazy sweep (availability / hold paths)
  | "confirmed"
  | "confirm_replayed"
  | "cancelled"
  | "seat_transition"
  | "conflict_rejected";

export async function audit(
  tx: Executor,
  kind: AuditKind,
  refId: string | null,
  detail: Record<string, unknown>
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (kind, ref_id, detail) VALUES ($1, $2, $3::jsonb)`,
    [kind, refId, JSON.stringify(detail)]
  );
}
