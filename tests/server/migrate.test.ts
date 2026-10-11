import { describe, expect, it } from "vitest";
import { migrate } from "../../src/server/migrate";
import type { Database } from "../../src/server/db";
import type pg from "pg";

class FakeQueryable {
  calls: string[] = [];
  async query<T>(text: string) { this.calls.push(text.replace(/\s+/g, " ").trim()); return { rows: [] as T[], rowCount: 0 }; }
}
describe("database migrations", () => {
  it("pins the migration transaction to a client rather than the pool", async () => {
    const pool = new FakeQueryable(); const client = new FakeQueryable(); let pinned = false;
    const db: Database = { query: pool.query.bind(pool), close: async () => {}, withClient: async work => { pinned = true; return work(client as unknown as pg.PoolClient); } };
    await migrate(db);
    expect(pinned).toBe(true); expect(pool.calls).toEqual([]);
    expect(client.calls[0]).toBe("BEGIN"); expect(client.calls.at(-1)).toBe("COMMIT");
  });
});
