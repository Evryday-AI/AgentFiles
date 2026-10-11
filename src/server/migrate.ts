import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, type Database } from "./db.js";
import { validatedDatabaseUrl } from "./config.js";

const modulePath = fileURLToPath(import.meta.url);
const migrationsPath = join(dirname(modulePath), "migrations");
export const EXPECTED_SCHEMA_VERSION = 3;
export const MIGRATION_LOCK_ID = 742131109;
export interface Migration { version: number; checksum: string; sql: string }
export interface MigrationRow { version: number; checksum: string }

export async function loadMigrations(): Promise<Migration[]> {
  const names = (await readdir(migrationsPath)).filter(name => /^\d{3}_[a-z_]+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(names.map(async name => {
    const sql = await readFile(join(migrationsPath, name), "utf8");
    return { version: Number(name.slice(0, 3)), checksum: createHash("sha256").update(sql).digest("hex"), sql };
  }));
  if (migrations.length !== EXPECTED_SCHEMA_VERSION || migrations.some((m, i) => m.version !== i + 1)) throw new Error("Migration files are incomplete or out of order");
  return migrations;
}

export function ledgerMatches(rows: MigrationRow[], migrations: Migration[], exact = false): boolean {
  return (!exact || rows.length === migrations.length) && rows.length <= migrations.length && rows.every((row, i) => row.version === migrations[i].version && row.checksum === migrations[i].checksum);
}

export async function migrate(database: Database): Promise<void> {
  const migrations = await loadMigrations();
  await database.withClient(async client => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      const { rows } = await client.query<MigrationRow>("SELECT version, checksum FROM schema_migrations ORDER BY version");
      if (!ledgerMatches(rows, migrations)) throw new Error("Migration ledger does not match the installed migration files");
      for (const migration of migrations.slice(rows.length)) {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations(version, checksum) VALUES($1, $2)", [migration.version, migration.checksum]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

if (process.argv[1] === modulePath) {
  let database: Database | undefined;
  try {
    database = createDatabase(validatedDatabaseUrl(process.env));
    await migrate(database);
    console.info("Database migrations complete.");
  } catch {
    console.error("Database migration failed; check configuration and the migration ledger.");
    process.exitCode = 1;
  } finally { await database?.close(); }
}
