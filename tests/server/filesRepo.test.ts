import { describe, expect, it, vi } from "vitest";
import {
  createFileRecord,
  findFileByCode,
  listFiles,
  claimFileDeletion,
  finalizeFileDeletion,
  setFileDurable,
} from "../../src/server/filesRepo";
import type { Queryable } from "../../src/server/db";
vi.mock("../../src/server/fileCodes", () => ({
  createFileCode: vi.fn(() => "F-ABCDE"),
  FILE_CODE_NAMESPACE_SIZE: 32 ** 5,
  FILE_CODE_ALLOCATION_ATTEMPTS: 32,
}));
import { createFileCode } from "../../src/server/fileCodes";
const at = new Date("2026-06-07T18:00:00Z"),
  expiry = new Date("2026-06-14T18:00:00Z");
const row = {
  id: "synthetic",
  code: "F-ABCDE",
  original_name: "notes.txt",
  storage_key: "synthetic/bytes",
  mime_type: "text/plain",
  size_bytes: "42",
  uploaded_by_type: "api_key",
  uploaded_by_name: "synthetic",
  created_at: at,
  updated_at: at,
  expires_at: expiry,
  is_durable: false,
  deleted_at: null,
  deleted_reason: null,
  lifecycle_state: "active",
  deletion_claim_id: null,
  deletion_claimed_at: null,
  deletion_claim_reason: null,
  sha256: null,
  thumbnail_key: null,
  metadata: {},
};
const input = {
  originalName: "notes.txt",
  storageKey: "synthetic/bytes",
  mimeType: "text/plain",
  sizeBytes: 42,
  uploadedByType: "api_key" as const,
  expiresAt: expiry,
};
class FakeDatabase implements Queryable {
  calls: Array<{ text: string; params: readonly unknown[] }> = [];
  constructor(private responses: Array<unknown[] | Error>) {}
  async withClient<T>(work: (pinned: Queryable) => Promise<T>) {
    return work(this);
  }
  async query<T>(text: string, params: readonly unknown[] = []) {
    this.calls.push({ text: text.replace(/\s+/g, " ").trim(), params });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text) || text.includes("pg_advisory"))
      return { rows: [], rowCount: 0 };
    const response = this.responses.shift() ?? [];
    if (response instanceof Error) throw response;
    return { rows: response as T[], rowCount: response.length };
  }
}
describe("files repository lifecycle protocol", () => {
  it("atomically reserves the code and inserts metadata in one SQL statement", async () => {
    const db = new FakeDatabase([[row]]);
    const record = await createFileRecord({ ...input, code: "F-ABCDE" }, db);
    expect(db.calls).toHaveLength(4);
    expect(db.calls[2].text).toContain("INSERT INTO issued_file_codes");
    expect(db.calls[2].text).toContain("FROM reserved");
    expect(record.lifecycleState).toBe("active");
    expect(record.sizeBytes).toBe(42);
  });
  it("retries a reserved generated code without replaying bytes", async () => {
    const db = new FakeDatabase([[], [{ ...row, code: "F-NEW22" }]]);
    vi.mocked(createFileCode)
      .mockReturnValueOnce("F-ABCDE")
      .mockReturnValueOnce("F-NEW22");
    expect((await createFileRecord(input, db)).code).toBe("F-NEW22");
    expect(db.calls).toHaveLength(5);
  });
  it("bounds retries at32 and distinguishes namespace exhaustion", async () => {
    vi.mocked(createFileCode).mockReturnValue("F-ABCDE");
    for (const count of [1, 32 ** 5]) {
      const db = new FakeDatabase([
        ...Array.from({ length: 32 }, () => []),
        [{ count: String(count) }],
      ]);
      await expect(createFileRecord(input, db)).rejects.toMatchObject({
        statusCode: count === 1 ? 503 : 507,
        code:
          count === 1
            ? "CODE_ALLOCATION_RETRY_EXHAUSTED"
            : "CODE_SPACE_EXHAUSTED",
      });
      expect(db.calls).toHaveLength(36);
    }
  });
  it("does not reassign caller-provided reserved or invalid code", async () => {
    const db = new FakeDatabase([[]]);
    await expect(
      createFileRecord({ ...input, code: "F-ABCDE" }, db),
    ).rejects.toMatchObject({ code: "CODE_ALLOCATION_RETRY_EXHAUSTED" });
    await expect(
      createFileRecord({ ...input, code: "F-OLD01" }, db),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(db.calls.filter(c=>c.text.includes("INSERT INTO issued_file_codes"))).toHaveLength(1);
  });
  it.each(["NaN", "", "-1", String(32**5+1)])("an invalid or incomplete registry count cannot prove exhaustion: %s",async count=>{
    const db=new FakeDatabase([...Array.from({length:32},()=>[]),[{count}]]);
    await expect(createFileRecord(input,db)).rejects.toMatchObject({code:"CODE_ALLOCATION_RETRY_EXHAUSTED",statusCode:503});
  });
  it("propagates non-collision database failure without issuing another code", async () => {
    const error = new Error("synthetic DB unavailable");
    const db = new FakeDatabase([error]);
    await expect(createFileRecord(input, db)).rejects.toBe(error);
    expect(db.calls).toHaveLength(4);
  });
  it("returns missing metadata as null", async () => {
    expect(await findFileByCode("F-ABCDE", new FakeDatabase([[]]))).toBeNull();
  });
  it("uses exactly the fail-closed SQL availability predicate", async () => {
    const db = new FakeDatabase([[row]]);
    await listFiles({ availableAt: at }, db);
    expect(db.calls[0].text).toContain(
      "lifecycle_state = 'active' AND deleted_at IS NULL AND (is_durable OR expires_at > $1)",
    );
    expect(db.calls[0].text).not.toContain("expires_at IS NULL OR");
    expect(db.calls[0].params).toEqual([at, 100, 0]);
  });
  it("locks, rechecks authority with post-lock time, updates and commits retention", async () => {
    const db = new FakeDatabase([
      [row],
      [{ ...row, is_durable: true, expires_at: null }],
    ]);
    const authorize = vi.fn(() => {
      expect(db.calls.at(-1)?.text).toContain("FOR UPDATE");
    });
    const r = await setFileDurable("F-ABCDE", true, db, undefined, {
      now: () => at,
      authorize,
    });
    expect(r.isDurable).toBe(true);
    expect(authorize).toHaveBeenCalledOnce();
    expect(db.calls.map((c) => c.text.split(" ")[0])).toEqual([
      "BEGIN",
      "SELECT",
      "UPDATE",
      "COMMIT",
    ]);
    expect(db.calls[2].params).toEqual(["F-ABCDE", true, null, at, expect.any(String)]);
  });
  it("restoring expiry starts the configured interval after acquiring lock", async () => {
    const db = new FakeDatabase([
      [{ ...row, is_durable: true, expires_at: null }],
      [row],
    ]);
    await setFileDurable("F-ABCDE", false, undefined, db, {
      now: () => at,
      retentionDays: 7,
    });
    expect(db.calls[2].params).toEqual(["F-ABCDE", false, expiry, at, expect.any(String)]);
  });
  it.each([
    [null, 404],
    [{ ...row, expires_at: at }, 410],
    [{ ...row, expires_at: null }, 410],
    [{ ...row, lifecycle_state: "deleting" }, 409],
    [{ ...row, lifecycle_state: "deleted", deleted_at: at }, 404],
  ])("rejects locked unavailable retention %#", async (file, status) => {
    const db = new FakeDatabase([file ? [file] : []]);
    await expect(
      setFileDurable("F-ABCDE", true, db, undefined, { now: () => at }),
    ).rejects.toMatchObject({ statusCode: status });
    expect(db.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(db.calls.some((c) => c.text.startsWith("UPDATE"))).toBe(false);
  });
  it("requires a pinned client for mutations", async () => {
    await expect(
      setFileDurable("F-ABCDE", true, {
        query: async () => ({ rows: [], rowCount: 0 }),
      }),
    ).rejects.toThrow("Pinned database transaction required");
  });
  it("rechecks cleanup expiry under lock and skips a keep that won", async () => {
    const db = new FakeDatabase([
      [{ ...row, is_durable: true, expires_at: null }],
    ]);
    expect(
      await claimFileDeletion("F-ABCDE", "expired", db, () => at),
    ).toBeNull();
    expect(db.calls.map((c) => c.text.split(" ")[0])).toEqual([
      "BEGIN",
      "SELECT",
      "COMMIT",
    ]);
  });
  it("commits a deletion claim before returning it for unlink", async () => {
    const claimed = {
      ...row,
      lifecycle_state: "deleting",
      deletion_claim_id: "synthetic-claim",
      deletion_claimed_at: at,
      deletion_claim_reason: "manual",
    };
    const db = new FakeDatabase([[row], [claimed]]);
    const r = await claimFileDeletion("F-ABCDE", "manual", db, () => at);
    expect(r?.deletionClaimId).toBe("synthetic-claim");
    expect(db.calls.at(-1)?.text).toBe("COMMIT");
    expect(db.calls[2].text).toContain("lifecycle_state='deleting'");
  });
  it("finalizes only the matching committed claim", async () => {
    const db = new FakeDatabase([
      [{ ...row, lifecycle_state: "deleted", deleted_at: at }],
    ]);
    await finalizeFileDeletion("F-ABCDE", "synthetic-claim", db);
    expect(db.calls[0].text).toContain(
      "lifecycle_state='deleting' AND deletion_claim_id=$2",
    );
    expect(db.calls[0].params).toEqual(["F-ABCDE", "synthetic-claim"]);
  });
});
