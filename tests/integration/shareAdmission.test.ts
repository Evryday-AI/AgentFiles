import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIntegrationFixture } from "../helpers/integration";
import { registerShareRoutes } from "../../src/server/shareRoutes";
import type { Queryable } from "../../src/server/db";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of disposers.splice(0).reverse()) await close();
});

async function fixture() {
  let at = new Date("2030-01-01T00:00:00.000Z");
  const f = await createIntegrationFixture(
    { allowPersistentFiles: true },
    { now: () => at },
  );
  disposers.push(f.close);
  const file = await f.uploadSynthetic({
    text: "admitted bytes",
    durable: true,
    permissions: ["can_upload", "can_mark_durable"],
  });
  const key = await f.createSyntheticKey(["can_share"]);
  const response = await f.server.inject({
    method: "POST",
    url: `/api/files/${file.code}/share`,
    headers: key.headers,
    payload: { expires_at: "2030-01-01T00:00:01.000Z", max_downloads: 2 },
  });
  expect(response.statusCode).toBe(201);
  const share = response.json();
  return {
    ...f,
    file,
    share,
    path: new URL(share.public_url).pathname,
    now: () => at,
    advance: (time: string) => { at = new Date(time); },
    async count() {
      return (await f.db.query<{ download_count: number }>(
        "SELECT download_count FROM share_links WHERE id=$1", [share.id],
      )).rows[0].download_count;
    },
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function downloadServer(
  f: Awaited<ReturnType<typeof fixture>>,
  db: Queryable,
  open = async () => Readable.from(["admitted bytes"]),
) {
  const openDownloadStream = vi.fn(open);
  const server = Fastify({ logger: false });
  await server.register(registerShareRoutes, {
    config: f.config, db, now: f.now, storage: { openDownloadStream },
  });
  await server.ready();
  disposers.push(() => server.close());
  return { server, openDownloadStream };
}

async function waitForLock(db: Queryable, pid: number, blocker: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await db.query<{ blocked: boolean }>(
      "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked", [pid, blocker],
    );
    if (rows[0].blocked) return;
  }
  throw new Error("Download did not reach the actual PostgreSQL lock barrier");
}

describe("fresh public share admission on real PostgreSQL", () => {
  it.each(["exact expiry", "past expiry", "revocation", "deletion claim", "file expiry"])(
    "denies %s committed while the independent download client is blocked without counting or opening storage",
    async (condition) => {
      const f = await fixture();
      const claimId = randomUUID();
      await f.db.withClient(async (blocker) => {
        await f.db.withClient(async (downloader) => {
          const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          const downloadPid = (await downloader.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          expect(downloadPid).not.toBe(blockerPid);
          const pinnedDb = {
            query: downloader.query.bind(downloader),
            withClient: async <T>(work: (client: Queryable) => Promise<T>) => work(downloader),
          };
          const { server, openDownloadStream } = await downloadServer(f, pinnedDb);
          await blocker.query("BEGIN");
          // Lifecycle writers lock file first; also hold the share to reproduce
          // the old statement's stale file snapshot at its share update wait.
          if (condition === "deletion claim" || condition === "file expiry") {
            await blocker.query("SELECT id FROM files WHERE code=$1 FOR UPDATE", [f.file.code]);
          }
          await blocker.query("SELECT id FROM share_links WHERE id=$1 FOR UPDATE", [f.share.id]);
          const response = server.inject(f.path).then(value => value);
          try {
            await waitForLock(f.db, downloadPid, blockerPid);
            if (condition === "exact expiry") f.advance("2030-01-01T00:00:01.000Z");
            if (condition === "past expiry") f.advance("2030-01-01T00:00:02.000Z");
            if (condition === "revocation") {
              await blocker.query("UPDATE share_links SET revoked_at=$2 WHERE id=$1", [f.share.id, f.now()]);
            }
            if (condition === "deletion claim") {
              await blocker.query(`UPDATE files SET lifecycle_state='deleting',
                deletion_claim_id=$2, deletion_claimed_at=$3, deletion_claim_reason='manual'
                WHERE code=$1`, [f.file.code, claimId, f.now()]);
            }
            if (condition === "file expiry") {
              await blocker.query("UPDATE files SET is_durable=false, expires_at=$2 WHERE code=$1", [f.file.code, f.now()]);
            }
            await blocker.query("COMMIT");
            expect((await response).statusCode).toBe(410);
            expect(openDownloadStream).not.toHaveBeenCalled();
            expect(await f.count()).toBe(0);
            const row = (await f.db.query<{
              lifecycle_state: string;
              deletion_claim_id: string | null;
              deletion_claim_reason: string | null;
              storage_key: string;
            }>(
              "SELECT lifecycle_state, deletion_claim_id, deletion_claim_reason, storage_key FROM files WHERE code=$1", [f.file.code],
            )).rows[0];
            expect(row.lifecycle_state).toBe(condition === "deletion claim" ? "deleting" : "active");
            expect(row.deletion_claim_id).toBe(condition === "deletion claim" ? claimId : null);
            expect(row.deletion_claim_reason).toBe(condition === "deletion claim" ? "manual" : null);
            expect(await readFile(join(f.storageRoot, row.storage_key), "utf8")).toBe("admitted bytes");
            const revoked = (await f.db.query<{ revoked_at: Date | null }>(
              "SELECT revoked_at FROM share_links WHERE id=$1", [f.share.id],
            )).rows[0].revoked_at;
            expect(revoked).toEqual(condition === "revocation" ? f.now() : null);
          } finally {
            await blocker.query("ROLLBACK");
            await response;
          }
        });
      });
    },
  );

  it("samples time after an actual exhausted-pool wait", async () => {
    const f = await fixture();
    const held = gate();
    const release = gate();
    const entered = gate();
    let heldCount = 0;
    let acquired = false;
    // createDatabase uses pg's default ten-client pool. Pin all ten until
    // the download has entered withClient, proving it must await a lease.
    const holders = Array.from({ length: 10 }, () => f.db.withClient(async () => {
      if (++heldCount === 10) held.release();
      await release.promise;
    }));
    await held.promise;
    const db = {
      ...f.db,
      withClient: <T>(work: (client: Queryable) => Promise<T>) => {
        entered.release();
        return f.db.withClient(client => {
          acquired = true;
          return work(client);
        });
      },
    };
    const { server, openDownloadStream } = await downloadServer(f, db);
    const response = server.inject(f.path).then(value => value);
    try {
      await entered.promise;
      expect(acquired).toBe(false);
      f.advance("2030-01-01T00:00:01.000Z");
    } finally {
      release.release();
      await Promise.all(holders);
    }
    expect((await response).statusCode).toBe(410);
    expect(openDownloadStream).not.toHaveBeenCalled();
    expect(await f.count()).toBe(0);
  });

  it.each(["share", "file"])("rolls back an increment if %s expiry arrives after SQL but before stream admission", async kind => {
    const f = await fixture();
    if (kind === "file") {
      await f.db.query("UPDATE files SET is_durable=false, expires_at='2030-01-01T00:00:00.500Z' WHERE code=$1", [f.file.code]);
    }
    const db = {
      ...f.db,
      withClient: <T>(work: (client: Queryable) => Promise<T>) => f.db.withClient(client => work({
        query: async <R>(sql: string, params?: readonly unknown[]) => {
          const result = await client.query(sql, params as unknown[]);
          if (sql.includes("UPDATE share_links sl")) {
            f.advance(kind === "share" ? "2030-01-01T00:00:01.000Z" : "2030-01-01T00:00:00.500Z");
          }
          return { rows: result.rows as R[], rowCount: result.rowCount };
        },
      })),
    };
    const { server, openDownloadStream } = await downloadServer(f, db);
    expect((await server.inject(f.path)).statusCode).toBe(410);
    expect(openDownloadStream).not.toHaveBeenCalled();
    expect(await f.count()).toBe(0);
  });

  it("rolls back quota if storage opening fails", async () => {
    const f = await fixture();
    const { server, openDownloadStream } = await downloadServer(f, f.db, async () => {
      throw new Error("synthetic storage failure");
    });
    expect((await server.inject(f.path)).statusCode).toBe(500);
    expect(openDownloadStream).toHaveBeenCalledOnce();
    expect(await f.count()).toBe(0);
  });

  it.each(["before", "after"])("closes an opened stream on %s-COMMIT failure without sending bytes", async when => {
    const f = await fixture();
    const stream = Readable.from(["never delivered"]);
    const db = {
      ...f.db,
      withClient: <T>(work: (client: Queryable) => Promise<T>) => f.db.withClient(client => work({
        query: async <R>(sql: string, params?: readonly unknown[]) => {
          if (sql === "COMMIT" && when === "before") throw new Error("synthetic commit failure");
          const result = await client.query(sql, params as unknown[]);
          if (sql === "COMMIT" && when === "after") throw new Error("synthetic lost commit reply");
          return { rows: result.rows as R[], rowCount: result.rowCount };
        },
      })),
    };
    const { server, openDownloadStream } = await downloadServer(f, db, async () => stream);
    const response = await server.inject(f.path);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("never delivered");
    expect(stream.destroyed).toBe(true);
    expect(openDownloadStream).toHaveBeenCalledOnce();
    // Unknown commit outcome fails closed; quota is conservative if committed.
    expect(await f.count()).toBe(when === "before" ? 0 : 1);
  });

  it("lets an admitted stream finish after expiry and revocation without holding SQL locks through delivery", async () => {
    const f = await fixture();
    const opened = gate();
    const stream = new PassThrough();
    const { server } = await downloadServer(f, f.db, async () => {
      opened.release();
      return stream;
    });
    const response = server.inject(f.path).then(value => value);
    await opened.promise;
    f.advance("2030-01-01T00:00:02.000Z");
    // This must finish while the stream is still open: admission locks cannot
    // be held until delivery, and subsequent revocation cannot retract bytes.
    await f.db.query("UPDATE share_links SET revoked_at=$2 WHERE id=$1", [f.share.id, f.now()]);
    expect(await f.count()).toBe(1);
    stream.end("completed after expiry");
    const completed = await response;
    expect(completed.statusCode).toBe(200);
    expect(completed.body).toBe("completed after expiry");
    expect((await server.inject(f.path)).statusCode).toBe(410);
    expect(await f.count()).toBe(1);
  });

  it("admits before expiry and atomically caps concurrent successful downloads", async () => {
    const f = await fixture();
    const { server, openDownloadStream } = await downloadServer(f, f.db);
    const responses = await Promise.all(Array.from({ length: 8 }, () => server.inject(f.path)));
    expect(responses.filter(r => r.statusCode === 200)).toHaveLength(2);
    expect(responses.filter(r => r.statusCode === 410)).toHaveLength(6);
    expect(openDownloadStream).toHaveBeenCalledTimes(2);
    expect(await f.count()).toBe(2);
  });

  it("preserves share and file PostgreSQL microseconds at the fresh route guard", async () => {
    const f = await fixture();
    await f.db.query("UPDATE share_links SET expires_at='2030-01-01T00:00:00.123456Z' WHERE id=$1", [f.share.id]);
    await f.db.query("UPDATE files SET is_durable=false, expires_at='2030-01-01T00:00:00.123456Z' WHERE code=$1", [f.file.code]);
    f.advance("2030-01-01T00:00:00.123Z");
    const { server, openDownloadStream } = await downloadServer(f, f.db);
    expect((await server.inject(f.path)).statusCode).toBe(200);
    f.advance("2030-01-01T00:00:00.124Z");
    expect((await server.inject(f.path)).statusCode).toBe(410);
    expect(openDownloadStream).toHaveBeenCalledOnce();
    expect(await f.count()).toBe(1);
  });
});
