import { Pool } from "pg";
import { runPostgresMigrations } from "../src/storage/postgresMigrations.js";
import { postgresPoolOptions } from "../src/storage/postgresStore.js";

const dryRun = process.argv.includes("--dry-run");
const pool = new Pool(postgresPoolOptions(process.env));

try {
  const result = await runPostgresMigrations(pool, { dryRun });
  const verb = dryRun ? "would apply" : "applied";
  console.log(`postgres migrations ${verb}: ${result.applied.length ? result.applied.join(", ") : "none"}`);
  console.log(`postgres migrations skipped: ${result.skipped.length ? result.skipped.join(", ") : "none"}`);
} finally {
  await pool.end();
}
