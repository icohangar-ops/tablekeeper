// One error shape for the whole API (BUILD_PLAN §4):
//   { "error": { "code": "SLOT_TAKEN", "message": "…", "details": { … } } }

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "SLOT_TAKEN"
  | "HOLD_EXPIRED"
  | "INVALID_TRANSITION"
  | "PARTY_TOO_LARGE"
  | "OUTSIDE_SERVICE_HOURS"
  | "DUPLICATE_IDEMPOTENCY_PAYLOAD"
  | "INTERNAL";

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  SLOT_TAKEN: 409,
  HOLD_EXPIRED: 410,
  INVALID_TRANSITION: 409,
  PARTY_TOO_LARGE: 422,
  OUTSIDE_SERVICE_HOURS: 422,
  DUPLICATE_IDEMPOTENCY_PAYLOAD: 422,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }

  body(): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/** Map any thrown error to a Response with the §4 error shape. */
export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json(err.body(), { status: err.status });
  }
  console.error("[tablekeeper] unhandled error:", err);
  return Response.json(
    { error: { code: "INTERNAL", message: "unexpected error" } },
    { status: 500 }
  );
}

// ── Postgres SQLSTATE codes the service branches on ─────────────────────────
export const EXCLUSION_VIOLATION = "23P01"; // reservation_no_overlap → 409
export const UNIQUE_VIOLATION = "23505"; // idempotency key race → retry/replay

export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}
