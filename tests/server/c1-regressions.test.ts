import Fastify from "fastify";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { resolvePrincipal } from "../../src/server/auth";
import { registerFilesRoutes } from "../../src/server/filesRoutes";
import { testConfig } from "../helpers/config";
const at = new Date("2026-10-10T00:00:00Z");
const principal = {
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
const file = {
  id: "synthetic",
  code: "F-ABCDE",
  originalName: "fixture.txt",
  storageKey: "synthetic",
  mimeType: "text/plain",
  sizeBytes: 5,
  uploadedByType: "api_key",
  uploadedByName: "synthetic",
  createdAt: at,
  updatedAt: at,
  expiresAt: new Date(at.getTime() + 1),
  isDurable: false,
  deletedAt: null,
  deletedReason: null,
  sha256: null,
  thumbnailKey: null,
  metadata: {},
  lifecycleState: "active",
} as const;
describe("C1 failing closed regressions", () => {
  it("explicit invalid Bearer cannot inherit cookie authority", async () => {
    const query = vi.fn(async () => ({
      rows: [{ id: "synthetic" }],
      rowCount: 1,
    }));
    expect(
      await resolvePrincipal(
        {
          headers: { authorization: "Bearer invalid" },
          cookies: { agentfiles_admin: "synthetic" },
        } as never,
        { config: testConfig(), db: { query } },
      ),
    ).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    ["at expiry", { expiresAt: at }, 410],
    ["after expiry", { expiresAt: new Date(at.getTime() - 1) }, 410],
    ["temporary null expiry", { expiresAt: null }, 410],
    ["deleted", { deletedAt: at, lifecycleState: "deleted" }, 404],
    ["claim", { lifecycleState: "deleting" }, 410],
    ["before expiry", {}, 200],
  ])(
    "%s protects both metadata and bytes",
    async (_label, overrides, status) => {
      const openDownloadStream = vi.fn(async () => Readable.from(["hello"]));
      const server = Fastify();
      await server.register(registerFilesRoutes, {
        config: testConfig(),
        now: () => at,
        resolvePrincipal: async () => principal,
        repo: {
          findFileByCode: async () => ({ ...file, ...overrides }) as never,
        },
        storage: { openDownloadStream },
      });
      try {
        for (const path of ["", "/download"])
          expect(
            (await server.inject("/api/files/F-ABCDE" + path)).statusCode,
          ).toBe(status);
        if (status !== 200) expect(openDownloadStream).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    },
  );
  it("operator persistence policy returns 403 on patch", async () => {
    const setFileDurable = vi.fn(async () => file as never);
    const server = Fastify();
    await server.register(registerFilesRoutes, {
      config: testConfig({ allowPersistentFiles: false }),
      resolvePrincipal: async () => principal,
      now: () => at,
      repo: { findFileByCode: async () => file as never, setFileDurable },
    });
    try {
      const r = await server.inject({
        method: "PATCH",
        url: "/api/files/F-ABCDE",
        payload: { durable: true },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().code).toBe("PERSISTENCE_DISABLED");
      expect(setFileDurable).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
  it.each([
    "/api/files?limit=garbage",
    "/api/files?limit=0",
    "/api/files?offset=-1",
    "/api/files?durable=maybe",
  ])("rejects malformed pagination %s", async (url) => {
    const listFiles = vi.fn(async () => []);
    const server = Fastify();
    await server.register(registerFilesRoutes, {
      config: testConfig(),
      resolvePrincipal: async () => principal,
      repo: { listFiles },
    });
    try {
      expect((await server.inject(url)).statusCode).toBe(400);
      expect(listFiles).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
