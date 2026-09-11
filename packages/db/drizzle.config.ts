import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  // Hard fence: drizzle may only ever see the "agents" schema. Without this a stray
  // `drizzle-kit push` against the shared Supabase project (TM1) would diff the CRM
  // schemas and offer to drop ops.hcp_records, ops.clients, ops.apollo_accounts.
  schemaFilter: ["agents"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/tm_voice" },
});
