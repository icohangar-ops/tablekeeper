// Real Postgres via node-postgres — used when DATABASE_URL is set
// (CI postgres:16 service, Neon/Supabase in production).
import { Pool, type PoolClient } from "pg";
import type { Executor, QueryResult, Row, SqlClient } from "./sql";

export class PgClient implements SqlClient {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  engineName(): string {
    return "postgres";
  }

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    // No params → simple query protocol (multi-statement SQL allowed).
    const res =
      params.length === 0
        ? await this.pool.query(sql)
        : await this.pool.query(sql, params as never[]);
    return { rows: res.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const executor: Executor = {
        async query<Q = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<Q>> {
          const res =
            params.length === 0
              ? await client.query(sql)
              : await client.query(sql, params as never[]);
          return { rows: res.rows as Q[] };
        },
        async exec(sql: string): Promise<void> {
          // No params → simple protocol → multi-statement is allowed.
          await client.query(sql);
        },
      };
      const out = await fn(executor);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // connection already broken — nothing else to do
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
