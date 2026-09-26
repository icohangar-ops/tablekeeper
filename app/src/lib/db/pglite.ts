// Embedded Postgres 17 (WASM) — used when DATABASE_URL is not set.
// Same engine, same SQL, same exclusion constraint as production.
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import type { Executor, QueryResult, Row, SqlClient } from "./sql";

export class PgLiteClient implements SqlClient {
  private readonly db: PGlite;

  constructor(dataDir?: string) {
    this.db = dataDir
      ? new PGlite(dataDir, { extensions: { btree_gist } })
      : new PGlite({ extensions: { btree_gist } });
  }

  engineName(): string {
    return "pglite";
  }

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    // No params → simple query protocol (multi-statement SQL allowed).
    // An empty-but-present array would force the prepared/extended protocol,
    // which rejects multi-statement strings (migrations).
    const res =
      params.length === 0
        ? await this.db.query<T>(sql)
        : await this.db.query<T>(sql, params as never[]);
    return { rows: res.rows };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const executor: Executor = {
        async query<Q = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<Q>> {
          const res =
            params.length === 0
              ? await tx.query<Q>(sql)
              : await tx.query<Q>(sql, params as never[]);
          return { rows: res.rows };
        },
        async exec(sql: string): Promise<void> {
          await tx.exec(sql); // multi-statement capable
        },
      };
      return fn(executor);
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
