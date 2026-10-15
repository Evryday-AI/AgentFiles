import type { Queryable } from "./db.js";
import { ledgerMatches, loadMigrations, type MigrationRow } from "./migrate.js";

export const READINESS_TIMEOUT_MS = 2500;
export async function checkReadiness(db: Queryable, expectedVersion: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const migrations = await loadMigrations();
        if (migrations.length !== expectedVersion) return false;
        const { rows } = await db.query<MigrationRow>("SELECT version, checksum FROM schema_migrations ORDER BY version");
        return ledgerMatches(rows, migrations, true);
      })(),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), READINESS_TIMEOUT_MS); }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}
