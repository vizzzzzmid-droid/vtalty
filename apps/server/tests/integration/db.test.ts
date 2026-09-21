import { describe, expect, it } from "vitest";
import { createDb } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { schemaMeta } from "../../src/db/schema.js";

// Runs in CI against the postgres service (DATABASE_URL set).
// Locally: `make test-integration` (starts dev postgres first).
// Skipped when DATABASE_URL is absent so plain `pnpm test` stays hermetic.
const DATABASE_URL = process.env["DATABASE_URL"];
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf("postgres integration", () => {
  it("runs migrations and reads schema_meta", async () => {
    const { db, close } = createDb(DATABASE_URL as string);
    try {
      await runMigrations(db);
      const rows = await db.select().from(schemaMeta);
      expect(Array.isArray(rows)).toBe(true);
    } finally {
      await close();
    }
  });
});
