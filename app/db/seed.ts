// CLI entry for `npm run db:seed` — seeds if empty, against whatever engine
// getDb() resolves (embedded PGlite locally; Postgres when DATABASE_URL set).
import { getDb, migrate } from "../src/lib/db";
import { seedIfEmpty } from "../src/lib/db/seed-data";

async function main() {
  const db = getDb();
  try {
    // Every process owns a fresh embedded database — migrate before seeding.
    await migrate(db);
    await seedIfEmpty(db);
    const res = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM restaurants`
    );
    console.log(
      `[tablekeeper] seed complete (${db.engineName()}): ${res.rows[0]?.n ?? 0} restaurants`
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("[tablekeeper] seed failed:", err);
  process.exit(1);
});
