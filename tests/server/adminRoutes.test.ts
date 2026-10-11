import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashApiKey } from "../../src/server/auth";
import { registerAdminRoutes } from "../../src/server/adminRoutes";
import { testConfig } from "../helpers/config";
import type { Queryable } from "../../src/server/db";
import { buildServer } from "../../src/server/index";

class FakeQueryable implements Queryable {
  calls: Array<{ text: string; params: readonly unknown[] }> = [];

  constructor(private readonly responses: Array<unknown[]>) {}

  async query<T>(text: string, params: readonly unknown[] = []) {
    this.calls.push({ text: text.replace(/\s+/g, " ").trim(), params });
    const rows = (this.responses.shift() ?? []) as T[];
    return { rows, rowCount: rows.length };
  }
}

const baseConfig = testConfig();

const tempRoots: string[] = [];

async function buildTestServer(db: Queryable, config: ReturnType<typeof testConfig>) {
  const server = Fastify({ logger: false });
  await server.register(fastifyCookie, {
    secret: config.sessionSecret,
  });
  await server.register(fastifyRateLimit, {
    global: false,
  });
  await server.register(registerAdminRoutes, { config, db });
  return server;
}

describe("admin auth routes", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.each([
    ["production", "local", false], ["development", "public", true],
  ] as const)("uses %s/%s transport cookie policy", async (nodeEnv, deploymentMode, secure) => {
    const config = { ...baseConfig, nodeEnv, deploymentMode, adminPasswordHash: await hashApiKey("synthetic-cookie-password") };
    const server = await buildTestServer(new FakeQueryable([[{ id: "synthetic-session" }]]), config);
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "synthetic-cookie-password" } });
    expect(login.statusCode).toBe(200);
    expect(login.cookies[0]).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    expect(login.cookies[0]?.secure ?? false).toBe(secure);
    expect(server.unsignCookie(login.cookies[0]!.value).valid).toBe(true);
    const logout = await server.inject({ method: "POST", url: "/api/auth/logout" });
    expect(logout.cookies[0]?.secure ?? false).toBe(secure);
    await server.close();
  });

  it.each([
    [false, "127.0.0.1"], [["127.0.0.1"], "192.0.2.10"], [["192.0.2.0/24"], "127.0.0.1"],
  ] as Array<[false | string[], string]>)("applies only the configured trusted proxy addresses: %s", async (trustProxy, expectedIp) => {
    const server = buildServer({ ...baseConfig, trustProxy });
    server.get("/api/test-proxy", async (request) => ({ ip: request.ip }));
    const response = await server.inject({ url: "/api/test-proxy", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "192.0.2.10" } });
    expect(response.json()).toEqual({ ip: expectedIp });
    await server.close();
  });

  it("registers signed cookie support at the root server for sibling routes", async () => {
    const server = buildServer(baseConfig);
    server.get("/api/test-cookie-support", async (request) => ({
      canUnsignCookie: typeof (request as { unsignCookie?: unknown }).unsignCookie === "function",
    }));

    const response = await server.inject({
      method: "GET",
      url: "/api/test-cookie-support",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ canUnsignCookie: true });

    await server.close();
  });

  it("creates an admin session and reports it from the session endpoint", async () => {
    const config = { ...baseConfig, adminPasswordHash: await hashApiKey("correct-password") };
    const db = new FakeQueryable([
      [{ id: "018f35c2-0000-7000-9000-000000000010" }],
      [
        {
          id: "018f35c2-0000-7000-9000-000000000010",
          expires_at: new Date("2026-06-14T18:00:00.000Z"),
          revoked_at: null,
        },
      ],
    ]);
    const server = await buildTestServer(db, config);

    const login = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "correct-password" },
    });
    const cookie = login.cookies[0];

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      authenticated: true,
      principal: { type: "admin", name: "admin" },
    });
    expect(cookie?.name).toBe("agentfiles_admin");
    expect(db.calls[0]?.text).toContain("INSERT INTO admin_sessions");
    expect(db.calls[0]?.params[0]).not.toBe(cookie?.value);

    const session = await server.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies: { agentfiles_admin: cookie?.value ?? "" },
    });

    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      authenticated: true,
      principal: { type: "admin", name: "admin" },
    });
    expect(db.calls[1]?.text).toContain("UPDATE admin_sessions");
    expect(db.calls[1]?.text).toContain("revoked_at IS NULL");
    expect(db.calls[1]?.text).toContain("RETURNING");

    await server.close();
  });

  it("rejects invalid admin login without creating a session", async () => {
    const config = { ...baseConfig, adminPasswordHash: await hashApiKey("correct-password") };
    const db = new FakeQueryable([]);
    const server = await buildTestServer(db, config);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "wrong-password" },
    });

    expect(response.statusCode).toBe(401);
    expect(db.calls).toHaveLength(0);

    await server.close();
  });

  it("accepts bodyless JSON logout requests from older clients", async () => {
    const db = new FakeQueryable([]);
    const server = await buildTestServer(db, baseConfig);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticated: false });
    expect(db.calls).toHaveLength(0);

    await server.close();
  });

  it("rate limits repeated admin login failures", async () => {
    const db = new FakeQueryable([]);
    const server = await buildTestServer(db, baseConfig);
    const responses = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(
        await server.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "admin", password: "wrong-password" },
        }),
      );
    }

    expect(responses.slice(0, 5).map((response) => response.statusCode)).toEqual([
      401, 401, 401, 401, 401,
    ]);
    expect(responses[5]?.statusCode).toBe(429);
    expect(db.calls).toHaveLength(0);

    await server.close();
  });

  it("creates API keys for admins and returns the plaintext secret once", async () => {
    const config = { ...baseConfig, adminPasswordHash: await hashApiKey("correct-password") };
    const apiKeyRow = {
      id: "018f35c2-0000-7000-9000-000000000020",
      name: "Desktop helper",
      lookup_id: "generated-lookup-id",
      key_hash: "$argon2id$stored-hash",
      can_upload: true,
      can_download: true,
      can_list: true,
      can_delete: false,
      can_mark_durable: false,
      can_share: true,
      created_at: new Date("2026-06-07T18:00:00.000Z"),
      last_used_at: null,
      revoked_at: null,
    };
    const db = new FakeQueryable([
      [{ id: "018f35c2-0000-7000-9000-000000000010" }],
      [
        {
          id: "018f35c2-0000-7000-9000-000000000010",
          expires_at: new Date("2026-06-14T18:00:00.000Z"),
          revoked_at: null,
        },
      ],
      [apiKeyRow],
    ]);
    const server = await buildTestServer(db, config);

    const login = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "correct-password" },
    });
    const cookie = login.cookies[0]?.value ?? "";
    const response = await server.inject({
      method: "POST",
      url: "/api/admin/api-keys",
      cookies: { agentfiles_admin: cookie },
      payload: { name: "Desktop helper", can_share: true },
    });
    const body = response.json();

    expect(response.statusCode).toBe(201);
    expect(body.secret).toMatch(/^af_[a-f0-9]{24}_[a-f0-9]{64}$/);
    expect(body.apiKey).toMatchObject({
      id: apiKeyRow.id,
      name: "Desktop helper",
      canShare: true,
      revokedAt: null,
    });
    expect(db.calls[2]?.text).toContain("INSERT INTO api_keys");
    expect(db.calls[2]?.text).toContain("lookup_id");
    expect(db.calls[2]?.params[1]).toBe(body.secret.split("_")[1]);
    expect(db.calls[2]?.params[2]).not.toBe(body.secret);

    await server.close();
  });

  it("returns storage usage for admins", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "agentfiles-storage-"));
    tempRoots.push(storageRoot);
    await writeFile(join(storageRoot, "one.bin"), Buffer.alloc(7));
    const config = {
      ...baseConfig,
      storageRoot,
      adminPasswordHash: await hashApiKey("correct-password"),
    };
    const db = new FakeQueryable([
      [{ id: "018f35c2-0000-7000-9000-000000000010" }],
      [
        {
          id: "018f35c2-0000-7000-9000-000000000010",
          expires_at: new Date("2026-06-14T18:00:00.000Z"),
          revoked_at: null,
        },
      ],
    ]);
    const server = await buildTestServer(db, config);

    const login = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "correct-password" },
    });
    const cookie = login.cookies[0]?.value ?? "";
    const response = await server.inject({
      method: "GET",
      url: "/api/admin/storage-usage",
      cookies: { agentfiles_admin: cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ bytes: 7 });

    await server.close();
  });

  it("rejects storage usage requests without admin authentication", async () => {
    const db = new FakeQueryable([]);
    const server = await buildTestServer(db, baseConfig);

    const response = await server.inject({
      method: "GET",
      url: "/api/admin/storage-usage",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Admin authentication is required" });

    await server.close();
  });
});
