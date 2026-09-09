import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrationsPglite, createDb, isPgliteUrl } from "./client.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
if (isPgliteUrl(url)) {
  console.log(`pglite: applied ${await applyMigrationsPglite(url)} migration(s)`);
} else {
  const h = createDb(url);
  await migrate(h.db as unknown as PostgresJsDatabase, { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), "..", "migrations") });
  await h.close();
  console.log("migrations applied");
}
