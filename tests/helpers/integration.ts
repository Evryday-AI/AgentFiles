import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createDatabase } from "../../src/server/db";
import { buildServer } from "../../src/server/index";
import { migrate } from "../../src/server/migrate";
import { initializeStorageAssociation } from "../../src/server/storageIdentity";
import { testConfig } from "./config";
import type { AppConfig } from "../../src/server/config";
import {
  createApiKeySecret,
  hashApiKey,
  parseApiKeySecret,
  type Permission,
} from "../../src/server/auth";

const permissions: Permission[] = [
  "can_upload",
  "can_download",
  "can_list",
  "can_delete",
  "can_mark_durable",
  "can_share",
];
export interface IntegrationFileItem {
  code: string;
  name: string;
  expires_at: string | null;
  durable: boolean;
  sha256: string;
  api_download_url: string;
}

export function integrationDatabaseUrl(
  source: NodeJS.ProcessEnv = process.env,
): string {
  if (source.DATABASE_URL !== undefined)
    throw new Error("Generic DATABASE_URL is forbidden for integration tests");
  const raw = source.AGENTFILES_TEST_DATABASE_URL;
  if (!raw)
    throw new Error("Explicit AGENTFILES_TEST_DATABASE_URL is required");
  try {
    const url = new URL(raw);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !url.port ||
      !url.username ||
      !url.password ||
      url.search ||
      url.hash ||
      !/^\/agentfiles_test_[a-f0-9]{12,64}$/.test(url.pathname)
    )
      throw new Error();
    return raw;
  } catch {
    throw new Error(
      "Integration database must be an explicitly provisioned dedicated test database",
    );
  }
}

export async function createOwnedTestDatabase() {
  const baseUrl = integrationDatabaseUrl();
  // The controller provisioned this independent server; only dedicated sibling test databases are created.
  const controller = createDatabase(baseUrl);
  const name = `agentfiles_test_${randomBytes(12).toString("hex")}`;
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  try {
    await controller.query(`CREATE DATABASE "${name}"`);
  } catch {
    await controller.close();
    throw new Error("Dedicated integration database initialization failed");
  }
  const db = createDatabase(url.href);
  let closed = false;
  return {
    db,
    databaseUrl: url.href,
    async disableConnections() {
      await controller.query(
        `ALTER DATABASE "${name}" ALLOW_CONNECTIONS false`,
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      if (
        !/^agentfiles_test_[a-f0-9]{24}$/.test(name) ||
        new URL(baseUrl).pathname === `/${name}`
      )
        throw new Error("Unowned integration database cleanup refused");
      try {
        await db.close();
        await controller.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } finally {
        await controller.close();
      }
    },
  };
}

export async function createIntegrationFixture(
  overrides: Partial<AppConfig> = {},
  dependencies: Omit<NonNullable<Parameters<typeof buildServer>[1]>, "db"> = {},
) {
  const owned = await createOwnedTestDatabase();
  let storageRoot: string;
  try {
    storageRoot = await mkdtemp(join(tmpdir(), "agentfiles-integration-"));
  } catch {
    await owned.close();
    throw new Error("Integration storage initialization failed");
  }
  const db = owned.db;
  let server: ReturnType<typeof buildServer> | undefined;
  const config = testConfig({
    sessionSecret: randomBytes(32).toString("hex"),
    ...overrides,
    databaseUrl: owned.databaseUrl,
    storageRoot,
  });
  try {
    await migrate(db);
    await initializeStorageAssociation(storageRoot,db);
    server = buildServer(config, { db, ...dependencies });
    await server.ready();
  } catch {
    try {
      await server?.close();
    } finally {
      try {
        await db.close();
      } finally {
        try {
          await owned.close();
        } finally {
          await removeOwnedStorage(storageRoot);
        }
      }
    }
    throw new Error("Integration fixture initialization failed");
  }
  let closed = false;
  const readyServer = server;
  async function createSyntheticKey(granted: Permission[] = []) {
    const secret = createApiKeySecret();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO api_keys(name, lookup_id, key_hash, can_upload, can_download, can_list, can_delete, can_mark_durable, can_share)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        "synthetic integration key",
        parseApiKeySecret(secret)!.lookupId,
        await hashApiKey(secret),
        ...permissions.map((p) => granted.includes(p)),
      ],
    );
    return {
      id: rows[0].id,
      secret,
      headers: { authorization: `Bearer ${secret}` },
    };
  }
  async function uploadSynthetic(input: {
    text: string;
    permissions: "upload" | Permission[];
    durable?: boolean;
  }): Promise<IntegrationFileItem> {
    const key = await createSyntheticKey(
      input.permissions === "upload" ? ["can_upload"] : input.permissions,
    );
    const multipart = syntheticMultipart(input.text, input.durable);
    const response = await readyServer.inject({
      method: "POST",
      url: "/api/files",
      headers: { ...key.headers, ...multipart.headers },
      payload: multipart.payload,
    });
    if (response.statusCode !== 201)
      throw new Error("Synthetic fixture upload route failed");
    return response.json<IntegrationFileItem>();
  }
  return {
    db,
    storageRoot,
    server: readyServer,
    config,
    createSyntheticKey,
    uploadSynthetic,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await server.close();
      } finally {
        try {
          await db.close();
        } finally {
          try {
            await owned.close();
          } finally {
            await removeOwnedStorage(storageRoot);
          }
        }
      }
    },
  };
}

export function syntheticMultipart(text: string, durable?: boolean) {
  const boundary = "synthetic-integration-boundary";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.txt"\r\nContent-Type: text/plain\r\n\r\n${text}\r\n` +
        (durable === undefined
          ? ""
          : `--${boundary}\r\nContent-Disposition: form-data; name="durable"\r\n\r\n${durable}\r\n`) +
        `--${boundary}--\r\n`,
    ),
  };
}

async function removeOwnedStorage(storageRoot: string) {
  if (
    dirname(resolve(storageRoot)) !== resolve(tmpdir()) ||
    !resolve(storageRoot).startsWith(
      resolve(join(tmpdir(), "agentfiles-integration-")),
    )
  )
    throw new Error("Unowned integration storage cleanup refused");
  await rm(storageRoot, { recursive: true });
}
