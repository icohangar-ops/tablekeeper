// CLI entry for `npm run db:migrate` / `npm run db:reset`.
import { getDb, migrate, migrateReset } from "./index";

async function main() {
  const reset = process.argv.includes("--reset");
  const db = getDb();
  try {
    if (reset) {
      await migrateReset(db);
      console.log(`[tablekeeper] schema reset applied (${db.engineName()})`);
    } else {
      await migrate(db);
      console.log(`[tablekeeper] schema applied (${db.engineName()})`);
    }
    const chk = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_constraint
       WHERE conname = 'reservation_no_overlap'
         AND conrelid = 'reservations'::regclass`
    );
    console.log(
      `[tablekeeper] invariant constraint reservation_no_overlap: ` +
        (chk.rows[0]?.n === 1 ? "present ✓" : "MISSING ✗")
    );
    if (chk.rows[0]?.n !== 1) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("[tablekeeper] migration failed:", err);
  process.exit(1);
});
