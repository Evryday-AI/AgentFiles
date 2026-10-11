import { spawnSync } from "node:child_process";
import { createDatabase } from "../../src/server/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadMigrations,
  migrate,
  MIGRATION_LOCK_ID,
} from "../../src/server/migrate";
import { checkReadiness } from "../../src/server/health";
import {
  createOwnedTestDatabase,
  createIntegrationFixture,
} from "../helpers/integration";
import type { Database } from "../../src/server/db";
import type pg from "pg";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});
const legacyInsertFile = `INSERT INTO files(code,original_name,storage_key,mime_type,size_bytes,uploaded_by_type,created_at,is_durable,expires_at,deleted_reason)
  VALUES($1,'fixture.mov','fixture','application/octet-stream',0,'admin','2026-01-01T00:00:00Z',$2,$3,'fixture reason')`;
async function owned() {
  const fixture = await createOwnedTestDatabase();
  disposers.push(fixture.close);
  return fixture;
}
const insertFile = `WITH reserved AS (INSERT INTO issued_file_codes(code) VALUES($1) ON CONFLICT DO NOTHING RETURNING code) INSERT INTO files(code,original_name,storage_key,mime_type,size_bytes,uploaded_by_type,created_at,is_durable,expires_at,deleted_reason)
  SELECT $1,'fixture.mov','fixture','application/octet-stream',0,'admin','2026-01-01T00:00:00Z',$2,$3,'fixture reason' FROM (SELECT code FROM reserved UNION ALL SELECT code FROM issued_file_codes WHERE code=$1) codes`;

describe("real independent PostgreSQL migrations", () => {
  it("migrates twice with an unchanged ordered ledger and expected schema", async () => {
    const { db } = await owned();
    await migrate(db);
    const first = (
      await db.query("SELECT * FROM schema_migrations ORDER BY version")
    ).rows;
    expect(first).toHaveLength(3);
    await migrate(db);
    expect(
      (await db.query("SELECT * FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(first);
    const tables = (
      await db.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname='public'",
      )
    ).rows.map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "files",
        "api_keys",
        "share_links",
        "events",
        "admin_sessions",
        "schema_migrations",
      ]),
    );
    const indexes = (
      await db.query<{ name: string }>(
        "SELECT indexname AS name FROM pg_indexes WHERE schemaname='public'",
      )
    ).rows.map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "files_expires_at_idx",
        "files_deleted_at_idx",
        "api_keys_name_idx",
        "api_keys_lookup_id_idx",
        "share_links_expires_at_idx",
        "share_links_file_id_idx",
        "events_file_id_idx",
        "events_created_at_idx",
        "admin_sessions_expires_at_idx",
      ]),
    );
    await expect(
      db.query(insertFile, ["F-TEST2", false, null]),
    ).rejects.toMatchObject({ code: "23514" });
    await db.query(insertFile, ["F-TEST2", false, "2026-01-08T00:00:00Z"]);
    await expect(
      db.query(insertFile, ["F-TEST2", false, "2026-01-08T00:00:00Z"]),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.query("UPDATE files SET size_bytes=-1"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query("UPDATE files SET uploaded_by_type='invalid'"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query(
        "INSERT INTO share_links(file_id,token_hash,expires_at,created_by_type) VALUES(gen_random_uuid(),'synthetic','2026-01-08','admin')",
      ),
    ).rejects.toMatchObject({ code: "23503" });
    expect(
      (await db.query("SELECT gen_random_uuid() AS id")).rows,
    ).toHaveLength(1);
    expect(
      (
        await db.query(
          "SELECT extname FROM pg_extension WHERE extname='pgcrypto'",
        )
      ).rows,
    ).toEqual([]);
  });

  it("repairs null temporary expiry from creation plus seven days without promoting files", async () => {
    const { db } = await owned();
    await db.query((await loadMigrations())[0].sql);
    await db.query(legacyInsertFile, ["F-ALD22", false, null]);
    await db.query(legacyInsertFile, ["F-KEEP2", true, null]);
    await migrate(db);
    const { rows: unsortedRows } = await db.query<{
      code: string;
      expires_at: Date | null;
      is_durable: boolean;
      mime_type: string;
      deleted_reason: string;
    }>(
      "SELECT code,expires_at,is_durable,mime_type,deleted_reason FROM files ORDER BY code",
    );
    const rows = unsortedRows.sort((a, b) => b.code.localeCompare(a.code));
    expect(rows[0]).toMatchObject({
      code: "F-KEEP2",
      expires_at: null,
      is_durable: true,
      mime_type: "video/quicktime",
      deleted_reason: "fixture reason",
    });
    expect(rows[1]).toMatchObject({
      code: "F-ALD22",
      is_durable: false,
      mime_type: "video/quicktime",
      deleted_reason: "fixture reason",
    });
    expect(rows[1].expires_at?.toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });

  it("rolls back deliberately invalid SQL and all ledger/schema changes", async () => {
    const { db } = await owned();
    const broken: Database = {
      ...db,
      withClient: (work) =>
        db.withClient((client) => {
          const proxy = new Proxy(client, {
            get(target, key) {
              if (key === "query")
                return (sql: string, params?: unknown[]) =>
                  target.query(
                    sql.includes("Compatibility backfill")
                      ? `${sql}\nDELIBERATELY INVALID SQL;`
                      : sql,
                    params,
                  );
              return Reflect.get(target, key);
            },
          });
          return work(proxy as pg.PoolClient);
        }),
    };
    await expect(migrate(broken)).rejects.toMatchObject({ code: "42601" });
    expect(
      (
        await db.query<{ ledger: string | null; files: string | null }>(
          "SELECT to_regclass('schema_migrations') AS ledger, to_regclass('files') AS files",
        )
      ).rows[0],
    ).toEqual({ ledger: null, files: null });
    await migrate(db);
    expect(await checkReadiness(db, 3)).toBe(true);
  });

  it("rolls back pending SQL while preserving an already applied ledger", async () => {
    const { db } = await owned();
    const [first] = await loadMigrations();
    await db.query(first.sql);
    await db.query(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    await db.query(
      "INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",
      [first.version, first.checksum],
    );
    await db.query(legacyInsertFile, ["F-ALD22", false, null]);
    const before = (
      await db.query("SELECT * FROM schema_migrations ORDER BY version")
    ).rows;
    const broken: Database = {
      ...db,
      withClient: (work) =>
        db.withClient((client) =>
          work(
            new Proxy(client, {
              get(target, key) {
                if (key === "query")
                  return (sql: string, params?: unknown[]) =>
                    target.query(
                      sql.includes("Compatibility backfill")
                        ? `${sql}\nDELIBERATELY INVALID SQL;`
                        : sql,
                      params,
                    );
                return Reflect.get(target, key);
              },
            }) as pg.PoolClient,
          ),
        ),
    };
    await expect(migrate(broken)).rejects.toMatchObject({ code: "42601" });
    expect(
      (await db.query("SELECT * FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(before);
    expect(
      (await db.query("SELECT expires_at,mime_type FROM files")).rows[0],
    ).toEqual({ expires_at: null, mime_type: "application/octet-stream" });
  });

  it("serializes concurrent migrations with a real transaction advisory lock", async () => {
    const { db } = await owned();
    let tasks: Promise<void>[] = [];
    await db.withClient(async (holder) => {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1)", [
        MIGRATION_LOCK_ID,
      ]);
      tasks = [migrate(db), migrate(db)];
      // Attach handlers before deliberately blocking both migration clients.
      const completed = Promise.all(tasks);
      completed.catch(() => {});
      try {
        const deadline = Date.now() + 1000;
        let waiting = 0;
        do {
          waiting = Number(
            (
              await db.query<{ count: string }>(
                "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted",
                [MIGRATION_LOCK_ID],
              )
            ).rows[0].count,
          );
          if (waiting < 2)
            await new Promise((resolve) => setTimeout(resolve, 10));
        } while (waiting < 2 && Date.now() < deadline);
        expect(waiting).toBe(2);
        expect(
          (
            await db.query<{ name: string | null }>(
              "SELECT to_regclass('schema_migrations') AS name",
            )
          ).rows[0].name,
        ).toBeNull();
      } finally {
        await holder.query("COMMIT");
      }
    });
    await Promise.all(tasks);
    expect(
      (await db.query("SELECT * FROM schema_migrations ORDER BY version")).rows,
    ).toHaveLength(3);
    expect(await checkReadiness(db, 3)).toBe(true);
  });

  it("refuses changed checksums without changing the ledger", async () => {
    const { db } = await owned();
    await migrate(db);
    await db.query(
      "UPDATE schema_migrations SET checksum='synthetic-invalid-checksum' WHERE version=1",
    );
    const before = (
      await db.query("SELECT * FROM schema_migrations ORDER BY version")
    ).rows;
    await expect(migrate(db)).rejects.toThrow(
      "Migration ledger does not match",
    );
    expect(
      (await db.query("SELECT * FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(before);
    expect(await checkReadiness(db, 3)).toBe(false);
  });

  it("reports false before migrations, with a version gap/future version, and after DB close", async () => {
    const { db } = await owned();
    expect(await checkReadiness(db, 3)).toBe(false);
    await migrate(db);
    expect(await checkReadiness(db, 3)).toBe(true);
    await db.query("UPDATE schema_migrations SET version=4 WHERE version=3");
    expect(await checkReadiness(db, 3)).toBe(false);
    await expect(migrate(db)).rejects.toThrow(
      "Migration ledger does not match",
    );
    await db.close();
    expect(await checkReadiness(db, 3)).toBe(false);
  });

  it("fails readiness when the owned PostgreSQL database refuses new connections", async () => {
    const fixture = await owned();
    await migrate(fixture.db);
    await fixture.db.close();
    await fixture.disableConnections();
    const disconnected = createDatabase(fixture.databaseUrl);
    try {
      expect(await checkReadiness(disconnected, 3)).toBe(false);
    } finally {
      await disconnected.close();
    }
  });

  it("enforces bounded statement and client queries even with URL timeout overrides", async () => {
    const fixture = await owned();
    const bounded = createDatabase(
      fixture.databaseUrl +
        "?statement_timeout=90000&query_timeout=90000&options=-c%20statement_timeout%3D0",
    );
    try {
      expect(
        (
          await bounded.query<{ statement_timeout: string }>(
            "SHOW statement_timeout",
          )
        ).rows[0].statement_timeout,
      ).toBe("2500ms");
      await expect(bounded.query("SELECT pg_sleep(5)")).rejects.toThrow();
      expect((await bounded.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    } finally {
      await bounded.close();
    }
  });

  it("runs the CLI using only DATABASE_URL and reports failures without credentials", async () => {
    const fixture = await owned();
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        /^(?:PG.*|DATABASE_URL|AGENTFILES_TEST_DATABASE_URL|ADMIN_PASSWORD_HASH|SESSION_SECRET|POSTGRES_.*)$/.test(
          key,
        )
      )
        delete env[key];
    env.DATABASE_URL = fixture.databaseUrl;
    env.ADMIN_PASSWORD_HASH = "synthetic-invalid-unrelated-admin-setting";
    env.SESSION_SECRET = "synthetic-invalid-unrelated-admin-setting";
    const run = () =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", "src/server/migrate.ts"],
        { env, encoding: "utf8", timeout: 10000 },
      );
    const success = run();
    expect(success.status).toBe(0);
    expect(await checkReadiness(fixture.db, 3)).toBe(true);
    await fixture.db.query(
      "UPDATE schema_migrations SET checksum='synthetic-invalid-checksum' WHERE version=1",
    );
    const failed = run();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("Database migration failed");
    for (const result of [success, failed]) {
      const output = `${result.stdout}${result.stderr}`;
      expect(output).not.toContain(fixture.databaseUrl);
      expect(output).not.toContain(
        decodeURIComponent(new URL(fixture.databaseUrl).password),
      );
    }
  });

  it("serves truthful readiness from the isolated migrated fixture", async () => {
    const fixture = await createIntegrationFixture();
    disposers.push(fixture.close);
    const ready = await fixture.server.inject("/api/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ready: true });
    await fixture.db.close();
    expect((await fixture.server.inject("/api/health")).statusCode).toBe(200);
    const down = await fixture.server.inject("/api/ready");
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ ready: false });
  });
});
