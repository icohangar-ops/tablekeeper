// Database factory + migrator. One dialect, two engines:
//   DATABASE_URL set   → PgClient  (real Postgres: CI, production)
//   DATABASE_URL unset → PgLiteClient (embedded Postgres 17 WASM)
// The exclusion constraint behaves identically on both — that is the point.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgClient } from "./pg";
import { PgLiteClient } from "./pglite";
import type { SqlClient } from "./sql";

const globalStore = globalThis as unknown as { __tablekeeperDb?: SqlClient };

export function getDb(): SqlClient {
  if (globalStore.__tablekeeperDb) return globalStore.__tablekeeperDb;
  const url = process.env.DATABASE_URL;
  // Only a real Postgres URL selects the PgClient — anything else (including
  // a stray non-Postgres DATABASE_URL from the surrounding environment) falls
  // back to the embedded engine.
  const isPostgres = !!url && /^postgres(ql)?:\/\//i.test(url);
  const db: SqlClient = isPostgres
    ? new PgClient(url as string)
    : new PgLiteClient(process.env.TK_DATA_DIR || undefined);
  globalStore.__tablekeeperDb = db;
  return db;
}

export function schemaSql(): string {
  // cwd is app/ under `next dev` and `next start`; traced via
  // outputFileTracingIncludes for serverless builds.
  return readFileSync(join(process.cwd(), "db", "schema.sql"), "utf8");
}

/** Idempotent: applies db/schema.sql (CREATE IF NOT EXISTS + constraint swap). */
export async function migrate(db: SqlClient): Promise<void> {
  await db.exec(schemaSql());
}

/** Drop everything, then re-apply the schema. Dev/test convenience only. */
export async function migrateReset(db: SqlClient): Promise<void> {
  await db.exec(`
    DROP TABLE IF EXISTS audit_events CASCADE;
    DROP TABLE IF EXISTS idempotency_records CASCADE;
    DROP TABLE IF EXISTS reservations CASCADE;
    DROP TABLE IF EXISTS service_periods CASCADE;
    DROP TABLE IF EXISTS dining_tables CASCADE;
    DROP TABLE IF EXISTS restaurants CASCADE;
  `);
  await migrate(db);
}

/**
 * Boot sequence, idempotent per process: migrate + seed-if-empty. Required
 * for the embedded engine (each process owns its database) and equally safe
 * against production Postgres (migrations are idempotent; seeding is skipped
 * when restaurants exist). Every entry point awaits this once.
 */
export function ensureReady(): Promise<SqlClient> {
  const store = globalThis as unknown as {
    __tablekeeperReady?: Promise<SqlClient>;
  };
  if (!store.__tablekeeperReady) {
    store.__tablekeeperReady = (async () => {
      const db = getDb();
      await migrate(db);
      const { seedIfEmpty } = await import("./seed-data");
      await seedIfEmpty(db);
      return db;
    })();
  }
  return store.__tablekeeperReady;
}
