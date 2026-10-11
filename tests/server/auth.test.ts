import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_COOKIE_NAME,
  createApiKeySecret,
  hashApiKey,
  hashSessionToken,
  parseApiKeySecret,
  resolveAdminPrincipal,
  resolveApiKeyPrincipal,
  verifyApiKeySecret,
  hasPermission,
  type Permission,
} from "../../src/server/auth";
import type { AppConfig } from "../../src/server/config";
import type { Queryable } from "../../src/server/db";

class FakeQueryable implements Queryable {
  calls: Array<{ text: string; params: readonly unknown[] }> = [];

  constructor(private readonly responses: Array<unknown[]>) {}

  async query<T>(text: string, params: readonly unknown[] = []) {
    this.calls.push({ text: text.replace(/\s+/g, " ").trim(), params });
    const rows = (this.responses.shift() ?? []) as T[];
    return { rows, rowCount: rows.length };
  }
}

const baseConfig: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  databaseUrl: "postgres://user:pass@localhost:5432/agentfiles_test",
  storageRoot: join(tmpdir(), "agentfiles-test"),
  sessionSecret: "session-secret-with-at-least-32-characters",
  adminUsername: "admin",
  adminPasswordHash: "$argon2id$v=19$m=65536,t=3,p=4$abc$def",
  retentionDays: 7,
  publicBaseUrl: "http://localhost:3000",
};

describe("API key auth", () => {
  it("hashes and verifies API key secrets", async () => {
    const hash = await hashApiKey("af_test_secret");
    await expect(verifyApiKeySecret(hash, "af_test_secret")).resolves.toBe(true);
    await expect(verifyApiKeySecret(hash, "wrong")).resolves.toBe(false);
  });

  it("generates API key secrets with a non-secret lookup id", () => {
    const secret = createApiKeySecret();
    const parts = secret.split("_");

    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("af");
    expect(parts[1]).toMatch(/^[a-f0-9]{24}$/);
    expect(parts[2]).toMatch(/^[a-f0-9]{64}$/);
    expect(parseApiKeySecret(secret)).toEqual({ lookupId: parts[1] });
    expect(parseApiKeySecret(`${secret}\n`)).toBeNull();
  });

  it.each([
    ["other prefix", `legacy_${"a".repeat(24)}_${"b".repeat(64)}`],
    ["short lookup", `af_${"a".repeat(23)}_${"b".repeat(64)}`],
    ["long lookup", `af_${"a".repeat(25)}_${"b".repeat(64)}`],
    ["short secret", `af_${"a".repeat(24)}_${"b".repeat(63)}`],
    ["long secret", `af_${"a".repeat(24)}_${"b".repeat(65)}`],
    ["uppercase lookup", `af_${"A".repeat(24)}_${"b".repeat(64)}`],
    ["nonhex secret", `af_${"a".repeat(24)}_${"g".repeat(64)}`],
    ["extra separator", `af_${"a".repeat(24)}__${"b".repeat(64)}`],
    ["embedded newline", `af_${"a".repeat(24)}_\n${"b".repeat(63)}`],
    ["oversized secret", `af_${"a".repeat(24)}_${"b".repeat(10_000)}`],
  ])("rejects %s without touching the database", async (_label, secret) => {
    const db = new FakeQueryable([]);

    expect(parseApiKeySecret(secret)).toBeNull();
    await expect(
      resolveApiKeyPrincipal({ headers: { authorization: `Bearer ${secret}` } } as never, db),
    ).resolves.toBeNull();
    expect(db.calls).toHaveLength(0);
  });

  it("resolves API keys by lookup id before verifying the secret", async () => {
    const secret = createApiKeySecret();
    const [, lookupId] = secret.split("_");
    const keyHash = await hashApiKey(secret);
    const apiKeyRow = {
      id: "018f35c2-0000-7000-9000-000000000020",
      name: "Desktop helper",
      key_hash: keyHash,
      can_upload: true,
      can_download: true,
      can_list: true,
      can_delete: false,
      can_mark_durable: false,
      can_share: false,
    };
    const db = new FakeQueryable([[apiKeyRow], [apiKeyRow]]);

    const principal = await resolveApiKeyPrincipal(
      { headers: { authorization: `Bearer ${secret}` } } as never,
      db,
    );

    expect(principal).toMatchObject({ type: "api_key", id: apiKeyRow.id });
    expect(db.calls[0]?.text).toContain("lookup_id = $1");
    expect(db.calls[0]?.params).toEqual([lookupId]);
    expect(db.calls).toHaveLength(2);
  });

  it("rejects malformed API keys without querying the database", async () => {
    const db = new FakeQueryable([]);

    const principal = await resolveApiKeyPrincipal(
      { headers: { authorization: "Bearer af_missing_lookup_piece" } } as never,
      db,
    );

    expect(principal).toBeNull();
    expect(db.calls).toHaveLength(0);
  });

  it("does not resolve an API key when the last-used touch loses a revocation race", async () => {
    const secret = createApiKeySecret();
    const keyHash = await hashApiKey(secret);
    const apiKeyRow = {
      id: "018f35c2-0000-7000-9000-000000000020",
      name: "Desktop helper",
      key_hash: keyHash,
      can_upload: true,
      can_download: true,
      can_list: true,
      can_delete: false,
      can_mark_durable: false,
      can_share: false,
    };
    const db = new FakeQueryable([[apiKeyRow], []]);

    const principal = await resolveApiKeyPrincipal(
      { headers: { authorization: `Bearer ${secret}` } } as never,
      db,
    );

    expect(principal).toBeNull();
    expect(db.calls[1]?.text).toContain("revoked_at IS NULL");
    expect(db.calls[1]?.text).toContain("RETURNING");
  });

  it("does not resolve an admin session when the touch loses a revocation race", async () => {
    const db = new FakeQueryable([[]]);

    const principal = await resolveAdminPrincipal(
      { cookies: { agentfiles_admin: "session-token" }, headers: {} } as never,
      baseConfig,
      db,
    );

    expect(principal).toBeNull();
    expect(db.calls[0]?.text).toContain("UPDATE admin_sessions");
    expect(db.calls[0]?.text).toContain("revoked_at IS NULL");
    expect(db.calls[0]?.text).toContain("RETURNING");
  });

  it("ignores a session token supplied under another cookie name", async () => {
    const db = new FakeQueryable([[{ id: "synthetic-session" }]]);

    await expect(
      resolveAdminPrincipal(
        { cookies: { other_admin: "session-token" }, headers: {} } as never,
        baseConfig,
        db,
      ),
    ).resolves.toBeNull();
    expect(db.calls).toHaveLength(0);
  });

  it("rejects an invalid signature on the AgentFiles session cookie", async () => {
    const db = new FakeQueryable([[{ id: "synthetic-session" }]]);

    await expect(
      resolveAdminPrincipal(
        {
          cookies: { [ADMIN_SESSION_COOKIE_NAME]: "invalid-signed-token" },
          headers: {},
          unsignCookie: () => ({ valid: false, value: "session-token" }),
        } as never,
        baseConfig,
        db,
      ),
    ).resolves.toBeNull();
    expect(db.calls).toHaveLength(0);
  });

  it("looks up only the unsigned value of a valid AgentFiles session cookie", async () => {
    const db = new FakeQueryable([[{ id: "synthetic-session" }]]);

    await expect(
      resolveAdminPrincipal(
        {
          cookies: { [ADMIN_SESSION_COOKIE_NAME]: "signed-session-token" },
          headers: {},
          unsignCookie: () => ({ valid: true, value: "session-token" }),
        } as never,
        baseConfig,
        db,
      ),
    ).resolves.toEqual({ type: "admin", name: "admin", isAdmin: true });
    expect(db.calls[0]?.params).toEqual([hashSessionToken("session-token")]);
  });

  it("checks permissions by flag", () => {
    expect(hasPermission({ can_download: true }, "can_download")).toBe(true);
    expect(hasPermission({ can_delete: false }, "can_delete")).toBe(false);
  });

  it("allows admin principals to use every permission", () => {
    const permissions: Permission[] = [
      "can_upload",
      "can_download",
      "can_list",
      "can_delete",
      "can_mark_durable",
      "can_share",
    ];

    for (const permission of permissions) {
      expect(hasPermission({ type: "admin", name: "admin", isAdmin: true }, permission)).toBe(
        true,
      );
    }
  });

  it("does not grant admin permissions to plain public admin DTOs", () => {
    expect(hasPermission({ type: "admin", name: "admin" }, "can_delete")).toBe(false);
  });
});
