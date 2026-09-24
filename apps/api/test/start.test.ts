import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Production has no other migration step. Before this, migrations were run by hand, and when one was
 * missed — 0010, `call_task.assistant_id` — every query touching `call_task` failed in production for
 * six days: the Calls tab, the dialer's claim, test calls and the TM-OS Call button. Nothing failed at
 * deploy, because nothing checked.
 *
 * So the api migrates before it serves. These tests pin the two properties that make that safe.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pkg = (app: string) => JSON.parse(readFileSync(join(here, "..", "..", app, "package.json"), "utf8")) as { scripts: Record<string, string> };

describe("migrate on deploy", () => {
  it("the api applies migrations before it starts serving, and only serves if they succeed", () => {
    const start = pkg("api").scripts["start"]!;
    const migrate = start.indexOf("packages/db/src/migrate.ts");
    const serve = start.indexOf("src/server.ts");
    expect(migrate).toBeGreaterThanOrEqual(0);
    expect(serve).toBeGreaterThan(migrate);
    // `&&`, not `;`: a failed migration must stop the server starting, so its health check never
    // passes and Railway keeps the previous deployment serving rather than a broken one.
    expect(start.slice(migrate, serve)).toContain("&&");
  });

  it("the worker does not migrate, so two services never race to apply the same migration", () => {
    expect(pkg("worker").scripts["start"]).not.toContain("migrate");
  });
});
