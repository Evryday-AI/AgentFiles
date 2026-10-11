import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/fileCodes", () => ({
  createFileCode: vi.fn(() => "F-MOCK1"),
}));

import { createFileCode } from "../../src/server/fileCodes";
import {
  createFileRecord,
  findFileByCode,
  listFiles,
  markFileDeleted,
  setFileDurable,
  type Queryable,
} from "../../src/server/filesRepo";

const createFileCodeMock = vi.mocked(createFileCode);

const createdAt = new Date("2026-06-07T18:00:00.000Z");
const updatedAt = new Date("2026-06-07T18:01:00.000Z");
const expiresAt = new Date("2026-06-14T18:00:00.000Z");

const fileRow = {
  id: "018f35c2-0000-7000-9000-000000000001",
  code: "F-TEST1",
  original_name: "notes.txt",
  storage_key: "2026/06/notes.txt",
  mime_type: "text/plain",
  size_bytes: "42",
  uploaded_by_type: "api_key",
  uploaded_by_name: "Codex Desktop",
  created_at: createdAt,
  updated_at: updatedAt,
  expires_at: expiresAt,
  is_durable: false,
  deleted_at: null,
  deleted_reason: null,
  sha256: "abc123",
  thumbnail_key: null,
  metadata: { source: "test" },
};

class FakeQueryable implements Queryable {
  calls: Array<{ text: string; params: readonly unknown[] }> = [];

  constructor(private readonly responses: Array<unknown[] | Error>) {}

  async query<T>(text: string, params: readonly unknown[] = []) {
    this.calls.push({ text: text.replace(/\s+/g, " ").trim(), params });
    const response = this.responses.shift() ?? [];
    if (response instanceof Error) {
      throw response;
    }
    const rows = response as T[];
    return { rows, rowCount: rows.length };
  }
}

describe("filesRepo", () => {
  beforeEach(() => {
    createFileCodeMock.mockReset();
    createFileCodeMock.mockReturnValue("F-MOCK1");
  });

  it("creates file records with deterministic SQL parameters", async () => {
    const client = new FakeQueryable([[fileRow]]);

    const record = await createFileRecord(
      {
        code: "F-TEST1",
        originalName: "notes.txt",
        storageKey: "2026/06/notes.txt",
        mimeType: "text/plain",
        sizeBytes: 42,
        uploadedByType: "api_key",
        uploadedByName: "Codex Desktop",
        expiresAt,
        isDurable: false,
        sha256: "abc123",
        metadata: { source: "test" },
      },
      client,
    );

    expect(client.calls[0]?.text).toContain("INSERT INTO files");
    expect(client.calls[0]?.params).toEqual([
      "F-TEST1",
      "notes.txt",
      "2026/06/notes.txt",
      "text/plain",
      42,
      "api_key",
      "Codex Desktop",
      expiresAt,
      false,
      "abc123",
      null,
      { source: "test" },
    ]);
    expect(record).toMatchObject({
      code: "F-TEST1",
      originalName: "notes.txt",
      storageKey: "2026/06/notes.txt",
      sizeBytes: 42,
      uploadedByType: "api_key",
      uploadedByName: "Codex Desktop",
      expiresAt,
      isDurable: false,
      deletedReason: null,
      metadata: { source: "test" },
    });
  });

  it("retries generated file code collisions", async () => {
    const duplicateCodeError = Object.assign(
      new Error("duplicate key value violates unique constraint \"files_code_key\""),
      { code: "23505", constraint: "files_code_key" },
    );
    const client = new FakeQueryable([duplicateCodeError, [{ ...fileRow, code: "F-NEW22" }]]);
    createFileCodeMock.mockReturnValueOnce("F-DUP01").mockReturnValueOnce("F-NEW22");

    const record = await createFileRecord(
      {
        originalName: "notes.txt",
        storageKey: "2026/06/notes.txt",
        mimeType: "text/plain",
        sizeBytes: 42,
        uploadedByType: "api_key",
      },
      client,
    );

    expect(record.code).toBe("F-NEW22");
    expect(createFileCodeMock).toHaveBeenCalledTimes(2);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.params[0]).toBe("F-DUP01");
    expect(client.calls[1]?.params[0]).toBe("F-NEW22");
  });

  it("does not retry caller-supplied duplicate file codes", async () => {
    const duplicateCodeError = Object.assign(
      new Error("duplicate key value violates unique constraint \"files_code_key\""),
      { code: "23505", constraint: "files_code_key" },
    );
    const client = new FakeQueryable([duplicateCodeError]);

    await expect(
      createFileRecord(
        {
          code: "F-TEST1",
          originalName: "notes.txt",
          storageKey: "2026/06/notes.txt",
          mimeType: "text/plain",
          sizeBytes: 42,
          uploadedByType: "api_key",
        },
        client,
      ),
    ).rejects.toBe(duplicateCodeError);

    expect(createFileCodeMock).not.toHaveBeenCalled();
    expect(client.calls).toHaveLength(1);
  });

  it("finds active files by code", async () => {
    const client = new FakeQueryable([[fileRow]]);

    const record = await findFileByCode("F-TEST1", client);

    expect(client.calls[0]?.text).toContain("WHERE code = $1 AND deleted_at IS NULL");
    expect(client.calls[0]?.params).toEqual(["F-TEST1"]);
    expect(record?.id).toBe(fileRow.id);
  });

  it("returns null when a file is not found", async () => {
    const client = new FakeQueryable([[]]);

    await expect(findFileByCode("F-MISS1", client)).resolves.toBeNull();
  });

  it("lists active files with filters", async () => {
    const client = new FakeQueryable([[fileRow]]);
    const expiresBefore = new Date("2026-06-15T00:00:00.000Z");
    const availableAt = new Date("2026-06-07T18:00:00.000Z");

    const records = await listFiles(
      {
        isDurable: false,
        uploadedByType: "api_key",
        expiresBefore,
        availableAt,
        limit: 25,
        offset: 50,
      },
      client,
    );

    expect(client.calls[0]?.text).toContain("WHERE deleted_at IS NULL");
    expect(client.calls[0]?.text).toContain("is_durable = $1");
    expect(client.calls[0]?.text).toContain("uploaded_by_type = $2");
    expect(client.calls[0]?.text).toContain("expires_at IS NOT NULL AND expires_at <= $3");
    expect(client.calls[0]?.text).toContain(
      "(is_durable = true OR expires_at IS NULL OR expires_at > $4)",
    );
    expect(client.calls[0]?.text).toContain("ORDER BY created_at DESC, id DESC LIMIT $5 OFFSET $6");
    expect(client.calls[0]?.params).toEqual([false, "api_key", expiresBefore, availableAt, 25, 50]);
    expect(records).toHaveLength(1);
  });

  it("clamps non-finite and fractional pagination values", async () => {
    const client = new FakeQueryable([[fileRow]]);

    await listFiles({ limit: Number.POSITIVE_INFINITY, offset: Number.NaN }, client);

    expect(client.calls[0]?.params).toEqual([1, 0]);

    await listFiles({ limit: 25.9, offset: 50.9 }, client);

    expect(client.calls[1]?.params).toEqual([25, 50]);
  });

  it("can list deleted files when requested", async () => {
    const client = new FakeQueryable([[{ ...fileRow, deleted_at: updatedAt }]]);

    await listFiles({ includeDeleted: true }, client);

    expect(client.calls[0]?.text).not.toContain("deleted_at IS NULL");
  });

  it("marks only active files deleted by code", async () => {
    const deletedRow = { ...fileRow, deleted_at: updatedAt, deleted_reason: "admin_delete" };
    const client = new FakeQueryable([[deletedRow]]);

    const record = await markFileDeleted("F-TEST1", client);

    expect(client.calls[0]?.text).toContain("UPDATE files SET deleted_at = now(), updated_at = now()");
    expect(client.calls[0]?.text).toContain("WHERE code = $1 AND deleted_at IS NULL");
    expect(client.calls[0]?.text).toContain("RETURNING");
    expect(client.calls[0]?.params).toEqual(["F-TEST1"]);
    expect(record?.deletedAt).toEqual(updatedAt);
    expect(record?.deletedReason).toBe("admin_delete");
  });

  it("returns null when deleting a missing or already-deleted file", async () => {
    const client = new FakeQueryable([[]]);

    await expect(markFileDeleted("F-MISS1", client)).resolves.toBeNull();
  });

  it("updates durable state and returns the file", async () => {
    const durableRow = { ...fileRow, is_durable: true, expires_at: null };
    const client = new FakeQueryable([[durableRow]]);

    const record = await setFileDurable("F-TEST1", true, client);

    expect(client.calls[0]?.text).toContain("UPDATE files");
    expect(client.calls[0]?.text).toContain("SET is_durable = $2");
    expect(client.calls[0]?.text).toContain("expires_at = $3");
    expect(client.calls[0]?.text).toContain("WHERE code = $1 AND deleted_at IS NULL");
    expect(client.calls[0]?.text).toContain(
      "(is_durable = true OR expires_at IS NULL OR expires_at > now())",
    );
    expect(client.calls[0]?.params).toEqual(["F-TEST1", true, null]);
    expect(record.isDurable).toBe(true);
    expect(record.expiresAt).toBeNull();
  });

  it("requires and sets a new expiry when removing durable state", async () => {
    const expiringRow = { ...fileRow, is_durable: false, expires_at: expiresAt };
    const client = new FakeQueryable([[expiringRow]]);

    const record = await setFileDurable("F-TEST1", false, expiresAt, client);

    expect(client.calls[0]?.text).toContain("SET is_durable = $2");
    expect(client.calls[0]?.text).toContain("expires_at = $3");
    expect(client.calls[0]?.params).toEqual(["F-TEST1", false, expiresAt]);
    expect(record.isDurable).toBe(false);
    expect(record.expiresAt).toEqual(expiresAt);
  });

  it("rejects durable removal without a replacement expiry", async () => {
    const client = new FakeQueryable([]);

    await expect(
      setFileDurable("F-TEST1", false, undefined as unknown as Date, client),
    ).rejects.toThrow(
      "A new expiry is required when removing durable state.",
    );
    expect(client.calls).toHaveLength(0);
  });

  it("throws when durable state is updated for a missing file", async () => {
    const client = new FakeQueryable([[]]);

    await expect(setFileDurable("F-MISS1", true, client)).rejects.toThrow("File not found: F-MISS1");
  });
});
