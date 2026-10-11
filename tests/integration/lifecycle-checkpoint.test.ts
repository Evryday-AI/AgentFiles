import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIntegrationFixture } from "../helpers/integration";
import {
  claimFileDeletion,
  createFileRecord,
  setFileDurable,
} from "../../src/server/filesRepo";
import { cleanupExpiredFiles } from "../../src/server/cleanup";
import { getStorageUsage } from "../../src/server/storage";
import type { Database } from "../../src/server/db";
import type pg from "pg";
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of disposers.splice(0).reverse()) await close();
});
async function fixture(now?: () => Date) {
  const f = await createIntegrationFixture(
    { allowPersistentFiles: true },
    { now },
  );
  disposers.push(f.close);
  return f;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function waitForRowLock(db: Database) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const r = await db.query<{ count: string }>(
      "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'",
    );
    if (Number(r.rows[0].count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected ordered row-lock waiter");
}
describe("real lifecycle checkpoint protocol", () => {
  it("denies keep when the genuine admin session expires during the file-lock wait", async () => {
    const f = await fixture();
    const text = "session expiry lock bytes";
    const file = await f.uploadSynthetic({ text, permissions: "upload" });
    const login = await f.server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: f.config.adminUsername,
        password: "synthetic-unused-fixture-password",
      },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const session = (
      await f.db.query<{ id: string }>(
        "SELECT id FROM admin_sessions WHERE revoked_at IS NULL AND expires_at > clock_timestamp()",
      )
    ).rows[0];
    expect(session).toBeDefined();
    const before = (
      await f.db.query<{ storage_key: string }>(
        "SELECT * FROM files WHERE code=$1", [file.code],
      )
    ).rows;
    const bytesBefore = await getStorageUsage(f.storageRoot);
    const locked = gate(),
      release = gate();
    // A separate pooled client holds the file row while the actual PATCH authenticates.
    const holder = f.db.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SELECT id FROM files WHERE code=$1 FOR UPDATE", [
          file.code,
        ]);
        locked.release();
        await release.promise;
      } finally {
        await client.query("ROLLBACK");
      }
    });
    await locked.promise;
    const keep = f.server.inject({
      method: "PATCH",
      url: `/api/files/${file.code}`,
      headers: { cookie, origin: f.config.publicBaseUrl },
      payload: { durable: true },
    });
    try {
      await waitForRowLock(f.db);
      // Expire the real session only after the retention transaction is waiting.
      // The fresh expiry remains later than its transaction-start now().
      await f.db.query(
        "UPDATE admin_sessions SET expires_at=clock_timestamp() WHERE id=$1",
        [session.id],
      );
      expect(
        (
          await f.db.query<{ count: string }>(
            `SELECT count(*) FROM pg_stat_activity
             WHERE datname=current_database() AND wait_event_type='Lock'
               AND query LIKE '%FOR UPDATE%'
               AND xact_start < (SELECT expires_at FROM admin_sessions WHERE id=$1)`,
            [session.id],
          )
        ).rows[0].count,
      ).toBe("1");
      const boundary = (
        await f.db.query<{ expired: boolean; file_available: boolean }>(
          `SELECT expires_at <= clock_timestamp() AS expired,
             EXISTS(SELECT 1 FROM files WHERE code=$2 AND expires_at > clock_timestamp()) AS file_available
           FROM admin_sessions WHERE id=$1`,
          [session.id, file.code],
        )
      ).rows[0];
      expect(boundary).toEqual({ expired: true, file_available: true });
    } finally {
      release.release();
      await holder;
    }
    const response = await keep;
    expect(response.statusCode).toBe(401);
    expect(response.json()).not.toHaveProperty("durable", true);
    expect(
      (await f.db.query("SELECT * FROM files WHERE code=$1", [file.code])).rows,
    ).toEqual(before);
    expect(await getStorageUsage(f.storageRoot)).toEqual(bytesBefore);
    expect(
      await readFile(join(f.storageRoot, before[0].storage_key), "utf8"),
    ).toBe(text);
  });
  it("real SQL exact expiry boundaries deny metadata/private/share and never deliver bytes", async () => {
    const at = new Date("2026-10-10T00:00:00Z");
    const f = await fixture(() => at);
    const file = await f.uploadSynthetic({
      text: "boundary bytes",
      permissions: "upload",
    });
    const key = await f.createSyntheticKey([
      "can_download",
      "can_share",
      "can_mark_durable",
    ]);
    const share = await f.server.inject({
      method: "POST",
      url: `/api/files/${file.code}/share`,
      headers: key.headers,
      payload: { expires_at: new Date(at.getTime() + 60000).toISOString() },
    });
    expect(share.statusCode).toBe(201);
    for (const delta of [-1, 0, 1]) {
      await f.db.query("UPDATE files SET expires_at=$2 WHERE code=$1", [
        file.code,
        new Date(at.getTime() + delta),
      ]);
      for (const url of [
        `/api/files/${file.code}`,
        `/api/files/${file.code}/download`,
        new URL(share.json().public_url).pathname,
      ]) {
        const r = await f.server.inject({ url, headers: key.headers });
        expect(r.statusCode).toBe(delta > 0 ? 200 : 410);
        if (delta <= 0) expect(r.body).not.toContain("boundary bytes");
      }
    }
  });
  it("keep holding the lock before expiry commits past expiry and prevents waiting cleanup unlink", async () => {
    const at = new Date("2026-10-10T00:00:00Z");
    const f = await fixture(() => at);
    const file = await f.uploadSynthetic({
      text: "ordered keep bytes",
      permissions: "upload",
    });
    const expiry = new Date(at.getTime() + 1);
    await f.db.query("UPDATE files SET expires_at=$2 WHERE code=$1", [
      file.code,
      expiry,
    ]);
    const entered = gate(),
      finish = gate();
    const keep = setFileDurable(file.code, true, f.db, undefined, {
      now: () => at,
      authorize: async () => {
        entered.release();
        await finish.promise;
      },
    });
    await entered.promise;
    const unlink = vi.fn();
    const cleanup = cleanupExpiredFiles({
      storageRoot: f.storageRoot,
      db: f.db,
      now: expiry,
      deleteStoredFile: unlink,
    });
    await waitForRowLock(f.db);
    finish.release();
    expect((await keep).isDurable).toBe(true);
    expect((await cleanup).deleted).toBe(0);
    expect(unlink).not.toHaveBeenCalled();
    expect((await getStorageUsage(f.storageRoot)).bytes).toBe(18);
  });
  it("a durable manual claim blocks keep, survives unlink failure, and is resumed by shared cleanup", async () => {
    const f = await fixture();
    const file = await f.uploadSynthetic({
      text: "retained bytes",
      permissions: ["can_upload", "can_mark_durable"],
      durable: true,
    });
    const claim = await claimFileDeletion(file.code, "manual", f.db);
    expect(claim?.lifecycleState).toBe("deleting");
    await expect(setFileDurable(file.code, true, f.db)).rejects.toMatchObject({
      statusCode: 409,
      code: "FILE_DELETION_IN_PROGRESS",
    });
    const failed = await cleanupExpiredFiles({
      storageRoot: f.storageRoot,
      db: f.db,
      deleteStoredFile: async () => {
        throw new Error("synthetic failure");
      },
    });
    expect(failed.failed).toBe(1);
    expect((await getStorageUsage(f.storageRoot)).bytes).toBe(14);
    expect(
      (await f.db.query("SELECT lifecycle_state,deletion_claim_id FROM files"))
        .rows,
    ).toEqual([
      {
        lifecycle_state: "deleting",
        deletion_claim_id: claim?.deletionClaimId,
      },
    ]);
    const retry = await cleanupExpiredFiles({
      storageRoot: f.storageRoot,
      db: f.db,
    });
    expect(retry.deleted).toBe(1);
    expect((await getStorageUsage(f.storageRoot)).bytes).toBe(0);
    expect(
      (await f.db.query("SELECT lifecycle_state FROM files")).rows,
    ).toEqual([{ lifecycle_state: "deleted" }]);
  });
  it.each(["before", "ambiguous"])(
    "failed %s retention COMMIT never returns keep success or exposes unverified state",
    async (mode) => {
      const f = await fixture();
      const file = await f.uploadSynthetic({
        text: "uncertain keep",
        permissions: "upload",
      });
      const wrapped: Database = {
        ...f.db,
        withClient: (work) =>
          f.db.withClient((client) =>
            work(
              new Proxy(client, {
                get(target, key) {
                  if (key === "query")
                    return async (sql: string, params?: unknown[]) => {
                      if (sql === "COMMIT") {
                        if (mode === "ambiguous") await target.query(sql);
                        throw new Error("Synthetic commit failure");
                      }
                      return target.query(sql, params);
                    };
                  return Reflect.get(target, key);
                },
              }) as pg.PoolClient,
            ),
          ),
      };
      await expect(setFileDurable(file.code, true, wrapped)).rejects.toThrow(
        "Synthetic commit failure",
      );
      const verified = (
        await f.db.query<{ is_durable: boolean }>(
          "SELECT is_durable FROM files",
        )
      ).rows[0];
      expect(verified.is_durable).toBe(mode === "ambiguous");
    },
  );
  it("registry reservation and file allocation roll back together on a constraint failure", async () => {
    const f = await fixture();
    await expect(
      createFileRecord(
        {
          code: "F-ABCDE",
          originalName: "synthetic",
          storageKey: "synthetic",
          mimeType: "text/plain",
          sizeBytes: -1,
          uploadedByType: "admin",
          expiresAt: new Date(Date.now() + 60000),
        },
        f.db,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await f.db.query("SELECT * FROM issued_file_codes")).rows).toEqual(
      [],
    );
    expect((await f.db.query("SELECT * FROM files")).rows).toEqual([]);
  });
  it("claimed unlink waits for a confirmed claim commit, including ambiguous commit failure", async () => {
    const f = await fixture();
    const file = await f.uploadSynthetic({
      text: "claim commit bytes",
      permissions: "upload",
    });
    let commits = 0;
    const wrapped: Database = {
      ...f.db,
      withClient: (work) =>
        f.db.withClient((client) =>
          work(
            new Proxy(client, {
              get(target, key) {
                if (key === "query")
                  return async (sql: string, params?: unknown[]) => {
                    if (sql === "COMMIT") {
                      await target.query(sql);
                      commits++;
                      throw new Error("Synthetic ambiguous claim commit");
                    }
                    return target.query(sql, params);
                  };
                return Reflect.get(target, key);
              },
            }) as pg.PoolClient,
          ),
        ),
    };
    const unlink = vi.fn();
    await f.db.query(
      "UPDATE files SET expires_at=clock_timestamp()-interval '1 second'",
    );
    const failed = await cleanupExpiredFiles({
      storageRoot: f.storageRoot,
      db: wrapped,
      deleteStoredFile: unlink,
    });
    expect(failed.failed).toBe(1);
    expect(commits).toBe(1);
    expect(unlink).not.toHaveBeenCalled();
    expect(
      (await f.db.query("SELECT lifecycle_state FROM files")).rows,
    ).toEqual([{ lifecycle_state: "deleting" }]);
    expect(
      (await cleanupExpiredFiles({ storageRoot: f.storageRoot, db: f.db }))
        .deleted,
    ).toBe(1);
  });
});
