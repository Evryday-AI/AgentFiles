import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createDatabase } from "../../src/server/db";
import { buildServer } from "../../src/server/index";
import { migrate } from "../../src/server/migrate";
import { testConfig } from "./config";
import type { AppConfig } from "../../src/server/config";

export function integrationDatabaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  if (source.DATABASE_URL !== undefined) throw new Error("Generic DATABASE_URL is forbidden for integration tests");
  const raw = source.AGENTFILES_TEST_DATABASE_URL;
  if (!raw) throw new Error("Explicit AGENTFILES_TEST_DATABASE_URL is required");
  try {
    const url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.port || !url.username || !url.password || url.search || url.hash || !/^\/agentfiles_test_[a-f0-9]{12,64}$/.test(url.pathname)) throw new Error();
    return raw;
  } catch { throw new Error("Integration database must be an explicitly provisioned dedicated test database"); }
}

export async function createOwnedTestDatabase() {
  const baseUrl = integrationDatabaseUrl();
  // The controller provisioned this independent server; only dedicated sibling test databases are created.
  const controller = createDatabase(baseUrl);
  const name = `agentfiles_test_${randomBytes(12).toString("hex")}`;
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  try { await controller.query(`CREATE DATABASE "${name}"`); }
  catch { await controller.close(); throw new Error("Dedicated integration database initialization failed"); }
  const db = createDatabase(url.href);
  let closed = false;
  return { db, databaseUrl: url.href, async disableConnections() {
    await controller.query(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS false`);
  }, async close() {
    if (closed) return;
    closed = true;
    if (!/^agentfiles_test_[a-f0-9]{24}$/.test(name) || new URL(baseUrl).pathname === `/${name}`) throw new Error("Unowned integration database cleanup refused");
    try { await db.close(); await controller.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
    finally { await controller.close(); }
  } };
}

export async function createIntegrationFixture(overrides: Partial<AppConfig> = {}) {
  const owned = await createOwnedTestDatabase();
  let storageRoot: string;
  try { storageRoot = await mkdtemp(join(tmpdir(), "agentfiles-integration-")); }
  catch { await owned.close(); throw new Error("Integration storage initialization failed"); }
  const db = owned.db;
  let server: ReturnType<typeof buildServer> | undefined;
  try {
    await migrate(db);
    server = buildServer(testConfig({ sessionSecret: randomBytes(32).toString("hex"), ...overrides, databaseUrl: owned.databaseUrl, storageRoot }), { db });
    await server.ready();
  } catch {
    try { await server?.close(); }
    finally { try { await db.close(); } finally { try { await owned.close(); } finally { await removeOwnedStorage(storageRoot); } } }
    throw new Error("Integration fixture initialization failed");
  }
  let closed = false;
  return { db, storageRoot, server, async close() {
    if (closed) return;
    closed = true;
    try { await server.close(); }
    finally { try { await db.close(); } finally { try { await owned.close(); } finally { await removeOwnedStorage(storageRoot); } } }
  } };
}

async function removeOwnedStorage(storageRoot: string) {
  if (dirname(resolve(storageRoot)) !== resolve(tmpdir()) || !resolve(storageRoot).startsWith(resolve(join(tmpdir(), "agentfiles-integration-")))) throw new Error("Unowned integration storage cleanup refused");
  await rm(storageRoot, { recursive: true });
}
