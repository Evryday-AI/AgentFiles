import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../../src/server/auth";
import type { AppConfig } from "../../src/server/config";
import type { Queryable } from "../../src/server/db";
import type { FileRecord } from "../../src/server/filesRepo";
import { buildServer } from "../../src/server/index";
import { registerShareRoutes, type ShareRoutesDependencies } from "../../src/server/shareRoutes";

const now = new Date("2026-06-07T18:00:00.000Z");
const shareExpiresAt = new Date("2026-06-08T18:00:00.000Z");

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

const sharePrincipal: Principal = {
  type: "api_key",
  id: "018f35c2-0000-7000-9000-000000000020",
  name: "Desktop helper",
  can_upload: true,
  can_download: true,
  can_list: true,
  can_delete: true,
  can_mark_durable: true,
  can_share: true,
};

function fileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: "018f35c2-0000-7000-9000-000000000001",
    code: "F-ABCDE",
    originalName: "hello.txt",
    storageKey: "F-ABCDE/F-ABCDE.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    uploadedByType: "api_key",
    uploadedByName: "Desktop helper",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date("2026-06-14T18:00:00.000Z"),
    isDurable: false,
    deletedAt: null,
    deletedReason: null,
    sha256: "a".repeat(64),
    thumbnailKey: null,
    metadata: {},
    ...overrides,
  };
}

function shareRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "018f35c2-0000-7000-9000-000000000030",
    fileId: "018f35c2-0000-7000-9000-000000000001",
    fileCode: "F-ABCDE",
    tokenHash: "stored-token-hash",
    expiresAt: shareExpiresAt,
    maxDownloads: 2,
    downloadCount: 0,
    createdByType: "api_key",
    createdByName: "Desktop helper",
    createdAt: now,
    revokedAt: null,
    file: fileRecord(),
    ...overrides,
  };
}

class FakeQueryable implements Queryable {
  calls: Array<{ text: string; params: readonly unknown[] }> = [];

  constructor(private readonly responses: Array<unknown[]>) {}

  async query<T>(text: string, params: readonly unknown[] = []) {
    this.calls.push({ text: text.replace(/\s+/g, " ").trim(), params });
    const rows = (this.responses.shift() ?? []) as T[];
    return { rows, rowCount: rows.length };
  }
}

const downloadClaimRow = {
  id: "018f35c2-0000-7000-9000-000000000030",
  file_id: "018f35c2-0000-7000-9000-000000000001",
  file_code: "F-ABCDE",
  token_hash: "stored-token-hash",
  expires_at: shareExpiresAt,
  max_downloads: 2,
  download_count: 1,
  created_by_type: "api_key",
  created_by_name: "Desktop helper",
  created_at: now,
  revoked_at: null,
  download_file_id: "018f35c2-0000-7000-9000-000000000001",
  download_file_code: "F-ABCDE",
  download_original_name: "hello.txt",
  download_storage_key: "F-ABCDE/F-ABCDE.txt",
  download_mime_type: "text/plain",
  download_size_bytes: 5,
  download_uploaded_by_type: "api_key",
  download_uploaded_by_name: "Desktop helper",
  download_created_at: now,
  download_updated_at: now,
  download_expires_at: new Date("2026-06-14T18:00:00.000Z"),
  download_is_durable: false,
  download_deleted_at: null,
  download_deleted_reason: null,
  download_sha256: "a".repeat(64),
  download_thumbnail_key: null,
  download_metadata: {},
};

async function buildTestServer(dependencies: Partial<ShareRoutesDependencies> = {}) {
  const server = Fastify({ logger: false });
  await server.register(registerShareRoutes, {
    config: baseConfig,
    now: () => now,
    resolvePrincipal: async () => sharePrincipal,
    ...dependencies,
  });
  return server;
}

describe("share routes", () => {
  it("registers share routes from the root server builder", async () => {
    const server = buildServer(baseConfig);

    const response = await server.inject({
      method: "POST",
      url: "/api/files/F-ABCDE/share",
      payload: { expires_at: shareExpiresAt.toISOString() },
    });

    expect(response.statusCode).toBe(401);

    await server.close();
  });

  it("creates a public share URL for principals with share permission", async () => {
    const createShareLink = vi.fn(async (input) => shareRecord({ tokenHash: input.tokenHash }));
    const server = await buildTestServer({
      repo: {
        findFileByCode: vi.fn(async () => fileRecord()),
        createShareLink,
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/files/F-ABCDE/share",
      payload: {
        expires_at: shareExpiresAt.toISOString(),
        max_downloads: 2,
      },
    });
    const body = response.json();
    const token = new URL(body.public_url).pathname.split("/").pop();

    expect(response.statusCode).toBe(201);
    expect(body).toMatchObject({
      id: "018f35c2-0000-7000-9000-000000000030",
      file_code: "F-ABCDE",
      expires_at: shareExpiresAt.toISOString(),
      max_downloads: 2,
      download_count: 0,
    });
    expect(body.public_url).toMatch(/^http:\/\/localhost:3000\/s\/[A-Za-z0-9_-]+$/);
    expect(createShareLink).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: "018f35c2-0000-7000-9000-000000000001",
        expiresAt: shareExpiresAt,
        maxDownloads: 2,
        createdByType: "api_key",
        createdByName: "Desktop helper",
      }),
      undefined,
    );
    expect(createShareLink.mock.calls[0]?.[0].tokenHash).not.toBe(token);

    await server.close();
  });

  it("rejects share creation for expired non-durable files", async () => {
    const createShareLink = vi.fn();
    const server = await buildTestServer({
      repo: {
        findFileByCode: vi.fn(async () =>
          fileRecord({ expiresAt: new Date("2026-06-07T17:59:59.000Z") }),
        ),
        createShareLink,
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/files/F-ABCDE/share",
      payload: { expires_at: shareExpiresAt.toISOString() },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: "File has expired" });
    expect(createShareLink).not.toHaveBeenCalled();

    await server.close();
  });

  it("rejects share links that outlive non-durable file retention", async () => {
    const createShareLink = vi.fn();
    const server = await buildTestServer({
      repo: {
        findFileByCode: vi.fn(async () =>
          fileRecord({ expiresAt: new Date("2026-06-08T17:00:00.000Z") }),
        ),
        createShareLink,
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/files/F-ABCDE/share",
      payload: { expires_at: shareExpiresAt.toISOString() },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "share expiry cannot be later than the file expiry",
    });
    expect(createShareLink).not.toHaveBeenCalled();

    await server.close();
  });

  it("rejects share creation without share permission", async () => {
    const createShareLink = vi.fn();
    const server = await buildTestServer({
      resolvePrincipal: async () => ({ ...sharePrincipal, can_share: false }),
      repo: { createShareLink },
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/files/F-ABCDE/share",
      payload: { expires_at: shareExpiresAt.toISOString() },
    });

    expect(response.statusCode).toBe(403);
    expect(createShareLink).not.toHaveBeenCalled();

    await server.close();
  });

  it("revokes share links for principals with share permission", async () => {
    const revokeShareLink = vi.fn(async () => shareRecord({ revokedAt: now }));
    const server = await buildTestServer({ repo: { revokeShareLink } });

    const response = await server.inject({
      method: "DELETE",
      url: "/api/share-links/018f35c2-0000-7000-9000-000000000030",
    });

    expect(response.statusCode).toBe(200);
    expect(revokeShareLink).toHaveBeenCalledWith(
      "018f35c2-0000-7000-9000-000000000030",
      undefined,
    );
    expect(response.json()).toMatchObject({ revoked: true });

    await server.close();
  });

  it("streams public downloads without requiring authentication", async () => {
    const resolvePrincipal = vi.fn();
    const claimShareDownload = vi.fn(async () => shareRecord({ downloadCount: 1 }));
    const openDownloadStream = vi.fn(async () => Readable.from(["hello"]));
    const server = await buildTestServer({
      resolvePrincipal,
      repo: { claimShareDownload },
      storage: { openDownloadStream },
    });

    const response = await server.inject({ method: "GET", url: "/s/public-token" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("hello");
    expect(response.headers["content-type"]).toBe("text/plain");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="hello.txt"; filename*=UTF-8\'\'hello.txt',
    );
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(claimShareDownload).toHaveBeenCalledWith(
      expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      now,
      undefined,
    );
    expect(claimShareDownload.mock.calls[0]?.[0]).not.toBe("public-token");
    expect(openDownloadStream).toHaveBeenCalledWith(
      baseConfig.storageRoot,
      "F-ABCDE/F-ABCDE.txt",
    );

    await server.close();
  });

  it("does not stream when the atomic download claim is unavailable", async () => {
    const openDownloadStream = vi.fn();
    const claimShareDownload = vi.fn(async () => null);
    const server = await buildTestServer({
      repo: { claimShareDownload },
      storage: { openDownloadStream },
    });

    const response = await server.inject({ method: "GET", url: "/s/deleted-at-claim" });

    expect(response.statusCode).toBe(410);
    expect(claimShareDownload).toHaveBeenCalledOnce();
    expect(openDownloadStream).not.toHaveBeenCalled();

    await server.close();
  });

  it("claims public downloads with one update gated by the active file row", async () => {
    const client = new FakeQueryable([[downloadClaimRow]]);
    const openDownloadStream = vi.fn(async () => Readable.from(["hello"]));
    const server = await buildTestServer({
      db: client,
      storage: { openDownloadStream },
    });

    const response = await server.inject({ method: "GET", url: "/s/public-token" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("hello");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.text).toContain("UPDATE share_links");
    expect(client.calls[0]?.text).toContain("JOIN files f ON f.id = updated.file_id");
    expect(client.calls[0]?.text).toContain("sl.token_hash = $1");
    expect(client.calls[0]?.text).toContain("sl.revoked_at IS NULL");
    expect(client.calls[0]?.text).toContain("sl.expires_at > $2");
    expect(client.calls[0]?.text).toContain(
      "(f.is_durable OR f.expires_at IS NULL OR f.expires_at > $2)",
    );
    expect(client.calls[0]?.text).toContain(
      "(sl.max_downloads IS NULL OR sl.download_count < sl.max_downloads)",
    );
    expect(client.calls[0]?.text).toContain("f.deleted_at IS NULL");
    expect(client.calls[0]?.params).toEqual([
      expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      now,
    ]);
    expect(client.calls[0]?.params[0]).not.toBe("public-token");
    expect(openDownloadStream).toHaveBeenCalledWith(
      baseConfig.storageRoot,
      "F-ABCDE/F-ABCDE.txt",
    );

    await server.close();
  });

  it("does not stream or increment deleted files rejected at claim time", async () => {
    const client = new FakeQueryable([[]]);
    const openDownloadStream = vi.fn();
    const server = await buildTestServer({
      db: client,
      storage: { openDownloadStream },
    });

    const response = await server.inject({ method: "GET", url: "/s/deleted-at-claim" });

    expect(response.statusCode).toBe(410);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.text).toContain("f.deleted_at IS NULL");
    expect(openDownloadStream).not.toHaveBeenCalled();

    await server.close();
  });

  it("does not stream or increment exhausted public share links", async () => {
    const claimShareDownload = vi.fn(async () => null);
    const openDownloadStream = vi.fn();
    const server = await buildTestServer({
      repo: { claimShareDownload },
      storage: { openDownloadStream },
    });

    const response = await server.inject({ method: "GET", url: "/s/exhausted" });

    expect(response.statusCode).toBe(410);
    expect(claimShareDownload).toHaveBeenCalledOnce();
    expect(openDownloadStream).not.toHaveBeenCalled();

    await server.close();
  });

  it("sanitizes unsafe public download content headers after claim", async () => {
    const claimShareDownload = vi.fn(async () =>
      shareRecord({
        file: fileRecord({
          originalName: "bad\r\nname\";.txt",
          mimeType: "text/plain\r\nx-injected: yes",
        }),
      }),
    );
    const server = await buildTestServer({
      repo: { claimShareDownload },
      storage: { openDownloadStream: vi.fn(async () => Readable.from(["hello"])) },
    });

    const response = await server.inject({ method: "GET", url: "/s/public-token" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="bad_name_.txt"; filename*=UTF-8\'\'bad_name%22%3B.txt',
    );

    await server.close();
  });
});
