/** In-process Postgres (PGlite) for tests. Real Postgres semantics incl. triggers; no Docker needed. */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "./schema.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export async function createTestDb() {
  const client = new PGlite();
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const raw = readFileSync(join(migrationsDir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await client.exec(s);
    }
  }
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.close() };
}
