import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { request as httpRequest } from "node:http";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { registerFilesRoutes } from "../../src/server/filesRoutes";
import { registerShareRoutes } from "../../src/server/shareRoutes";
import { registerAdminRoutes } from "../../src/server/adminRoutes";
import {
  checkMutationPolicy,
  validateFilename,
} from "../../src/server/requestPolicy";
import { buildServer } from "../../src/server/index";
import { testConfig } from "../helpers/config";
const config = testConfig({ allowPersistentFiles: true });
const admin = { type: "admin", name: "synthetic", isAdmin: true } as const;
const key = {
  type: "api_key",
  id: "synthetic",
  name: "synthetic",
  can_upload: true,
  can_download: true,
  can_list: true,
  can_delete: true,
  can_mark_durable: true,
  can_share: true,
} as const;
describe("request policy", () => {
  it.each(["POST", "PATCH", "DELETE"])(
    "cookie %s requires configured Origin",
    (method) => {
      for (const headers of [
        {},
        { origin: "https://cross.example" },
        { origin: config.publicBaseUrl, "sec-fetch-site": "cross-site" },
      ])
        expect(() =>
          checkMutationPolicy({ method, headers } as never, config, true),
        ).toThrow("Same-origin");
      expect(() =>
        checkMutationPolicy(
          { method, headers: { origin: config.publicBaseUrl } } as never,
          config,
          true,
        ),
      ).not.toThrow();
      expect(() =>
        checkMutationPolicy({ method, headers: {} } as never, config, false),
      ).not.toThrow();
    },
  );
  it("non-browser JSON login works, but cross-site/form login fails", () => {
    expect(() =>
      checkMutationPolicy(
        {
          method: "POST",
          headers: { "content-type": "application/json" },
        } as never,
        config,
        false,
        true,
      ),
    ).not.toThrow();
    expect(() =>
      checkMutationPolicy(
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "sec-fetch-site": "cross-site",
          },
        } as never,
        config,
        false,
        true,
      ),
    ).toThrow();
    expect(() =>
      checkMutationPolicy(
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
        } as never,
        config,
        false,
        true,
      ),
    ).toThrow();
  });
  it("filename limit counts bytes and rejects NUL", () => {
    expect(() => validateFilename("x".repeat(1024))).not.toThrow();
    for (const name of ["x".repeat(1025), "😀".repeat(257), "bad\0.txt"])
      expect(() => validateFilename(name)).toThrow();
  });
  it.each([
    ["POST", "/api/files"],
    ["PATCH", "/api/files/F-ABCDE"],
    ["DELETE", "/api/files/F-ABCDE"],
    ["POST", "/api/files/F-ABCDE/share"],
    ["DELETE", "/api/share-links/12345678-1234-1234-1234-123456789012"],
  ])(
    "cookie %s %s rejects missing/mismatched Origin before mutation",
    async (method, url) => {
      const server = Fastify();
      const repo = {
        createFileRecord: vi.fn(),
        setFileDurable: vi.fn(),
        claimFileDeletion: vi.fn(),
        createShareLink: vi.fn(),
        revokeShareLink: vi.fn(),
      };
      await server.register(registerFilesRoutes, {
        config,
        resolvePrincipal: async () => admin,
        repo,
      });
      await server.register(registerShareRoutes, {
        config,
        resolvePrincipal: async () => admin,
        repo,
      });
      try {
        for (const origin of [undefined, "https://cross.example"]) {
          const r = await server.inject({
            method: method as "POST",
            url,
            headers: origin ? { origin } : {},
            payload: method === "POST" ? {} : undefined,
          });
          expect(r.statusCode).toBe(403);
        }
        for (const spy of Object.values(repo))
          expect(spy).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    },
  );
  it.each([
    ["/api/admin/api-keys", { name: "x", can_upload: "true" }],
    ["/api/admin/api-keys", { name: "x".repeat(129) }],
    ["/api/admin/api-keys", { name: "😀".repeat(33) }],
    ["/api/admin/api-keys", { name: "x", key_hash: "injected" }],
  ])("rejects invalid API-key fields %#", async (url, payload) => {
    const query = vi.fn(async () => ({
      rows: [{ id: "synthetic" }],
      rowCount: 1,
    }));
    const server = Fastify();
    await server.register(cookie, { secret: config.sessionSecret });
    await server.register(registerAdminRoutes, { config, db: { query } });
    await server.ready();
    try {
      const r = await server.inject({
        method: "POST",
        url,
        headers: {
          origin: config.publicBaseUrl,
          cookie: `agentfiles_admin=${encodeURIComponent(server.signCookie("synthetic"))}`,
        },
        payload,
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe("INVALID_INPUT");
      expect(
        query.mock.calls.every(
          ([sql]) => !String(sql).includes("INSERT INTO api_keys"),
        ),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });
  it.each([
    { durable: "true" },
    { durable: 1 },
    { durable: true, secret: "extra" },
  ])("rejects strict retention mutation %#", async (payload) => {
    const setFileDurable = vi.fn();
    const server = Fastify();
    await server.register(registerFilesRoutes, {
      config,
      resolvePrincipal: async () => key,
      repo: { setFileDurable },
    });
    try {
      const r = await server.inject({
        method: "PATCH",
        url: "/api/files/F-ABCDE",
        payload,
      });
      expect(r.statusCode).toBe(400);
      expect(setFileDurable).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
  it.each([
    { expires_at: "tomorrow" },
    { expires_at: "2028-01-01" },
    { expires_at: "2028-01-01T00:00:00Z", max_downloads: "2" },
    { expires_at: "2028-01-01T00:00:00Z", max_downloads: 2147483648 },
    { expires_at: "2028-01-01T00:00:00Z", max_downloads: 1.5 },
    { expires_at: "2028-01-01T00:00:00Z", extra: true },
  ])("rejects invalid share input %#", async (payload) => {
    const createShareLink = vi.fn();
    const server = Fastify();
    await server.register(registerShareRoutes, {
      config,
      resolvePrincipal: async () => key,
      repo: { createShareLink },
    });
    try {
      expect(
        (
          await server.inject({
            method: "POST",
            url: "/api/files/F-ABCDE/share",
            payload,
          })
        ).statusCode,
      ).toBe(400);
      expect(createShareLink).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
  it.each([
    "/api/files/F-INVALID",
    "/api/files/F-ABCD1",
    "/api/share-links/not-uuid",
    "/api/admin/api-keys/not-uuid",
  ])("rejects malformed route parameters %s", async (url) => {
    const server = buildServer(config);
    try {
      expect((await server.inject({ method: "DELETE", url })).statusCode).toBe(
        400,
      );
    } finally {
      await server.close();
    }
  });
  it("limits authentication before Argon2 and ignores spoofed forwarded headers", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const db = { query, withClient: vi.fn(), close: async () => {} };
    const server = buildServer(config, { db });
    try {
      for (let i = 0; i < 120; i++)
        expect(
          (
            await server.inject({
              url: "/api/auth/session",
              headers: {
                authorization: "Bearer malformed",
                "x-forwarded-for": `192.0.2.${i}`,
              },
            })
          ).statusCode,
        ).toBe(200);
      const r = await server.inject({
        url: "/api/auth/session",
        headers: {
          authorization: "Bearer malformed",
          "x-forwarded-for": "192.0.2.200",
        },
      });
      expect(r.statusCode).toBe(429);
      expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
      expect(query).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
  it("upload limit is thirty authenticated requests per principal across IPs", async () => {
    const server = Fastify();
    await server.register(rateLimit, { global: false });
    await server.register(registerFilesRoutes, {
      config,
      resolvePrincipal: async () => key,
    });
    try {
      for (let i = 0; i < 30; i++)
        expect(
          (
            await server.inject({
              method: "POST",
              url: "/api/files",
              payload: {},
              remoteAddress: `127.0.1.${i + 1}`,
            })
          ).statusCode,
        ).not.toBe(429);
      const r = await server.inject({
        method: "POST",
        url: "/api/files",
        payload: {},
        remoteAddress: "127.0.1.40",
      });
      expect(r.statusCode).toBe(429);
      expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
  it("pre-auth JSON body is bounded", async () => {
    const query = vi.fn();
    const server = buildServer(config, {
      db: { query, withClient: vi.fn(), close: async () => {} },
    });
    try {
      const r = await server.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "x", password: "x".repeat(17000) },
      });
      expect(r.statusCode).toBe(413);
      expect(query).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
  it("bounds real HTTP headers before route authentication", async () => {
    const query = vi.fn();
    const server = buildServer(config, {
      db: { query, withClient: vi.fn(), close: async () => {} },
    });
    try {
      const origin = await server.listen({ host: "127.0.0.1", port: 0 });
      const status = await new Promise<number>((resolve) => {
        const request = httpRequest(
          origin + "/api/auth/session",
          { headers: { authorization: "Bearer " + "x".repeat(17000) } },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode!));
          },
        );
        request.end();
      });
      expect(status).toBe(431);
      expect(query).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
  it("public share downloads have an independent 120/minute/IP bucket", async () => {
    const server = buildServer(config, {
      db: {
        query: async () => ({ rows: [], rowCount: 0 }),
        withClient: vi.fn(),
        close: async () => {},
      },
    });
    try {
      for (let i = 0; i < 120; i++)
        expect(
          (await server.inject("/s/synthetic-unknown-token")).statusCode,
        ).toBe(410);
      const limited = await server.inject("/s/synthetic-unknown-token");
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect((await server.inject("/api/auth/session")).statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});
