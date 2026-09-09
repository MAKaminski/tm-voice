import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { schema } from "./schema.js";
import type { AnyDb } from "./seed-data.js";

export type Db = AnyDb;
export interface DbHandle { db: AnyDb; close: () => Promise<void>; kind: "postgres" | "pglite" }

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export function isPgliteUrl(url: string): boolean { return url.startsWith("pglite:"); }

/**
 * `postgres://…` → postgres-js (Railway / docker-compose).
 * `pglite:./.data/pglite` → embedded Postgres on disk, migrations auto-applied. Local dev without Docker; never production.
 */
export function createDb(url: string): DbHandle {
  if (isPgliteUrl(url)) {
    const dir = url.slice("pglite:".length) || "./.data/pglite";
    mkdirSync(dir, { recursive: true });
    const client = new PGlite(dir);
    const db = drizzlePglite(client, { schema }) as unknown as AnyDb;
    return { db, kind: "pglite", close: () => client.close() };
  }
  const sql = postgres(url, { max: 10, prepare: false });
  return { db: drizzlePg(sql, { schema }) as unknown as AnyDb, kind: "postgres", close: () => sql.end() };
}

/** Applies every migrations/*.sql in order against a PGlite handle (drizzle's migrator is postgres-js specific). */
export async function applyMigrationsPglite(url: string): Promise<number> {
  const dir = url.slice("pglite:".length) || "./.data/pglite";
  mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  await client.exec(`CREATE TABLE IF NOT EXISTS __tm_migrations (tag text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await client.query<{ tag: string }>("SELECT tag FROM __tm_migrations")).rows.map((r) => r.tag));
  let n = 0;
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    for (const stmt of readFileSync(join(migrationsDir, f), "utf8").split("--> statement-breakpoint")) { const s = stmt.trim(); if (s) await client.exec(s); }
    await client.query("INSERT INTO __tm_migrations (tag) VALUES ($1)", [f]);
    n++;
  }
  await client.close();
  return n;
}
