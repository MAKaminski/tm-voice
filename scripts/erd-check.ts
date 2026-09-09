/**
 * ERD ↔ schema check. `pnpm erd:check` fails when docs/ERD.md's generated block drifts from packages/db/src/schema.ts.
 * `pnpm erd:check --write` regenerates the block. CI runs the check (CLAUDE.md rule 7).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { schema } from "@tm/db/schema";

const START = "<!-- erd:generated -->", END = "<!-- /erd:generated -->";

function render(): string {
  const lines: string[] = ["```", "# table.column  type  [PK|FK->table|UK|NOT NULL]  — generated from packages/db/src/schema.ts; do not hand-edit"];
  for (const t of Object.values(schema)) {
    const cfg = getTableConfig(t);
    const fks = new Map(cfg.foreignKeys.flatMap((fk) => { const r = fk.reference(); return r.columns.map((c, i) => [c.name, getTableName(r.foreignTable) + "." + r.foreignColumns[i]!.name] as const); }));
    const uniques = new Set(cfg.uniqueConstraints.flatMap((u) => u.columns.map((c) => c.name)));
    for (const idx of cfg.indexes) if (idx.config.unique) for (const c of idx.config.columns) if ("name" in c) uniques.add(String(c.name));
    lines.push(`${getTableName(t)}`);
    for (const col of Object.values(getTableColumns(t))) {
      const flags = [col.primary ? "PK" : "", fks.has(col.name) ? `FK->${fks.get(col.name)}` : "", uniques.has(col.name) || col.isUnique ? "UK" : "", col.notNull && !col.primary ? "NOT NULL" : ""].filter(Boolean).join(" ");
      lines.push(`  ${col.name}  ${col.getSQLType()}${flags ? `  [${flags}]` : ""}`);
    }
  }
  lines.push("```");
  return lines.join("\n");
}

const path = new URL("../docs/ERD.md", import.meta.url);
const doc = readFileSync(path, "utf8");
const s = doc.indexOf(START), e = doc.indexOf(END);
if (s < 0 || e < 0) { console.error(`docs/ERD.md must contain ${START} … ${END}`); process.exit(1); }
const current = doc.slice(s + START.length, e).trim();
const fresh = render();
if (process.argv.includes("--write")) {
  writeFileSync(path, doc.slice(0, s + START.length) + "\n" + fresh + "\n" + doc.slice(e));
  console.log("docs/ERD.md regenerated");
} else if (current !== fresh) {
  console.error("docs/ERD.md is out of date with packages/db/src/schema.ts. Run: pnpm erd:check --write");
  process.exit(1);
} else {
  console.log(`erd-check: ${Object.keys(schema).length} tables match docs/ERD.md`);
}
