import { Readable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../../src/server/auth";
import { testConfig } from "../helpers/config";
import { registerFilesRoutes, type FilesRoutesDependencies } from "../../src/server/filesRoutes";
import type { FileRecord } from "../../src/server/filesRepo";
import { buildServer } from "../../src/server/index";

const now = new Date("2026-06-07T18:00:00.000Z");
const expiresAt = new Date("2026-06-14T18:00:00.000Z");

const baseConfig = testConfig();

const apiKeyPrincipal: Principal = {
  type: "api_key",
  id: "018f35c2-0000-7000-9000-000000000020",
  name: "Desktop helper",
  can_upload: true,
  can_download: true,
  can_list: true,
  can_delete: true,
  can_mark_durable: true,
  can_share: false,
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
    expiresAt,
    isDurable: false,
    deletedAt: null,
    deletedReason: null,
    sha256: "a".repeat(64),
    thumbnailKey: null,
    metadata: {},
    ...overrides,
  };
}

async function buildTestServer(dependencies: Partial<FilesRoutesDependencies> = {}) {
  const server = Fastify({ logger: false });
  await server.register(registerFilesRoutes, {
    config: baseConfig,
    now: () => now,
    resolvePrincipal: async () => apiKeyPrincipal,
    ...dependencies,
  });
  return server;
}

function multipartBody(
  parts: Array<{ name: string; value: string } | { name: string; filename: string; contentType: string; value: string }>,
) {
  const boundary = "agentfiles-test-boundary";
  const chunks: string[] = [];
  for (const part of parts) {
    chunks.push(`--${boundary}\r\n`);
    if ("filename" in part) {
      chunks.push(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
      );
      chunks.push(`Content-Type: ${part.contentType}\r\n\r\n`);
      chunks.push(part.value);
      chunks.push("\r\n");
    } else {
      chunks.push(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`);
      chunks.push(part.value);
      chunks.push("\r\n");
    }
  }
  chunks.push(`--${boundary}--\r\n`);
  return {
    payload: Buffer.from(chunks.join("")),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

function delayedMultipartBody(
  parts: Array<{ name: string; value: string } | { name: string; filename: string; contentType: string; value: string }>,
) {
  const boundary = "agentfiles-test-boundary";
  async function* chunks() {
    for (const part of parts) {
      yield Buffer.from(`--${boundary}\r\n`);
      if ("filename" in part) {
        yield Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
        );
        yield Buffer.from(`Content-Type: ${part.contentType}\r\n\r\n`);
        yield Buffer.from(part.value);
        yield Buffer.from("\r\n");
      } else {
        yield Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`);
        yield Buffer.from(part.value);
        yield Buffer.from("\r\n");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    yield Buffer.from(`--${boundary}--\r\n`);
  }
  return {
    payload: Readable.from(chunks()),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

describe("file routes", () => {
  it("registers file routes from the root server builder", async () => {
    const server = buildServer(baseConfig);

    const response = await server.inject({ method: "GET", url: "/api/files" });
    const privateUrlResponse = await server.inject({ method: "GET", url: "/files/F-ABCDE" });

    expect(response.statusCode).toBe(401);
    expect(privateUrlResponse.statusCode).toBe(200);
    expect(privateUrlResponse.headers["content-type"]).toContain("text/html");
    expect(privateUrlResponse.body).toContain('<div id="root"></div>');

    await server.close();
  });

  it("streams one upload to storage and creates file metadata", async () => {
    const createdRecord = fileRecord();
    const saveUploadStream = vi.fn(async (input) => {
      let uploaded = "";
      for await (const chunk of input.stream) {
        uploaded += chunk.toString();
      }
      expect(uploaded).toBe("hello");
      expect(input).toMatchObject({
        storageRoot: baseConfig.storageRoot,
        originalName: "hello.txt",
      });
      return {
        storageKey: createdRecord.storageKey,
        sizeBytes: createdRecord.sizeBytes,
        sha256: createdRecord.sha256 ?? "",
      };
    });
    const createFileRecord = vi.fn(async (input) => {
      expect(input).toMatchObject({
        originalName: "hello.txt",
        storageKey: createdRecord.storageKey,
        mimeType: "text/plain",
        sizeBytes: 5,
        uploadedByType: "api_key",
        uploadedByName: "Desktop helper",
        expiresAt,
        isDurable: false,
        sha256: createdRecord.sha256,
      });
      expect(input.code).toMatch(/^F-/);
      return createdRecord;
    });
    const server = await buildTestServer({
      storage: { saveUploadStream },
      repo: { createFileRecord },
    });
    const body = multipartBody([
      { name: "file", filename: "hello.txt", contentType: "text/plain", value: "hello" },
    ]);

    const response = await server.inject({
      method: "POST",
      url: "/api/files",
      ...body,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      code: "F-ABCDE",
      name: "hello.txt",
      size: 5,
      expiry: expiresAt.toISOString(),
      private_url: "http://localhost:3000/files/F-ABCDE",
      api_download_url: "http://localhost:3000/api/files/F-ABCDE/download",
    });
    expect(saveUploadStream).toHaveBeenCalledOnce();
    expect(createFileRecord).toHaveBeenCalledOnce();

    await server.close();
  });

  it("infers video MIME type for agent uploads sent as octet-stream", async () => {
    const createFileRecord = vi.fn(async (input) =>
      fileRecord({
        originalName: input.originalName,
        storageKey: input.storageKey,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
      }),
    );
    const server = await buildTestServer({
      storage: {
        saveUploadStream: vi.fn(async () => ({
          storageKey: "F-ABCDE/F-ABCDE.mp4",
          sizeBytes: 9,
          sha256: "a".repeat(64),
        })),
      },
      repo: { createFileRecord },
    });
    const body = multipartBody([
      {
        name: "file",
        filename: "clip.mp4",
        contentType: "application/octet-stream",
        value: "fakevideo",
      },
    ]);

    const response = await server.inject({ method: "POST", url: "/api/files", ...body });

    expect(response.statusCode).toBe(201);
    expect(createFileRecord).toHaveBeenCalledWith(
      expect.objectContaining({ originalName: "clip.mp4", mimeType: "video/mp4" }),
      undefined,
    );
    expect(response.json()).toMatchObject({ name: "clip.mp4", mime_type: "video/mp4" });

    await server.close();
  });

  it("removes stored bytes when metadata creation fails after upload", async () => {
    const deleteStoredFile = vi.fn(async () => {});
    const server = await buildTestServer({
      storage: {
        saveUploadStream: vi.fn(async () => ({
          storageKey: "F-ABCDE/F-ABCDE.txt",
          sizeBytes: 5,
          sha256: "a".repeat(64),
        })),
        deleteStoredFile,
      },
      repo: {
        createFileRecord: vi.fn(async () => {
          throw new Error("insert failed");
        }),
      },
    });
    const body = multipartBody([
      { name: "file", filename: "hello.txt", contentType: "text/plain", value: "hello" },
    ]);

    const response = await server.inject({ method: "POST", url: "/api/files", ...body });

    expect(response.statusCode).toBe(500);
    expect(deleteStoredFile).toHaveBeenCalledWith(baseConfig.storageRoot, "F-ABCDE/F-ABCDE.txt");

    await server.close();
  });

  it("honors durable upload requests only when the principal can mark durable", async () => {
    const createFileRecord = vi.fn(async (input) =>
      fileRecord({ isDurable: input.isDurable ?? false, expiresAt: input.expiresAt ?? null }),
    );
    const server = await buildTestServer({
      storage: {
        saveUploadStream: vi.fn(async () => ({
          storageKey: "F-ABCDE/F-ABCDE.txt",
          sizeBytes: 5,
          sha256: "a".repeat(64),
        })),
      },
      repo: { createFileRecord },
    });
    const body = multipartBody([
      { name: "durable", value: "true" },
      { name: "file", filename: "hello.txt", contentType: "text/plain", value: "hello" },
    ]);

    const response = await server.inject({ method: "POST", url: "/api/files", ...body });

    expect(response.statusCode).toBe(201);
    expect(createFileRecord).toHaveBeenCalledWith(
      expect.objectContaining({ isDurable: true, expiresAt: null }),
      undefined,
    );
    expect(response.json()).toMatchObject({ durable: true, expiry: null });

    await server.close();
  });

  it("honors durable upload requests when the durable field arrives after the file part", async () => {
    const createFileRecord = vi.fn(async (input) =>
      fileRecord({ isDurable: input.isDurable ?? false, expiresAt: input.expiresAt ?? null }),
    );
    const server = await buildTestServer({
      storage: {
        saveUploadStream: vi.fn(async (input) => {
          for await (const _chunk of input.stream) {
            // Consume the upload stream so following multipart fields can be read.
          }
          return {
            storageKey: "F-ABCDE/F-ABCDE.txt",
            sizeBytes: 5,
            sha256: "a".repeat(64),
          };
        }),
      },
      repo: { createFileRecord },
    });
    const body = delayedMultipartBody([
      { name: "file", filename: "hello.txt", contentType: "text/plain", value: "hello" },
      { name: "durable", value: "true" },
    ]);

    const response = await server.inject({ method: "POST", url: "/api/files", ...body });

    expect(response.statusCode).toBe(201);
    expect(createFileRecord).toHaveBeenCalledWith(
      expect.objectContaining({ isDurable: true, expiresAt: null }),
      undefined,
    );

    await server.close();
  });

  it("rejects multipart uploads with too many fields", async () => {
    const server = await buildTestServer({
      storage: {
        saveUploadStream: vi.fn(async (input) => {
          for await (const _chunk of input.stream) {
            // Drain the file stream.
          }
          return {
            storageKey: "F-ABCDE/F-ABCDE.txt",
            sizeBytes: 5,
            sha256: "a".repeat(64),
          };
        }),
      },
    });
    const fields = Array.from({ length: 21 }, (_value, index) => ({
      name: `field${index}`,
      value: "value",
    }));
    const body = multipartBody([
      ...fields,
      { name: "file", filename: "hello.txt", contentType: "text/plain", value: "hello" },
    ]);

    const response = await server.inject({ method: "POST", url: "/api/files", ...body });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: "Multipart upload exceeds configured limits" });

    await server.close();
  });

  it("lists non-deleted files for principals with list permission", async () => {
    const listFiles = vi.fn(async () => [
      fileRecord(),
      fileRecord({
        code: "F-OLD01",
        expiresAt: new Date("2026-06-07T17:59:59.000Z"),
      }),
    ]);
    const server = await buildTestServer({ repo: { listFiles } });

    const response = await server.inject({ method: "GET", url: "/api/files?limit=10&offset=5" });

    expect(response.statusCode).toBe(200);
    expect(listFiles).toHaveBeenCalledWith(
      { limit: 10, offset: 5, availableAt: now },
      undefined,
    );
    expect(response.json()).toMatchObject({
      files: [{ code: "F-ABCDE", name: "hello.txt", size: 5 }],
    });
    expect(response.json().files).toHaveLength(1);

    await server.close();
  });

  it("returns file metadata for principals with download permission", async () => {
    const server = await buildTestServer({
      repo: { findFileByCode: vi.fn(async () => fileRecord()) },
    });

    const response = await server.inject({ method: "GET", url: "/api/files/F-ABCDE" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      code: "F-ABCDE",
      name: "hello.txt",
      mime_type: "text/plain",
      sha256: "a".repeat(64),
      api_download_url: "http://localhost:3000/api/files/F-ABCDE/download",
    });

    await server.close();
  });

  it("returns 410 for expired non-durable file metadata before cleanup runs", async () => {
    const server = await buildTestServer({
      repo: {
        findFileByCode: vi.fn(async () =>
          fileRecord({ expiresAt: new Date("2026-06-07T17:59:59.000Z") }),
        ),
      },
    });

    const response = await server.inject({ method: "GET", url: "/api/files/F-ABCDE" });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: "File has expired" });

    await server.close();
  });

  it("streams downloads with content headers", async () => {
    const server = await buildTestServer({
      repo: { findFileByCode: vi.fn(async () => fileRecord()) },
      storage: { openDownloadStream: vi.fn(async () => Readable.from(["hello"])) },
    });

    const response = await server.inject({ method: "GET", url: "/api/files/F-ABCDE/download" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="hello.txt"; filename*=UTF-8\'\'hello.txt',
    );
    expect(response.body).toBe("hello");

    await server.close();
  });

  it("does not stream expired non-durable downloads before cleanup runs", async () => {
    const openDownloadStream = vi.fn(async () => Readable.from(["hello"]));
    const server = await buildTestServer({
      repo: {
        findFileByCode: vi.fn(async () =>
          fileRecord({ expiresAt: new Date("2026-06-07T17:59:59.000Z") }),
        ),
      },
      storage: { openDownloadStream },
    });

    const response = await server.inject({ method: "GET", url: "/api/files/F-ABCDE/download" });

    expect(response.statusCode).toBe(410);
    expect(openDownloadStream).not.toHaveBeenCalled();

    await server.close();
  });

  it("sanitizes hostile download filename and MIME metadata before writing headers", async () => {
    const server = await buildTestServer({
      repo: {
        findFileByCode: vi.fn(async () =>
          fileRecord({
            originalName: "evil\"\r\nx-injected: yes-\u2603.txt",
            mimeType: "text/plain\r\nx-injected: yes",
          }),
        ),
      },
      storage: { openDownloadStream: vi.fn(async () => Readable.from(["hello"])) },
    });

    const response = await server.inject({ method: "GET", url: "/api/files/F-ABCDE/download" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    const disposition = String(response.headers["content-disposition"]);
    expect(disposition).toContain('filename="evil__x-injected_ yes-_.txt"');
    expect(disposition).toContain("filename*=UTF-8''evil%22_x-injected%3A%20yes-%E2%98%83.txt");
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).not.toContain("x-injected: yes");
    expect(response.body).toBe("hello");

    await server.close();
  });

  it("toggles durable state and sets a new expiry when durable is removed", async () => {
    const setFileDurable = vi.fn(async (_code, _durable, _expiresAt) =>
      fileRecord({ isDurable: false, expiresAt }),
    );
    const findFileByCode = vi.fn(async () => fileRecord({ isDurable: true, expiresAt: null }));
    const server = await buildTestServer({ repo: { findFileByCode, setFileDurable } });

    const response = await server.inject({
      method: "PATCH",
      url: "/api/files/F-ABCDE",
      payload: { durable: false },
    });

    expect(response.statusCode).toBe(200);
    expect(findFileByCode).toHaveBeenCalledWith("F-ABCDE", undefined);
    expect(setFileDurable).toHaveBeenCalledWith("F-ABCDE", false, expiresAt, undefined);
    expect(response.json()).toMatchObject({ code: "F-ABCDE", durable: false });

    await server.close();
  });

  it("returns 404 when patching a missing or deleted file", async () => {
    const setFileDurable = vi.fn(async () => fileRecord({ isDurable: true, expiresAt: null }));
    const server = await buildTestServer({
      repo: {
        findFileByCode: vi.fn(async () => null),
        setFileDurable,
      },
    });

    const response = await server.inject({
      method: "PATCH",
      url: "/api/files/F-MISS",
      payload: { durable: true },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "File not found" });
    expect(setFileDurable).not.toHaveBeenCalled();

    await server.close();
  });

  it("returns 410 when patching an expired non-durable file before cleanup runs", async () => {
    const setFileDurable = vi.fn(async () => fileRecord({ isDurable: true, expiresAt: null }));
    const server = await buildTestServer({
      repo: {
        findFileByCode: vi.fn(async () =>
          fileRecord({ expiresAt: new Date("2026-06-07T17:59:59.000Z") }),
        ),
        setFileDurable,
      },
    });

    const response = await server.inject({
      method: "PATCH",
      url: "/api/files/F-ABCDE",
      payload: { durable: true },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: "File has expired" });
    expect(setFileDurable).not.toHaveBeenCalled();

    await server.close();
  });

  it("returns 410 when a non-durable file expires during a durable patch race", async () => {
    const findFileByCode = vi
      .fn()
      .mockResolvedValueOnce(fileRecord({ expiresAt }))
      .mockResolvedValueOnce(fileRecord({ expiresAt: new Date("2026-06-07T17:59:59.000Z") }));
    const setFileDurable = vi.fn(async () => {
      throw new Error("File not found: F-ABCDE");
    });
    const server = await buildTestServer({
      repo: { findFileByCode, setFileDurable },
    });

    const response = await server.inject({
      method: "PATCH",
      url: "/api/files/F-ABCDE",
      payload: { durable: true },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: "File has expired" });
    expect(setFileDurable).toHaveBeenCalledWith("F-ABCDE", true, undefined);

    await server.close();
  });

  it("deletes stored bytes and marks file metadata deleted", async () => {
    const deleteStoredFile = vi.fn(async () => {});
    const markFileDeleted = vi.fn(async () => fileRecord({ deletedAt: now }));
    const server = await buildTestServer({
      repo: {
        findFileByCode: vi.fn(async () => fileRecord()),
        markFileDeleted,
      },
      storage: { deleteStoredFile },
    });

    const response = await server.inject({ method: "DELETE", url: "/api/files/F-ABCDE" });

    expect(response.statusCode).toBe(200);
    expect(deleteStoredFile).toHaveBeenCalledWith(baseConfig.storageRoot, "F-ABCDE/F-ABCDE.txt");
    expect(markFileDeleted).toHaveBeenCalledWith("F-ABCDE", undefined);
    expect(deleteStoredFile.mock.invocationCallOrder[0]).toBeLessThan(
      markFileDeleted.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(response.json()).toMatchObject({ deleted: true, code: "F-ABCDE" });

    await server.close();
  });

  it("returns a clear failure when metadata cannot be marked after byte deletion", async () => {
    const deleteStoredFile = vi.fn(async () => {});
    const markFileDeleted = vi.fn(async () => {
      throw new Error("update failed");
    });
    const server = await buildTestServer({
      repo: {
        findFileByCode: vi.fn(async () => fileRecord()),
        markFileDeleted,
      },
      storage: { deleteStoredFile },
    });

    const response = await server.inject({ method: "DELETE", url: "/api/files/F-ABCDE" });

    expect(response.statusCode).toBe(500);
    expect(deleteStoredFile).toHaveBeenCalledWith(baseConfig.storageRoot, "F-ABCDE/F-ABCDE.txt");
    expect(markFileDeleted).toHaveBeenCalledWith("F-ABCDE", undefined);

    await server.close();
  });

  it("does not hide metadata when stored bytes cannot be deleted", async () => {
    const deleteStoredFile = vi.fn(async () => {
      throw new Error("unlink failed");
    });
    const markFileDeleted = vi.fn(async () => fileRecord({ deletedAt: now }));
    const server = await buildTestServer({
      repo: {
        findFileByCode: vi.fn(async () => fileRecord()),
        markFileDeleted,
      },
      storage: { deleteStoredFile },
    });

    const response = await server.inject({ method: "DELETE", url: "/api/files/F-ABCDE" });

    expect(response.statusCode).toBe(500);
    expect(deleteStoredFile).toHaveBeenCalledWith(baseConfig.storageRoot, "F-ABCDE/F-ABCDE.txt");
    expect(markFileDeleted).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      error: "Stored bytes could not be removed; file was not deleted",
    });

    await server.close();
  });

  it("rejects uploads without upload permission", async () => {
    const server = await buildTestServer({
      resolvePrincipal: async () => ({ ...apiKeyPrincipal, can_upload: false }),
    });
    const body = multipartBody([
      { name: "file", filename: "hello.txt", contentType: "text/plain", value: "hello" },
    ]);

    const response = await server.inject({ method: "POST", url: "/api/files", ...body });

    expect(response.statusCode).toBe(403);

    await server.close();
  });
});
