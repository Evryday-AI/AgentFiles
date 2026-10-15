import { afterEach, describe, expect, it } from "vitest";
import { access, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createIntegrationFixture } from "../helpers/integration";
import { cleanupExpiredFiles } from "../../src/server/cleanup";
import {
  claimFileDeletion,
  finalizeFileDeletion,
  findExpiredBatch,
  setFileDurable,
} from "../../src/server/filesRepo";
import { completeDeletion } from "../../src/server/deletion";
import type { Database, Queryable } from "../../src/server/db";
import { createMaintenanceState } from "../../src/server/maintenanceState";

const fixtures: Awaited<ReturnType<typeof createIntegrationFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function fixture(...args: Parameters<typeof createIntegrationFixture>) {
  const value = await createIntegrationFixture(...args);
  fixtures.push(value);
  return value;
}

describe("real lifecycle recovery", () => {
  it("reports a durable pending claim as controlled 503, retaining bytes until retry", async () => {
    let fail = true;
    const { deleteStoredFile } = await import("../../src/server/storage");
    const f = await fixture(
      {},
      {
        files: {
          storage: {
            deleteStoredFile: async (...args) => {
              if (fail) throw new Error("synthetic EACCES");
              return deleteStoredFile(...args);
            },
          },
        },
      },
    );
    const file = await f.uploadSynthetic({
      text: "retained",
      permissions: "upload",
    });
    const key = await f.createSyntheticKey([
      "can_delete",
      "can_mark_durable",
      "can_download",
    ]);
    const url = `/api/files/${file.code}`;
    const response = await f.server.inject({
      method: "DELETE",
      url,
      headers: key.headers,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("FILE_DELETION_PENDING");
    const row = (
      await f.db.query<any>("SELECT * FROM files WHERE code=$1", [file.code])
    ).rows[0];
    expect(row.lifecycle_state).toBe("deleting");
    expect(await readFile(join(f.storageRoot, row.storage_key), "utf8")).toBe(
      "retained",
    );
    fail = false;
    expect(
      (await f.server.inject({ method: "DELETE", url, headers: key.headers }))
        .statusCode,
    ).toBe(200);
    await expect(
      access(join(f.storageRoot, row.storage_key)),
    ).rejects.toThrow();
    expect(
      (await f.server.inject({ method: "DELETE", url, headers: key.headers }))
        .statusCode,
    ).toBe(200);
  });

  it("advances past a permanently failing first page through 501 expired files", async () => {
    const f = await fixture();
    await f.db.query(`WITH codes AS (INSERT INTO issued_file_codes(code)
      SELECT 'F-' || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1+(i/961)::int,1) || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',1+((i/31)::int%31),1) || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',1+(i%31),1) || 'AA' FROM generate_series(0,500) i RETURNING code)
      INSERT INTO files(code,original_name,storage_key,mime_type,size_bytes,uploaded_by_type,expires_at)
      SELECT code,'synthetic',code,'text/plain',1,'admin','2020-01-01T00:00:00.123456Z' FROM codes`);
    const rows = (await f.db.query<any>("SELECT * FROM files ORDER BY expires_at,id")).rows;
    await mkdir(join(f.storageRoot, "files"), { recursive: true });
    for (const row of rows) {
      row.storage_key = 'files/' + row.id + '.txt';
      await f.db.query("UPDATE files SET storage_key=$2 WHERE id=$1", [row.id,row.storage_key]);
      await writeFile(join(f.storageRoot,row.storage_key), "x");
    }
    const prefix = new Set(rows.slice(0,100).map(row=>row.storage_key));
    const { deleteStoredFile } = await import("../../src/server/storage");
    const state = createMaintenanceState();
    const run = () => cleanupExpiredFiles({
      storageRoot: f.storageRoot, db: f.db, batchSize: 100, maintenanceState: state,
      deleteStoredFile: async (root,key) => {
        if (prefix.has(key)) throw new Error("permanent prefix");
        await deleteStoredFile(root,key);
      },
    });
    expect(await run()).toMatchObject({ deleted:401, failed:100, attempted:501, complete:true });
    const claimed = (await f.db.query<any>("SELECT * FROM files ORDER BY expires_at,id")).rows;
    for (const row of claimed) {
      expect(row.deletion_claim_id).toBeTruthy();
      expect(row.lifecycle_state).toBe(prefix.has(row.storage_key) ? "deleting" : "deleted");
      if (prefix.has(row.storage_key)) expect(await readFile(join(f.storageRoot,row.storage_key),"utf8")).toBe("x");
      else await expect(access(join(f.storageRoot,row.storage_key))).rejects.toThrow();
    }
    expect(await run()).toMatchObject({ deleted:0, failed:100, attempted:100, complete:true });
    expect(state.cleanup.last_success_at).toBeNull();
    const retried = (await f.db.query<any>("SELECT * FROM files ORDER BY expires_at,id")).rows;
    expect(retried.map(row=>[row.lifecycle_state,row.deletion_claim_id,row.storage_key,row.deleted_at]))
      .toEqual(claimed.map(row=>[row.lifecycle_state,row.deletion_claim_id,row.storage_key,row.deleted_at]));
    for (const key of prefix) await access(join(f.storageRoot,key));
    expect((await f.db.query("SELECT * FROM issued_file_codes")).rows).toHaveLength(501);
  });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}
function observed(
  db: Database,
  hooks: {
    before?: (sql: string, pinned: Queryable) => Promise<void>;
    after?: (sql: string, pinned: Queryable) => Promise<void>;
  },
) {
  const pids = new Set<number>();
  return {
    ...db,
    pids,
    withClient: async <T>(work: (client: Queryable) => Promise<T>) =>
      db.withClient(async (pinned) => {
        pids.add(
          (await pinned.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        );
        const proxy: Queryable = {
          query: async <T>(sql: string, params?: readonly unknown[]) => {
            await hooks.before?.(sql, pinned);
            const result = await pinned.query(sql, params as any[]);
            await hooks.after?.(sql, pinned);
            return { rows: result.rows as T[], rowCount: result.rowCount };
          },
        };
        return work(proxy);
      }),
  };
}
async function waiting(db: Queryable, pid: number) {
  for (let count = 0; count < 200; count++) {
    const result = await db.query<{ waiting: boolean }>(
      "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
      [pid],
    );
    if (result.rows[0]?.waiting) return;
  }
  throw new Error("Competing pinned client did not reach a database lock wait");
}

describe("ordered PostgreSQL arbitration through authenticated routes", () => {
  it("does not round a future PostgreSQL microsecond expiry down into an early claim", async () => {
    const at = new Date("2030-01-01T00:00:00.123Z");
    const f = await fixture({ allowPersistentFiles: true }, { now: () => at });
    const file = await f.uploadSynthetic({
      text: "submillisecond future",
      permissions: "upload",
    });
    const reader=await f.createSyntheticKey(["can_share","can_download"]);
    const share=await f.server.inject({method:"POST",url:`/api/files/${file.code}/share`,headers:reader.headers,payload:{expires_at:new Date(+at+1000).toISOString()}});
    await f.db.query(
      "UPDATE files SET expires_at='2030-01-01T00:00:00.123456Z' WHERE code=$1",
      [file.code],
    );
    expect(await claimFileDeletion(file.code, "expired", f.db, () => at)).toBe(
      null,
    );
    expect((await f.server.inject({url:`/api/files/${file.code}/download`,headers:reader.headers})).statusCode).toBe(200);
    expect((await f.server.inject(new URL(share.json().public_url).pathname)).statusCode).toBe(200);
    const key = await f.createSyntheticKey(["can_mark_durable"]);
    expect(
      (
        await f.server.inject({
          method: "PATCH",
          url: `/api/files/${file.code}`,
          headers: key.headers,
          payload: { durable: true },
        })
      ).statusCode,
    ).toBe(200);
  });
  it.each([true, false])(
    "keep-first durable=%s defeats a real stale expired candidate",
    async (durable) => {
      let at = new Date("2030-01-01T00:00:00Z");
      const locked = gate(),
        commit = gate();
      let f!: Awaited<ReturnType<typeof fixture>>;
      let keeper: ReturnType<typeof observed>;
      f = await fixture(
        { allowPersistentFiles: true },
        {
          now: () => at,
          files: {
            repo: {
              setFileDurable: (...args) => {
                keeper = observed(f.db, {
                  before: async (sql) => {
                    if (sql === "COMMIT") {
                      locked.release();
                      await commit.promise;
                    }
                  },
                });
                args[3] = keeper as any;
                return setFileDurable(...args);
              },
            },
          },
        },
      );
      const file = await f.uploadSynthetic({
        text: "keep wins",
        permissions: "upload",
      });
      const expiry = new Date(+at + 1000);
      await f.db.query("UPDATE files SET expires_at=$2 WHERE code=$1", [
        file.code,
        expiry,
      ]);
      const key = await f.createSyntheticKey([
        "can_mark_durable",
        "can_delete",
        "can_download",
      ]);
      const keep = f.server.inject({
        method: "PATCH",
        url: `/api/files/${file.code}`,
        headers: key.headers,
        payload: { durable },
      });
      await locked.promise;
      at = expiry;
      const stale = await findExpiredBatch({ now: at, limit: 100 }, f.db);
      expect(stale.map((f) => f.code)).toContain(file.code);
      const reached = gate();
      const claimant = observed(f.db, {
        before: async (sql) => {
          if (sql.includes("FOR UPDATE")) reached.release();
        },
      });
      const claim = claimFileDeletion(file.code, "expired", claimant, () => at);
      await reached.promise;
      expect([...claimant.pids][0]).not.toBe([...keeper!.pids][0]);
      await waiting(f.db, [...claimant.pids][0]);
      commit.release();
      expect((await keep).statusCode).toBe(200);
      expect(await claim).toBe(null);
      const row = (
        await f.db.query<any>("SELECT * FROM files WHERE code=$1", [file.code])
      ).rows[0];
      expect(row.lifecycle_state).toBe("active");
      expect(row.is_durable).toBe(durable);
      if (!durable)
        expect(+row.expires_at).toBe(
          +new Date("2030-01-01T00:00:00Z") + f.config.retentionDays * 86400000,
        );
      expect(await readFile(join(f.storageRoot, row.storage_key), "utf8")).toBe(
        "keep wins",
      );
      // Explicit manual intent can still delete a successfully retained file.
      expect(
        (
          await f.server.inject({
            method: "DELETE",
            url: `/api/files/${file.code}`,
            headers: key.headers,
          })
        ).statusCode,
      ).toBe(200);
    },
  );

  it.each([['expired', true], ['expired', false], ['manual', true], ['manual', false]] as const)(
    "%s claim-first rejects waiting keep durable=%s, then finalizes only owned bytes",
    async (reason, durable) => {
      const locked = gate(),
        commit = gate();
      let f!: Awaited<ReturnType<typeof fixture>>;
      const at = new Date("2030-01-01T00:00:00Z");
      const keeperReached = gate();
      let keeper: ReturnType<typeof observed>;
      f = await fixture(
        { allowPersistentFiles: true },
        {
          now: () => at,
          files: {
            repo: {
              setFileDurable: (...args) => {
                keeper = observed(f.db, {
                  before: async (sql) => {
                    if (sql.includes("FOR UPDATE")) keeperReached.release();
                  },
                });
                args[3] = keeper as any;
                return setFileDurable(...args);
              },
            },
          },
        },
      );
      const file = await f.uploadSynthetic({
        text: "claim wins",
        permissions: "upload",
      });
      if (reason === "expired")
        await f.db.query("UPDATE files SET expires_at=$2 WHERE code=$1", [
          file.code,
          at,
        ]);
      else if (!durable)
        await f.db.query("UPDATE files SET is_durable=true,expires_at=NULL WHERE code=$1", [file.code]);
      const before = (await f.db.query<any>("SELECT * FROM files WHERE code=$1",[file.code])).rows[0];
      const claimant = observed(f.db, {
        after: async (sql) => {
          if (sql.startsWith("UPDATE files SET lifecycle_state")) {
            locked.release();
            await commit.promise;
          }
        },
      });
      const claim = claimFileDeletion(file.code, reason, claimant, () => at);
      await locked.promise;
      const key = await f.createSyntheticKey([
        "can_mark_durable",
        "can_delete",
        "can_download",
        "can_share",
      ]);
      const keep = f.server.inject({
        method: "PATCH",
        url: `/api/files/${file.code}`,
        headers: key.headers,
        payload: { durable },
      });
      await keeperReached.promise;
      await waiting(f.db, [...keeper!.pids][0]);
      expect([...claimant.pids][0]).not.toBe([...keeper!.pids][0]);
      commit.release();
      const owned = await claim;
      expect(owned?.lifecycleState).toBe("deleting");
      expect((await keep).statusCode).toBe(409);
      expect(
        (
          await f.server.inject({
            url: `/api/files/${file.code}/download`,
            headers: key.headers,
          })
        ).statusCode,
      ).toBe(410);
      expect(
        (
          await f.server.inject({
            method: "POST",
            url: `/api/files/${file.code}/share`,
            headers: key.headers,
            payload: { expires_at: new Date(+at + 10000).toISOString() },
          })
        ).statusCode,
      ).toBe(410);
      await access(join(f.storageRoot, owned!.storageKey));
      expect(
        await finalizeFileDeletion(
          file.code,
          "00000000-0000-4000-8000-000000000000",
          f.db,
        ),
      ).toBe(null);
      await completeDeletion({ file: owned!, root: f.storageRoot, db: f.db });
      await expect(
        access(join(f.storageRoot, owned!.storageKey)),
      ).rejects.toThrow();
      const row = (
        await f.db.query<any>("SELECT * FROM files WHERE code=$1", [file.code])
      ).rows[0];
      expect(row.storage_key).toBe(before.storage_key);
      expect(row.expires_at).toEqual(before.expires_at);
      expect(row.is_durable).toBe(before.is_durable);
      expect(row.retention_mutation_id).toBe(before.retention_mutation_id);
      expect(row.lifecycle_state).toBe("deleted");
      expect(row.deletion_claim_id).toBe(owned!.deletionClaimId);
      expect(
        (
          await f.server.inject({
            method: "DELETE",
            url: `/api/files/${file.code}`,
            headers: key.headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await f.server.inject({
            method: "PATCH",
            url: `/api/files/${file.code}`,
            headers: key.headers,
            payload: { durable },
          })
        ).statusCode,
      ).toBe(404);
    },
  );

  it.each([true, false])("samples expiry after waiting for the row lock and rejects exact-now expiry durable=%s", async (durable) => {
    let at = new Date("2030-01-01T00:00:00Z");
    let f!: Awaited<ReturnType<typeof fixture>>;
    const reached = gate();
    let keeper: ReturnType<typeof observed>;
    f = await fixture(
      { allowPersistentFiles: true },
      {
        now: () => at,
        files: {
          repo: {
            setFileDurable: (...args) => {
              keeper = observed(f.db, {
                before: async (sql) => {
                  if (sql.includes("FOR UPDATE")) reached.release();
                },
              });
              args[3] = keeper as any;
              return setFileDurable(...args);
            },
          },
        },
      },
    );
    const file = await f.uploadSynthetic({
      text: "no resurrection",
      permissions: "upload",
    });
    const expiry = new Date(+at + 1000);
    await f.db.query("UPDATE files SET expires_at=$2 WHERE code=$1", [
      file.code,
      expiry,
    ]);
    const before = (await f.db.query<any>("SELECT * FROM files WHERE code=$1",[file.code])).rows[0];
    const held = gate(),
      release = gate();
    const locker = f.db.withClient(async (client) => {
      await client.query("BEGIN");
      await client.query("SELECT id FROM files WHERE code=$1 FOR UPDATE", [
        file.code,
      ]);
      held.release();
      await release.promise;
      await client.query("COMMIT");
    });
    await held.promise;
    const key = await f.createSyntheticKey(["can_mark_durable"]);
    const response = f.server.inject({
      method: "PATCH",
      url: `/api/files/${file.code}`,
      headers: key.headers,
      payload: { durable },
    });
    await reached.promise;
    await waiting(f.db, [...keeper!.pids][0]);
    at = expiry;
    release.release();
    await locker;
    expect((await response).statusCode).toBe(410);
    expect(
      (
        await f.server.inject({
          method: "PATCH",
          url: `/api/files/${file.code}`,
          headers: key.headers,
          payload: { durable },
        })
      ).statusCode,
    ).toBe(410);
    at = new Date(+expiry + 1);
    expect((await f.server.inject({method:"PATCH",url:`/api/files/${file.code}`,headers:key.headers,payload:{durable}})).statusCode).toBe(410);
    const after = (await f.db.query<any>("SELECT * FROM files WHERE code=$1",[file.code])).rows[0];
    expect(after).toEqual(before);
    expect(await readFile(join(f.storageRoot,after.storage_key),"utf8")).toBe("no resurrection");
  });
  it.each(["PATCH", "DELETE"] as const)(
    "rechecks revoked authority after %s waits on a file lock",
    async (method) => {
      const reached = gate();
      let f!: Awaited<ReturnType<typeof fixture>>;
      let contender: ReturnType<typeof observed>;
      const proxy = () =>
        (contender = observed(f.db, {
          before: async (sql) => {
            if (sql.includes("FOR UPDATE")) reached.release();
          },
        }));
      f = await fixture(
        { allowPersistentFiles: true },
        {
          files: {
            repo: {
              setFileDurable: (...args) => {
                args[3] = proxy() as any;
                return setFileDurable(...args);
              },
              claimFileDeletion: (...args) => {
                args[2] = proxy() as any;
                return claimFileDeletion(...args);
              },
            },
          },
        },
      );
      const file = await f.uploadSynthetic({
        text: "revoked while waiting",
        permissions: "upload",
      });
      const key = await f.createSyntheticKey([
        "can_delete",
        "can_mark_durable",
      ]);
      const held = gate(),
        release = gate();
      const locker = f.db.withClient(async (pinned) => {
        await pinned.query("BEGIN");
        await pinned.query("SELECT id FROM files WHERE code=$1 FOR UPDATE", [
          file.code,
        ]);
        held.release();
        await release.promise;
        await pinned.query("COMMIT");
      });
      await held.promise;
      const response = f.server.inject({
        method,
        url: `/api/files/${file.code}`,
        headers: key.headers,
        ...(method === "PATCH" ? { payload: { durable: true } } : {}),
      });
      await reached.promise;
      await waiting(f.db, [...contender!.pids][0]);
      await f.db.query(
        "UPDATE api_keys SET revoked_at=clock_timestamp() WHERE id=$1",
        [key.id],
      );
      release.release();
      await locker;
      expect((await response).statusCode).toBe(401);
      const row = (
        await f.db.query<any>("SELECT * FROM files WHERE code=$1", [file.code])
      ).rows[0];
      expect(row.lifecycle_state).toBe("active");
      expect(row.is_durable).toBe(false);
      await access(join(f.storageRoot, row.storage_key));
    },
  );
  it("rechecks a genuine cookie session against database wall time after a lock wait", async () => {
    const reached = gate();
    let f!: Awaited<ReturnType<typeof fixture>>;
    let contender: ReturnType<typeof observed>;
    f = await fixture(
      { allowPersistentFiles: true },
      {
        files: {
          repo: {
            setFileDurable: (...args) => {
              contender = observed(f.db, {
                before: async (sql) => {
                  if (sql.includes("FOR UPDATE")) reached.release();
                },
              });
              args[3] = contender as any;
              return setFileDurable(...args);
            },
          },
        },
      },
    );
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
    const file = await f.uploadSynthetic({
      text: "cookie wait",
      permissions: "upload",
    });
    const held = gate(),
      release = gate();
    const locker = f.db.withClient(async (pinned) => {
      await pinned.query("BEGIN");
      await pinned.query("SELECT id FROM files WHERE code=$1 FOR UPDATE", [
        file.code,
      ]);
      held.release();
      await release.promise;
      await pinned.query("COMMIT");
    });
    await held.promise;
    const response = f.server.inject({
      method: "PATCH",
      url: `/api/files/${file.code}`,
      headers: { cookie, origin: f.config.publicBaseUrl },
      payload: { durable: true },
    });
    await reached.promise;
    await waiting(f.db, [...contender!.pids][0]);
    // The expiry is AFTER the waiting transaction began. now() would accept it.
    await f.db.query("UPDATE admin_sessions SET expires_at=clock_timestamp()");
    release.release();
    await locker;
    expect((await response).statusCode).toBe(401);
    expect(
      (
        await f.db.query<any>("SELECT is_durable FROM files WHERE code=$1", [
          file.code,
        ])
      ).rows[0].is_durable,
    ).toBe(false);
  });
  it("authenticated manual DELETE owns the first claim while keep waits, and repeated DELETE completes safely", async () => {
    const claimed = gate(),
      commit = gate(),
      unlink = gate(),
      allowUnlink = gate(),
      keepReached = gate();
    let f!: Awaited<ReturnType<typeof fixture>>;
    let claimant: ReturnType<typeof observed>,
      keeper: ReturnType<typeof observed>;
    const { deleteStoredFile } = await import("../../src/server/storage");
    f = await fixture(
      { allowPersistentFiles: true },
      {
        files: {
          repo: {
            claimFileDeletion: (...args) => {
              claimant = observed(f.db, {
                before: async (sql) => {
                  if (sql === "COMMIT") {
                    claimed.release();
                    await commit.promise;
                  }
                },
              });
              args[2] = claimant as any;
              return claimFileDeletion(...args);
            },
            setFileDurable: (...args) => {
              keeper = observed(f.db, {
                before: async (sql) => {
                  if (sql.includes("FOR UPDATE")) keepReached.release();
                },
              });
              args[3] = keeper as any;
              return setFileDurable(...args);
            },
          },
          storage: {
            deleteStoredFile: async (...args) => {
              unlink.release();
              await allowUnlink.promise;
              return deleteStoredFile(...args);
            },
          },
        },
      },
    );
    const file = await f.uploadSynthetic({
      text: "manual lock winner",
      permissions: "upload",
    });
    const key = await f.createSyntheticKey(["can_delete", "can_mark_durable"]);
    const deletion = f.server.inject({
      method: "DELETE",
      url: `/api/files/${file.code}`,
      headers: key.headers,
    });
    await claimed.promise;
    const keepKey = await f.createSyntheticKey(["can_mark_durable"]);
    const keep = f.server.inject({
      method: "PATCH",
      url: `/api/files/${file.code}`,
      headers: keepKey.headers,
      payload: { durable: true },
    });
    await keepReached.promise;
    await waiting(f.db, [...keeper!.pids][0]);
    expect([...claimant!.pids][0]).not.toBe([...keeper!.pids][0]);
    commit.release();
    await unlink.promise;
    expect((await keep).statusCode).toBe(409);
    const row = (
      await f.db.query<any>("SELECT * FROM files WHERE code=$1", [file.code])
    ).rows[0];
    expect(row.lifecycle_state).toBe("deleting");
    await access(join(f.storageRoot, row.storage_key));
    allowUnlink.release();
    expect((await deletion).statusCode).toBe(200);
    expect(
      (
        await f.server.inject({
          method: "DELETE",
          url: `/api/files/${file.code}`,
          headers: key.headers,
        })
      ).statusCode,
    ).toBe(200);
    const final = (
      await f.db.query<any>("SELECT * FROM files WHERE code=$1", [file.code])
    ).rows[0];
    expect(final.deletion_claim_id).toBe(row.deletion_claim_id);
    expect(final.lifecycle_state).toBe("deleted");
  });
});

describe("deterministic commit fault simulations on real PostgreSQL", () => {
  it("unknown claim plus verification outage retains protected charged bytes until a healthy restart sweep", async () => {
    let f!: Awaited<ReturnType<typeof fixture>>;
    let fault = true;
    f = await fixture(
      {},
      {
        files: {
          repo: {
            claimFileDeletion: (...args) => {
              if (!fault) return claimFileDeletion(...args);
              let commitLost = false;
              const proxy = observed(f.db, {
                before: async (sql, pinned) => {
                  if (sql === "COMMIT") {
                    await pinned.query("COMMIT");
                    commitLost = true;
                    throw new Error("synthetic lost commit reply");
                  }
                  if (commitLost)
                    throw new Error("synthetic verification outage");
                },
              });
              args[2] = proxy as any;
              return claimFileDeletion(...args);
            },
          },
        },
      },
    );
    const file = await f.uploadSynthetic({
      text: "still charged",
      permissions: "upload",
    });
    const key = await f.createSyntheticKey(["can_delete", "can_download"]);
    const runtime = f.server.getDecorator<any>("uploadRuntime");
    const response = await f.server.inject({
      method: "DELETE",
      url: `/api/files/${file.code}`,
      headers: key.headers,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("FILE_DELETION_PENDING");
    expect(runtime.admission.snapshot().managedBytes).toBe(13);
    const row = (
      await f.db.query<any>("SELECT * FROM files WHERE code=$1", [file.code])
    ).rows[0];
    expect(row.lifecycle_state).toBe("deleting");
    await access(join(f.storageRoot, row.storage_key));
    fault = false;
    expect(
      (
        await cleanupExpiredFiles({
          storageRoot: f.storageRoot,
          db: f.db,
          recount: runtime.rescan,
        })
      ).deleted,
    ).toBe(1);
    expect(runtime.admission.snapshot().managedBytes).toBe(0);
  });
  it.each([false, true])(
    "finalization reply loss (committed=%s) verifies exact claim before reporting completion",
    async (committed) => {
      const f = await fixture();
      const file = await f.uploadSynthetic({
        text: "finalization ambiguity",
        permissions: "upload",
      });
      const claim = await claimFileDeletion(file.code, "manual", f.db);
      const faultDb = {
        ...f.db,
        query: async <T>(sql: string, params?: readonly unknown[]) => {
          if (sql.startsWith("UPDATE files SET lifecycle_state='deleted'")) {
            if (committed) await f.db.query(sql, params);
            throw new Error("synthetic lost finalization reply");
          }
          return f.db.query<T>(sql, params);
        },
      };
      const operation = completeDeletion({
        file: claim!,
        root: f.storageRoot,
        db: faultDb,
      });
      if (committed) expect((await operation).lifecycleState).toBe("deleted");
      else await expect(operation).rejects.toThrow("pending");
      await expect(
        access(join(f.storageRoot, claim!.storageKey)),
      ).rejects.toThrow();
      expect(
        (
          await completeDeletion({
            file: claim!,
            root: f.storageRoot,
            db: f.db,
          })
        ).deletionClaimId,
      ).toBe(claim!.deletionClaimId);
    },
  );
  it("expired metadata/private/share access is denied before cleanup; missing active bytes return controlled500", async () => {
    let at = new Date("2030-01-01T00:00:00Z");
    const f = await fixture({}, { now: () => at });
    const file = await f.uploadSynthetic({
      text: "expired bytes",
      permissions: "upload",
    });
    const key = await f.createSyntheticKey(["can_download", "can_share"]);
    const share = await f.server.inject({
      method: "POST",
      url: `/api/files/${file.code}/share`,
      headers: key.headers,
      payload: { expires_at: new Date(+at + 1000).toISOString() },
    });
    await f.db.query("UPDATE files SET expires_at=$2 WHERE code=$1", [
      file.code,
      new Date(+at + 1000),
    ]);
    at = new Date(+at + 1000);
    for (const url of [
      `/api/files/${file.code}`,
      `/api/files/${file.code}/download`,
      new URL(share.json().public_url).pathname,
    ])
      expect(
        (await f.server.inject({ url, headers: key.headers })).statusCode,
      ).toBe(410);
    const row = (
      await f.db.query<any>("SELECT * FROM files WHERE code=$1", [file.code])
    ).rows[0];
    await access(join(f.storageRoot, row.storage_key));
    expect(
      (
        await cleanupExpiredFiles({
          storageRoot: f.storageRoot,
          db: f.db,
          now: at,
        })
      ).deleted,
    ).toBe(1);
    const missing = await f.uploadSynthetic({
      text: "missing active",
      permissions: "upload",
    });
    const active = (
      await f.db.query<any>("SELECT * FROM files WHERE code=$1", [missing.code])
    ).rows[0];
    const { deleteStoredFile } = await import("../../src/server/storage");
    await deleteStoredFile(f.storageRoot, active.storage_key);
    const response = await f.server.inject({
      url: `/api/files/${missing.code}/download`,
      headers: key.headers,
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(f.storageRoot);
  });
  it.each([false, true])(
    "claim COMMIT reply failure (committed=%s) never unlinks without fresh ownership",
    async (committed) => {
      const f = await fixture();
      const file = await f.uploadSynthetic({
        text: "claim unknown",
        permissions: "upload",
      });
      let fault = true;
      const db = observed(f.db, {
        before: async (sql, pinned) => {
          if (sql === "COMMIT" && fault) {
            fault = false;
            await pinned.query(committed ? "COMMIT" : "ROLLBACK");
            throw new Error("synthetic lost reply");
          }
        },
      });
      let claim = null;
      try {
        claim = await claimFileDeletion(file.code, "manual", db);
      } catch {}
      const row = (
        await f.db.query<any>("SELECT * FROM files WHERE code=$1", [file.code])
      ).rows[0];
      await access(join(f.storageRoot, row.storage_key));
      expect(row.lifecycle_state).toBe(committed ? "deleting" : "active");
      if (committed) {
        expect(claim?.deletionClaimId).toBe(row.deletion_claim_id);
        await completeDeletion({ file: claim!, root: f.storageRoot, db: f.db });
      } else expect(claim).toBe(null);
    },
  );
  it("recovers after unlink and failed finalization without double capacity release", async () => {
    const f = await fixture();
    const file = await f.uploadSynthetic({
      text: "account once",
      permissions: "upload",
    });
    const runtime = f.server.getDecorator<any>("uploadRuntime");
    const claim = await claimFileDeletion(file.code, "manual", f.db);
    await expect(
      completeDeletion({
        file: claim!,
        root: f.storageRoot,
        db: f.db,
        recount: runtime.rescan,
        finish: async () => {
          throw new Error("synthetic finalization timeout");
        },
      }),
    ).rejects.toThrow();
    expect(runtime.admission.snapshot().managedBytes).toBe(0);
    expect(
      (
        await f.db.query<any>(
          "SELECT lifecycle_state FROM files WHERE code=$1",
          [file.code],
        )
      ).rows[0].lifecycle_state,
    ).toBe("deleting");
    const result = await cleanupExpiredFiles({
      storageRoot: f.storageRoot,
      db: f.db,
      recount: runtime.rescan,
    });
    expect(result.deleted).toBe(1);
    expect(runtime.admission.snapshot().managedBytes).toBe(0);
    await cleanupExpiredFiles({
      storageRoot: f.storageRoot,
      db: f.db,
      recount: runtime.rescan,
    });
    expect(runtime.admission.snapshot().managedBytes).toBe(0);
  });
  it.each([false, true])(
    "retention commit reply failure (committed=%s) returns success only after fresh verification",
    async (committed) => {
      let f!: Awaited<ReturnType<typeof fixture>>;
      f = await fixture(
        { allowPersistentFiles: true },
        {
          files: {
            repo: {
              setFileDurable: (...args) => {
                let fault = true;
                args[3] = observed(f.db, {
                  before: async (sql, pinned) => {
                    if (sql === "COMMIT" && fault) {
                      fault = false;
                      await pinned.query(committed ? "COMMIT" : "ROLLBACK");
                      throw new Error("synthetic lost reply");
                    }
                  },
                }) as any;
                return setFileDurable(...args);
              },
            },
          },
        },
      );
      const file = await f.uploadSynthetic({
        text: "retention unknown",
        permissions: "upload",
      });
      const key = await f.createSyntheticKey(["can_mark_durable"]);
      const response = await f.server.inject({
        method: "PATCH",
        url: `/api/files/${file.code}`,
        headers: key.headers,
        payload: { durable: true },
      });
      expect(response.statusCode).toBe(committed ? 200 : 503);
      expect(
        (
          await f.db.query<any>("SELECT is_durable FROM files WHERE code=$1", [
            file.code,
          ])
        ).rows[0].is_durable,
      ).toBe(committed);
    },
  );
});
