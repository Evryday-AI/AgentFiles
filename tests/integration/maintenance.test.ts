import { afterEach, describe, expect, it } from "vitest";
import {
  access,
  writeFile,
  mkdir,
  utimes,
  readFile,
  link,
  symlink,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";
import {
  createIntegrationFixture,
  syntheticMultipart,
} from "../helpers/integration";
import { createMaintenanceState } from "../../src/server/maintenanceState";
import { cleanupExpiredFiles } from "../../src/server/cleanup";
import { reconcileStorage } from "../../src/server/reconciliation";
import { createActiveUploads } from "../../src/server/activeUploads";
import { createFileRecord } from "../../src/server/filesRepo";
import { purgeRetainedDetails } from "../../src/server/retention";
import { buildServer } from "../../src/server/index";
import { migrate } from "../../src/server/migrate";
import { initializeStorageAssociation } from "../../src/server/storageIdentity";
import { claimFileDeletion } from "../../src/server/filesRepo";
import { completeDeletion } from "../../src/server/deletion";
import { createMaintenance } from "../../src/server/maintenance";
import { Writable } from "node:stream";

const fixtures: Awaited<ReturnType<typeof createIntegrationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture(...args: Parameters<typeof createIntegrationFixture>) {
  const f = await createIntegrationFixture(...args);
  fixtures.push(f);
  return f;
}
const now = new Date("2030-01-01T00:00:00Z");
const orphan = "files/11111111-1111-4111-8111-111111111111.txt";
async function put(root: string, key = orphan, age = 1000) {
  await mkdir(join(root, key.split("/")[0]), { recursive: true });
  await writeFile(join(root, key), "orphan");
  await utimes(join(root, key), new Date(+now - age), new Date(+now - age));
}
describe("maintenance on real SQL and bytes", () => {
  it.each([false, true])("resumes detail purge beyond 500 retained byte rows with path failure=%s without false success or lost reservations", async (pathFailure) => {
    const f = await fixture();
    await f.db.query(`WITH codes AS (INSERT INTO issued_file_codes(code)
      SELECT 'F-' || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1+(i/961)::int,1) || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',1+((i/31)::int%31),1) || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',1+(i%31),1) || 'AA' FROM generate_series(0,500) i RETURNING code)
      INSERT INTO files(code,original_name,storage_key,mime_type,size_bytes,uploaded_by_type,expires_at)
      SELECT code,'synthetic',gen_random_uuid()::text,'text/plain',1,'admin','2020-01-01' FROM codes`);
    const rows = (await f.db.query<any>("SELECT * FROM files ORDER BY id")).rows;
    await mkdir(join(f.storageRoot,"files"), { recursive:true });
    for (const [i,row] of rows.entries()) {
      row.storage_key = `files/${row.id}.txt`;
      if (pathFailure && i === 499) await mkdir(join(f.storageRoot,row.storage_key));
      else if (i < 500) await writeFile(join(f.storageRoot,row.storage_key), "x");
      await f.db.query(`UPDATE files SET storage_key=$2,lifecycle_state='deleted',deleted_at=$3,deleted_reason='manual' WHERE id=$1`,
        [row.id,row.storage_key, i < 500 ? '2020-01-01T00:00:00.123456Z' : '2020-01-01T00:00:00.123457Z']);
    }
    const maintenance = createMaintenance(f.config, f.db, f.server.getDecorator<any>("uploadRuntime"), () => now);
    await maintenance.run();
    const first = { ...maintenance.state.purge, cursor: maintenance.state.purgeCursor };
    expect((await f.db.query("SELECT * FROM files")).rows).toHaveLength(501);
    await maintenance.run();
    expect((await f.db.query("SELECT * FROM files WHERE id=$1",[rows[500].id])).rows).toHaveLength(0);
    expect(first.last_success_at).toBeNull();
    expect(first.complete).toBe(false);
    expect(first.cursor?.timestamp).toContain(".123456");
    expect(first.cursor?.id).toBe(rows[499].id);
    expect(maintenance.state.purge).toMatchObject({complete:true,retained:pathFailure ? 499 : 500,failures:pathFailure ? 1 : 0});
    expect(maintenance.state.purge.last_success_at).toBeNull();
    await maintenance.run();
    await maintenance.run();
    expect((await f.db.query("SELECT * FROM files")).rows).toHaveLength(500);
    expect((await f.db.query("SELECT * FROM issued_file_codes")).rows).toHaveLength(501);
    for (const row of rows.slice(0,pathFailure ? 499 : 500)) expect(await readFile(join(f.storageRoot,row.storage_key),"utf8")).toBe("x");
    const { deleteStoredFile } = await import("../../src/server/storage");
    for (const row of rows.slice(0,pathFailure ? 499 : 500)) await deleteStoredFile(f.storageRoot,row.storage_key);
    if (pathFailure) await rmdir(join(f.storageRoot,rows[499].storage_key));
    await maintenance.run();
    expect(maintenance.state.purge.last_success_at).toBeNull();
    await maintenance.run();
    expect(maintenance.state.purge.last_success_at).toBe(now.toISOString());
    expect((await f.db.query("SELECT * FROM files")).rows).toHaveLength(0);
    expect((await f.db.query("SELECT * FROM issued_file_codes")).rows).toHaveLength(501);
  });
  it("isolates failed event writes from confirmed operations and exposes review health", async () => {
    const f = await fixture();
    await f.db
      .query(`CREATE FUNCTION synthetic_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic event failure'; END $$;
      CREATE TRIGGER synthetic_failure BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION synthetic_event_failure()`);
    const file = await f.uploadSynthetic({
      text: "event outage",
      permissions: "upload",
    });
    const key = await f.createSyntheticKey(["can_delete"]);
    expect(
      (
        await f.server.inject({
          method: "DELETE",
          url: `/api/files/${file.code}`,
          headers: key.headers,
        })
      ).statusCode,
    ).toBe(200);
    const maintenance = f.server.getDecorator<any>("maintenance");
    expect(maintenance.state.eventFailures).toBe(2);
    expect(
      (
        await f.db.query<any>(
          "SELECT lifecycle_state FROM files WHERE code=$1",
          [file.code],
        )
      ).rows[0].lifecycle_state,
    ).toBe("deleted");
  });
  it("starts recovery immediately after real startup gates and reports admin-only maintenance state", async () => {
    const startupNow = new Date();
    const f = await fixture();
    const file = await f.uploadSynthetic({
      text: "startup recovery",
      permissions: "upload",
    });
    await claimFileDeletion(file.code, "manual", f.db);
    await f.server.close();
    const server = buildServer(
      { ...f.config, nodeEnv: "production" },
      {
        db: f.db,
        now: () => startupNow,
        loggerStream: new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
      },
    );
    try {
      expect(
        server.getDecorator<any>("maintenance").state.cleanup.last_attempt_at,
      ).toBe(null);
      await server.ready();
      expect(
        (
          await f.db.query<any>(
            "SELECT lifecycle_state FROM files WHERE code=$1",
            [file.code],
          )
        ).rows[0].lifecycle_state,
      ).toBe("deleted");
      const login = await server.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          username: f.config.adminUsername,
          password: "synthetic-unused-fixture-password",
        },
      });
      const cookie = String(login.headers["set-cookie"]).split(";")[0];
      const response = await server.inject({
        url: "/api/admin/storage-usage",
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        bytes: 0,
        managed_bytes: 0,
        reserved_bytes: 0,
        max_storage_bytes: f.config.maxStorageBytes,
        min_free_disk_bytes: f.config.minFreeDiskBytes,
        active_uploads: 0,
        cleanup: {
          last_attempt_at: startupNow.toISOString(),
          last_success_at: startupNow.toISOString(),
          pending_expired_bytes: 0,
          failed_files: 0,
          oldest_pending_at: null,
        },
      });
      expect(response.json().free_disk_bytes).toBeGreaterThan(0);
      expect((await server.inject("/api/admin/storage-usage")).statusCode).toBe(
        403,
      );
      expect((await server.inject("/api/health")).json()).toEqual({
        ok: true,
        service: "agentfiles",
      });
    } finally {
      await server.close();
    }
  });
  it("coalesces cleanup/reconciliation runs and stop awaits the in-flight pass", async () => {
    const f = await fixture();
    let release!: () => void, started!: () => void;
    const barrier = new Promise<void>((r) => (release = r)),
      reached = new Promise<void>((r) => (started = r));
    let attempts = 0;
    const db = {
      ...f.db,
      query: async <T>(sql: string, params?: readonly unknown[]) => {
        if (sql.includes("deletion_claimed_at::text AS sweep_timestamp")) {
          attempts++;
          started();
          await barrier;
        }
        return f.db.query<T>(sql, params);
      },
    };
    const maintenance = createMaintenance(
      f.config,
      db,
      f.server.getDecorator<any>("uploadRuntime"),
      () => now,
    );
    const first = maintenance.run();
    await reached;
    const second = maintenance.run();
    let stopped = false;
    const stop = maintenance.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(attempts).toBe(1);
    release();
    await Promise.all([first, second, stop]);
    expect(stopped).toBe(true);
    expect(attempts).toBe(1);
    expect(maintenance.state.cleanup.last_success_at).toBe(now.toISOString());
    expect(maintenance.state.reconciliation.last_success_at).toBe(
      now.toISOString(),
    );
    expect(maintenance.state.purge.last_success_at).toBe(now.toISOString());
  });
  it("purges expired sessions and old revoked/expired shares while preserving active records", async () => {
    const f = await fixture({ allowPersistentFiles: true });
    const file = await f.uploadSynthetic({
      text: "durable survives",
      permissions: ["can_upload", "can_mark_durable"],
      durable: true,
    });
    const row = (
      await f.db.query<any>("SELECT * FROM files WHERE code=$1", [file.code])
    ).rows[0];
    await f.db.query(
      "INSERT INTO admin_sessions(session_hash,expires_at,revoked_at) VALUES('synthetic-expired','2020-01-01',NULL),('synthetic-live','2040-01-01',NULL),('synthetic-revoked-unexpired','2040-01-01','2020-01-01')",
    );
    await f.db.query(
      `INSERT INTO share_links(file_id,token_hash,expires_at,revoked_at,created_by_type) VALUES
      ($1,'synthetic-expired','2020-01-01',NULL,'admin'),($1,'synthetic-live','2040-01-01',NULL,'admin'),($1,'synthetic-revoked','2040-01-01','2020-01-01','admin')`,
      [row.id],
    );
    const result = await purgeRetainedDetails({
      root: f.storageRoot,
      db: f.db,
      now,
      metadataRetentionDays: 30,
      eventRetentionDays: 30,
    });
    expect(result.sessions).toBe(1);
    expect(result.shares).toBe(2);
    expect(result.files).toBe(0);
    expect(
      (await cleanupExpiredFiles({ storageRoot: f.storageRoot, db: f.db, now }))
        .deleted,
    ).toBe(0);
    await access(join(f.storageRoot, row.storage_key));
  });
  it("reconciles synthetic crash temp/final stages, counts hardlinks once, and retains malformed names", async () => {
    const f = await fixture();
    const activeUploads = createActiveUploads();
    const temp = ".tmp/22222222-2222-4222-8222-222222222222.upload";
    await put(f.storageRoot, temp);
    await mkdir(join(f.storageRoot, "files"));
    await link(join(f.storageRoot, temp), join(f.storageRoot, orphan));
    const malformed = "files/" + "a".repeat(36);
    await put(f.storageRoot, malformed);
    const recent = "files/33333333-3333-4333-8333-333333333333.txt";
    await put(f.storageRoot, recent, 999);
    const { getStorageUsage } = await import("../../src/server/storage");
    expect((await getStorageUsage(f.storageRoot)).bytes).toBe(18);
    const result = await reconcileStorage({
      root: f.storageRoot,
      db: f.db,
      activeUploads,
      graceMs: 1000,
      now,
    });
    expect(result).toEqual({ removedBytes: 6, failures: 1 });
    await expect(access(join(f.storageRoot, temp))).rejects.toThrow();
    await expect(access(join(f.storageRoot, orphan))).rejects.toThrow();
    await access(join(f.storageRoot, recent));
    await access(join(f.storageRoot, malformed));
  });
  it.skipIf(process.platform === "win32")(
    "does not traverse symlink bait during reconciliation",
    async () => {
      const f = await fixture();
      await put(f.storageRoot);
      const bait = join(
        f.storageRoot,
        "files/44444444-4444-4444-8444-444444444444.txt",
      );
      await symlink(join(f.storageRoot, orphan), bait);
      const result = await reconcileStorage({
        root: f.storageRoot,
        db: f.db,
        activeUploads: createActiveUploads(),
        graceMs: 1000,
        now,
      });
      expect(result.failures).toBe(1);
    },
  );
  it("refuses a fresh runtime on an unpaired empty volume and retains the original pending bytes", async () => {
    const f = await fixture();
    const file = await f.uploadSynthetic({
      text: "mounted original",
      permissions: "upload",
    });
    const claim = await claimFileDeletion(file.code, "manual", f.db);
    const wrongRoot = join(f.storageRoot, "synthetic-unpaired-volume");
    await mkdir(wrongRoot);
    await expect(initializeStorageAssociation(wrongRoot, f.db)).rejects.toThrow(
      "identity",
    );
    await expect(
      completeDeletion({ file: claim!, root: wrongRoot, db: f.db }),
    ).rejects.toThrow("identity");
    expect(
      (
        await f.db.query<any>(
          "SELECT lifecycle_state FROM files WHERE code=$1",
          [file.code],
        )
      ).rows[0].lifecycle_state,
    ).toBe("deleting");
    await access(join(f.storageRoot, claim!.storageKey));
    await expect(
      purgeRetainedDetails({
        root: wrongRoot,
        db: f.db,
        now,
        metadataRetentionDays: 30,
        eventRetentionDays: 30,
      }),
    ).rejects.toThrow("identity");
  });
  it("purge preserves files with remaining bytes, rolls back failures, and never deletes reservations", async () => {
    const f = await fixture();
    const file = await f.uploadSynthetic({
      text: "retained evidence",
      permissions: "upload",
    });
    const claim = await claimFileDeletion(file.code, "manual", f.db);
    await f.db.query(
      "UPDATE files SET lifecycle_state='deleted',deleted_at='2020-01-01',deleted_reason='manual' WHERE code=$1",
      [file.code],
    );
    const state = createMaintenanceState();
    const input = {
      root: f.storageRoot,
      db: f.db,
      now,
      metadataRetentionDays: 30,
      eventRetentionDays: 30,
      maintenanceState: state,
    };
    expect((await purgeRetainedDetails(input)).files).toBe(0);
    const { deleteStoredFile } = await import("../../src/server/storage");
    await deleteStoredFile(f.storageRoot, claim!.storageKey);
    await f.db
      .query(`CREATE FUNCTION synthetic_purge_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic purge failure'; END $$;
      CREATE TRIGGER synthetic_failure BEFORE DELETE ON files FOR EACH ROW EXECUTE FUNCTION synthetic_purge_failure()`);
    await expect(purgeRetainedDetails(input)).rejects.toThrow();
    expect(state.purgeCursor).toBeUndefined();
    expect(state.purge).toMatchObject({ complete: false, failures: 1, last_success_at: null });
    expect(
      (
        await f.db.query("SELECT code FROM issued_file_codes WHERE code=$1", [
          file.code,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(
      (await f.db.query("SELECT code FROM files WHERE code=$1", [file.code]))
        .rows,
    ).toHaveLength(1);
    await f.db.query("DROP TRIGGER synthetic_failure ON files");
    expect((await purgeRetainedDetails(input)).files).toBe(1);
    expect(state.purge.last_success_at).toBeNull();
    await purgeRetainedDetails(input);
    expect(state.purge.last_success_at).toBe(now.toISOString());
    expect(
      (
        await f.db.query("SELECT code FROM issued_file_codes WHERE code=$1", [
          file.code,
        ])
      ).rows,
    ).toHaveLength(1);
  });
  it("really purges details while permanent code history prevents reassignment, including full registry fixture restore", async () => {
    const A = "F-AAAAA",
      B = "F-BBBBB";
    let offers = [A];
    const allocate: typeof createFileRecord = (input, db) =>
      createFileRecord(input, db, { generateCode: () => offers.shift()! });
    const f = await fixture(
      {},
      { files: { repo: { createFileRecord: allocate } } },
    );
    const first = await f.uploadSynthetic({
      text: "original A content",
      permissions: "upload",
    });
    expect(first.code).toBe(A);
    const key = await f.createSyntheticKey([
      "can_delete",
      "can_share",
      "can_download",
      "can_upload",
    ]);
    const share = await f.server.inject({
      method: "POST",
      url: `/api/files/${A}/share`,
      headers: key.headers,
      payload: { expires_at: new Date(Date.now() + 60000).toISOString() },
    });
    expect(share.statusCode).toBe(201);
    expect(
      (
        await f.server.inject({
          method: "DELETE",
          url: `/api/files/${A}`,
          headers: key.headers,
        })
      ).statusCode,
    ).toBe(200);
    const row = (
      await f.db.query<any>("SELECT * FROM files WHERE code=$1", [A])
    ).rows[0];
    await expect(
      access(join(f.storageRoot, row.storage_key)),
    ).rejects.toThrow();
    const result = await purgeRetainedDetails({
      root: f.storageRoot,
      db: f.db,
      now,
      metadataRetentionDays: 30,
      eventRetentionDays: 30,
    });
    expect(result.files).toBe(1);
    expect(result.shares).toBe(1);
    expect(result.events).toBeGreaterThanOrEqual(3);
    for (const table of ["files", "share_links", "events"])
      expect((await f.db.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    const columns = (
      await f.db.query<any>(
        "SELECT column_name FROM information_schema.columns WHERE table_name='issued_file_codes'",
      )
    ).rows;
    expect(columns).toEqual([{ column_name: "code" }]);
    const fullRegistry = (
      await f.db.query<{ code: string }>(
        "SELECT code FROM issued_file_codes ORDER BY code",
      )
    ).rows;
    expect(fullRegistry).toEqual([{ code: A }]);
    // Synthetic full-registry fixture export/restore, not a release backup tool.
    const exportPath = join(f.storageRoot, "synthetic-registry-fixture.json");
    await writeFile(exportPath, JSON.stringify(fullRegistry));
    await migrate(f.db);
    const restart = buildServer(f.config, {
      db: f.db,
      files: { repo: { createFileRecord: allocate } },
    });
    await restart.ready();
    try {
      offers = [A, B];
      const multipart = syntheticMultipart("unrelated B content");
      const response = await restart.inject({
        method: "POST",
        url: "/api/files",
        headers: { ...key.headers, ...multipart.headers },
        payload: multipart.payload,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().code).toBe(B);
      for (const path of [`/api/files/${A}`, `/api/files/${A}/download`])
        expect(
          (await restart.inject({ url: path, headers: key.headers }))
            .statusCode,
        ).toBe(404);
      expect(
        (
          await restart.inject({
            url: `/api/files/${B}/download`,
            headers: key.headers,
          })
        ).body,
      ).toBe("unrelated B content");
    } finally {
      await restart.close();
    }
    const restored = await fixture(
      {},
      { files: { repo: { createFileRecord: allocate } } },
    );
    const restoredRows = JSON.parse(await readFile(exportPath, "utf8"));
    for (const entry of restoredRows)
      await restored.db.query(
        "INSERT INTO issued_file_codes(code) VALUES($1)",
        [entry.code],
      );
    offers = [A, B];
    const second = await restored.uploadSynthetic({
      text: "restored unrelated B",
      permissions: "upload",
    });
    expect(second.code).toBe(B);
    const reader = await restored.createSyntheticKey(["can_download"]);
    for (const path of [`/api/files/${A}`, `/api/files/${A}/download`])
      expect(
        (await restored.server.inject({ url: path, headers: reader.headers }))
          .statusCode,
      ).toBe(404);
    expect(
      (
        await restored.server.inject({
          url: `/api/files/${B}/download`,
          headers: reader.headers,
        })
      ).body,
    ).toBe("restored unrelated B");
  });
  it("honors grace exactly, active paths, metadata ownership and database outages", async () => {
    const f = await fixture();
    const activeUploads = createActiveUploads();
    await put(f.storageRoot, orphan, 999);
    const input = {
      root: f.storageRoot,
      db: f.db,
      activeUploads,
      graceMs: 1000,
      now,
    };
    expect(await reconcileStorage(input)).toEqual({
      removedBytes: 0,
      failures: 0,
    });
    await put(f.storageRoot);
    const release = activeUploads.hold(orphan);
    expect((await reconcileStorage(input)).removedBytes).toBe(0);
    release();
    const bad = {
      ...f.db,
      withClient: async () => {
        throw new Error("synthetic outage");
      },
    };
    expect((await reconcileStorage({ ...input, db: bad })).failures).toBe(1);
    await access(join(f.storageRoot, orphan));
    expect(await reconcileStorage(input)).toEqual({
      removedBytes: 6,
      failures: 0,
    });
    expect(await reconcileStorage(input)).toEqual({
      removedBytes: 0,
      failures: 0,
    });
  });
  it("blocks issuance explicitly for incomplete restored registry", async () => {
    const f = await fixture({ issuanceEnabled: false } as any);
    const key = await f.createSyntheticKey(["can_upload"]);
    const multipart = syntheticMultipart("blocked");
    const response = await f.server.inject({
      method: "POST",
      url: "/api/files",
      headers: { ...key.headers, ...multipart.headers },
      payload: multipart.payload,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("FILE_ISSUANCE_DISABLED");
    expect(
      (await f.db.query("SELECT code FROM issued_file_codes")).rows,
    ).toEqual([]);
  });
  it("records minimal lifecycle events on upload and deletion", async () => {
    const f = await fixture();
    const file = await f.uploadSynthetic({
      text: "not an event detail",
      permissions: "upload",
    });
    const key = await f.createSyntheticKey(["can_delete"]);
    await f.server.inject({
      method: "DELETE",
      url: `/api/files/${file.code}`,
      headers: key.headers,
    });
    const rows = (
      await f.db.query<any>(
        "SELECT event_type,actor_name,details FROM events ORDER BY created_at",
      )
    ).rows;
    expect(rows.map((r) => r.event_type)).toEqual([
      "file.created",
      "file.deleted",
    ]);
    expect(
      rows.every(
        (r) => r.actor_name === null && JSON.stringify(r.details) === "{}",
      ),
    ).toBe(true);
  });
  it("preserves precise cursors over a 1000-attempt budget and failed prefix", async () => {
    const f = await fixture();
    await seed(f, 1203);
    const state = createMaintenanceState();
    let count = 0;
    const failedKeys = new Set<string>();
    const remove = async (_root:string,key:string) => {
      count++;
      if (count <= 100) failedKeys.add(key);
      if (failedKeys.has(key)) throw new Error("permanent prefix");
    };
    const input = {
      storageRoot: f.storageRoot,
      db: f.db,
      batchSize: 100,
      maintenanceState: state,
      deleteStoredFile: remove,
      now,
    };
    const first = await cleanupExpiredFiles(input);
    expect(first.attempted).toBe(1000);
    expect(first.complete).toBe(false);
    expect(state.expiredCursor?.timestamp).toContain("123456");
    const second = await cleanupExpiredFiles(input);
    expect(second.attempted).toBe(303); // 100 pending retries plus 203 new expired rows.
    expect(second.complete).toBe(true);
    expect(first.deleted + second.deleted).toBe(1103);
    expect(state.cleanup.last_success_at).toBe(null);
  });
  it("resumes pending cursor while reserving capacity for new expired work", async () => {
    const f = await fixture();
    await seed(f, 1203);
    await f.db.query(
      "UPDATE files SET lifecycle_state='deleting',deletion_claim_id=gen_random_uuid(),deletion_claimed_at='2020-01-01T00:00:00.123456Z',deletion_claim_reason='expired' WHERE code IN (SELECT code FROM files ORDER BY code LIMIT 1200)",
    );
    const state = createMaintenanceState();
    const seen = new Set<string>();
    const input = {
      storageRoot: f.storageRoot,
      db: f.db,
      batchSize: 100,
      maintenanceState: state,
      now,
      deleteStoredFile: async (_root: string, key: string) => {
        const row = (
          await f.db.query<any>(
            "SELECT deletion_claimed_at FROM files WHERE storage_key=$1",
            [key],
          )
        ).rows[0];
        if (new Date(row.deletion_claimed_at).getUTCFullYear() === 2020) {
          seen.add(key);
          throw new Error("permanent pending");
        }
      },
    };
    expect((await cleanupExpiredFiles(input)).deleted).toBe(3);
    expect(state.pendingCursor?.timestamp).toContain("123456");
    await createFileRecord(
      {
        code: "F-ZZZZZ",
        originalName: "late expired",
        storageKey: "late",
        mimeType: "text/plain",
        sizeBytes: 1,
        uploadedByType: "admin",
        expiresAt: new Date("2021-01-01"),
      },
      f.db,
    );
    expect((await cleanupExpiredFiles(input)).deleted).toBe(1);
    await cleanupExpiredFiles(input);
    expect(seen.size).toBe(1200);
  });
});
async function seed(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  await f.db.query(
    `WITH codes AS (INSERT INTO issued_file_codes(code)
    SELECT 'F-' || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1+(i/961)::int,1) || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',1+((i/31)::int%31),1) || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',1+(i%31),1) || 'AA' FROM generate_series(0,$1::int-1) i RETURNING code)
    INSERT INTO files(code,original_name,storage_key,mime_type,size_bytes,uploaded_by_type,expires_at)
    SELECT code,'synthetic',code,'text/plain',1,'admin','2020-01-01T00:00:00.123456Z' FROM codes`,
    [count],
  );
}
