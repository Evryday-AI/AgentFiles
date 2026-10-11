import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIntegrationFixture,
  createOwnedTestDatabase,
  syntheticMultipart,
} from "../helpers/integration";
import { getStorageUsage } from "../../src/server/storage";
import { loadMigrations, migrate } from "../../src/server/migrate";
import { claimFileDeletion, setFileDurable } from "../../src/server/filesRepo";
import type { Permission } from "../../src/server/auth";
const all: Permission[] = [
  "can_upload",
  "can_download",
  "can_list",
  "can_delete",
  "can_mark_durable",
  "can_share",
];
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of disposers.splice(0).reverse()) await close();
});
async function fixture(policy = true) {
  const f = await createIntegrationFixture({ allowPersistentFiles: policy });
  disposers.push(f.close);
  return f;
}
async function login(f: Awaited<ReturnType<typeof fixture>>) {
  const r = await f.server.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      username: f.config.adminUsername,
      password: "synthetic-unused-fixture-password",
    },
  });
  expect(r.statusCode).toBe(200);
  return String(r.headers["set-cookie"]).split(";")[0];
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    files: (await f.db.query("SELECT * FROM files ORDER BY id")).rows,
    shares: (await f.db.query("SELECT * FROM share_links ORDER BY id")).rows,
    codes: (await f.db.query("SELECT * FROM issued_file_codes ORDER BY code"))
      .rows,
    bytes: await getStorageUsage(f.storageRoot),
  };
}
describe("real authorization and runnable schema 3", () => {
  it("a short code does not authorize private bytes", async () => {
    const f = await fixture();
    const file = await f.uploadSynthetic({
      text: "hello",
      permissions: "upload",
    });
    const r = await f.server.inject(`/api/files/${file.code}/download`);
    expect(r.statusCode).toBe(401);
    expect(r.body).not.toContain("hello");
  });
  it("matches the independent-key permission matrix with unchanged DB/disk on every denial", async () => {
    const f = await fixture();
    const file = await f.uploadSynthetic({
      text: "hello",
      permissions: "upload",
    });
    const adminCookie = await login(f);
    const revoked = await f.createSyntheticKey(all);
    await f.db.query("UPDATE api_keys SET revoked_at=now() WHERE id=$1", [
      revoked.id,
    ]);
    const principals = [
      {
        label: "anonymous",
        headers: {},
        permissions: [] as Permission[],
        status: 401,
      },
      {
        label: "malformed",
        headers: { authorization: "Bearer malformed" },
        permissions: [] as Permission[],
        status: 401,
      },
      {
        label: "revoked",
        headers: revoked.headers,
        permissions: [] as Permission[],
        status: 401,
      },
      ...(await Promise.all(
        all.map(async (p) => ({
          label: p,
          headers: (await f.createSyntheticKey([p])).headers,
          permissions: [p],
          status: 403,
        })),
      )),
    ];
    const operations = [
      {
        permission: "can_upload",
        method: "POST",
        url: "/api/files",
        ...syntheticMultipart("denied-synthetic"),
      },
      {
        permission: "can_download",
        method: "GET",
        url: `/api/files/${file.code}`,
      },
      {
        permission: "can_download",
        method: "GET",
        url: `/api/files/${file.code}/download`,
      },
      { permission: "can_list", method: "GET", url: "/api/files" },
      {
        permission: "can_delete",
        method: "DELETE",
        url: `/api/files/${file.code}`,
      },
      {
        permission: "can_mark_durable",
        method: "PATCH",
        url: `/api/files/${file.code}`,
        payload: { durable: true },
      },
      {
        permission: "can_share",
        method: "POST",
        url: `/api/files/${file.code}/share`,
        payload: { expires_at: new Date(Date.now() + 60000).toISOString() },
      },
      {
        permission: "can_share",
        method: "DELETE",
        url: `/api/share-links/${randomUUID()}`,
      },
    ] as const;
    for (const [i, p] of principals.entries())
      for (const op of operations) {
        if (p.permissions.includes(op.permission)) continue;
        const before = await snapshot(f);
        const r = await f.server.inject({
          method: op.method,
          url: op.url,
          payload: "payload" in op ? op.payload : undefined,
          headers: { ...("headers" in op ? op.headers : {}), ...p.headers },
          remoteAddress: `127.0.1.${i + 1}`,
        });
        expect(r.statusCode, p.label + " " + op.url).toBe(p.status);
        expect(r.body).not.toContain("hello");
        expect(await snapshot(f)).toEqual(before);
      }
    // A supplied API key has sole authority even alongside a genuine admin cookie.
    for (const authorization of [
      "Bearer invalid",
      (await f.createSyntheticKey(["can_upload"])).headers.authorization,
    ]) {
      const before = await snapshot(f);
      const r = await f.server.inject({
        url: `/api/files/${file.code}/download`,
        headers: { authorization, cookie: adminCookie },
      });
      expect(r.statusCode).toBe(authorization === "Bearer invalid" ? 401 : 403);
      expect(await snapshot(f)).toEqual(before);
    }
    const download = await f.createSyntheticKey(["can_download"]);
    const r = await f.server.inject({
      url: `/api/files/${file.code}/download`,
      headers: download.headers,
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("hello");
    const listing = await f.createSyntheticKey(["can_list"]);
    expect(
      (await f.server.inject({ url: "/api/files", headers: listing.headers }))
        .json()
        .files.map((x: { code: string }) => x.code),
    ).toContain(file.code);
    const keep = await f.createSyntheticKey(["can_mark_durable"]);
    const kept = await f.server.inject({
      method: "PATCH",
      url: `/api/files/${file.code}`,
      headers: keep.headers,
      payload: { durable: true },
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().durable).toBe(true);
    const restored = await f.server.inject({
      method: "PATCH",
      url: `/api/files/${file.code}`,
      headers: keep.headers,
      payload: { durable: false },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().expires_at).not.toBeNull();
    const sharing = await f.createSyntheticKey(["can_share"]);
    const shared = await f.server.inject({
      method: "POST",
      url: `/api/files/${file.code}/share`,
      headers: sharing.headers,
      payload: {
        expires_at: new Date(Date.now() + 60000).toISOString(),
        max_downloads: 1,
      },
    });
    expect(shared.statusCode).toBe(201);
    const publicUrl = new URL(shared.json().public_url).pathname;
    expect((await f.server.inject(publicUrl)).body).toBe("hello");
    expect((await f.server.inject(publicUrl)).statusCode).toBe(410);
    expect(
      (
        await f.server.inject({
          method: "DELETE",
          url: `/api/share-links/${shared.json().id}`,
          headers: sharing.headers,
        })
      ).statusCode,
    ).toBe(200);
    const deletion = await f.createSyntheticKey(["can_delete"]);
    expect(
      (
        await f.server.inject({
          method: "DELETE",
          url: `/api/files/${file.code}`,
          headers: deletion.headers,
        })
      ).statusCode,
    ).toBe(200);
    expect((await getStorageUsage(f.storageRoot)).bytes).toBe(0);
    const row = (
      await f.db.query<{ lifecycle_state: string; deletion_claim_id: string }>(
        "SELECT lifecycle_state,deletion_claim_id FROM files WHERE code=$1",
        [file.code],
      )
    ).rows[0];
    expect(row.lifecycle_state).toBe("deleted");
    expect(row.deletion_claim_id).toBeTruthy();
    expect(
      (
        await f.db.query("SELECT * FROM issued_file_codes WHERE code=$1", [
          file.code,
        ])
      ).rows,
    ).toEqual([{ code: file.code }]);
  });
  it("matches genuine administrator and expired/revoked session matrix", async () => {
    const f = await fixture();
    const cookie = await login(f);
    const headers = { cookie, origin: f.config.publicBaseUrl };
    const file = await f.uploadSynthetic({
      text: "admin matrix",
      permissions: "upload",
    });
    for (const url of [
      "/api/auth/session",
      "/api/admin/api-keys",
      "/api/admin/storage-usage",
      "/api/files",
      `/api/files/${file.code}`,
      `/api/files/${file.code}/download`,
    ])
      expect((await f.server.inject({ url, headers })).statusCode).toBe(200);
    const created = await f.server.inject({
      method: "POST",
      url: "/api/admin/api-keys",
      headers,
      payload: { name: "synthetic admin-created", can_upload: false },
    });
    expect(created.statusCode).toBe(201);
    expect(
      (
        await f.server.inject({
          method: "PATCH",
          url: `/api/admin/api-keys/${created.json().apiKey.id}`,
          headers,
          payload: { can_download: false },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.server.inject({
          method: "DELETE",
          url: `/api/admin/api-keys/${created.json().apiKey.id}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    const upload = syntheticMultipart("admin upload", true);
    expect(
      (
        await f.server.inject({
          method: "POST",
          url: "/api/files",
          headers: { ...headers, ...upload.headers },
          payload: upload.payload,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await f.server.inject({
          method: "PATCH",
          url: `/api/files/${file.code}`,
          headers,
          payload: { durable: true },
        })
      ).statusCode,
    ).toBe(200);
    const shared = await f.server.inject({
      method: "POST",
      url: `/api/files/${file.code}/share`,
      headers,
      payload: { expires_at: new Date(Date.now() + 60000).toISOString() },
    });
    expect(shared.statusCode).toBe(201);
    expect(
      (
        await f.server.inject({
          method: "DELETE",
          url: `/api/share-links/${shared.json().id}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.server.inject({
          method: "DELETE",
          url: `/api/files/${file.code}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    for (const state of ["expired", "revoked"]) {
      await f.db.query(
        state === "expired"
          ? "UPDATE admin_sessions SET expires_at=now()-interval '1 second'"
          : "UPDATE admin_sessions SET expires_at=now()+interval '1 day', revoked_at=now()",
      );
      const before = await snapshot(f);
      const session = await f.server.inject({
        url: "/api/auth/session",
        headers,
      });
      expect(session.json().authenticated).toBe(false);
      expect(
        (
          await f.server.inject({
            method: "POST",
            url: "/api/files",
            headers: { ...headers, ...upload.headers },
            payload: upload.payload,
          })
        ).statusCode,
      ).toBe(401);
      expect(await snapshot(f)).toEqual(before);
      for (const request of [
        { method: "GET", url: "/api/files" },
        { method: "GET", url: `/api/files/${file.code}` },
        { method: "GET", url: `/api/files/${file.code}/download` },
        {
          method: "PATCH",
          url: `/api/files/${file.code}`,
          payload: { durable: true },
        },
        { method: "DELETE", url: `/api/files/${file.code}` },
        {
          method: "POST",
          url: `/api/files/${file.code}/share`,
          payload: { expires_at: new Date(Date.now() + 60000).toISOString() },
        },
        { method: "DELETE", url: `/api/share-links/${shared.json().id}` },
      ]) {
        expect(
          (
            await f.server.inject({
              ...request,
              method: request.method as "GET",
              headers,
            })
          ).statusCode,
        ).toBe(401);
        expect(await snapshot(f)).toEqual(before);
      }
    }
  });
  it("forbidden persistence intent preserves DB and disk for both operator and key denial", async () => {
    for (const policy of [false, true]) {
      const f = await fixture(policy);
      const key = await f.createSyntheticKey(policy ? ["can_upload"] : all);
      const before = await snapshot(f);
      const upload = syntheticMultipart("forbidden durable", true);
      const r = await f.server.inject({
        method: "POST",
        url: "/api/files",
        headers: { ...key.headers, ...upload.headers },
        payload: upload.payload,
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().code).toBe(
        policy ? "PERMISSION_DENIED" : "PERSISTENCE_DISABLED",
      );
      expect(await snapshot(f)).toEqual(before);
    }
  });
  it("SQL prevents claimed files exposing metadata/private/share bytes and retention", async () => {
    const f = await fixture();
    const file = await f.uploadSynthetic({
      text: "claim-secret-bytes",
      permissions: "upload",
    });
    const key = await f.createSyntheticKey(all);
    const shared = await f.server.inject({
      method: "POST",
      url: `/api/files/${file.code}/share`,
      headers: key.headers,
      payload: { expires_at: new Date(Date.now() + 60000).toISOString() },
    });
    expect(shared.statusCode).toBe(201);
    const claim = await claimFileDeletion(file.code, "manual", f.db);
    expect(claim?.lifecycleState).toBe("deleting");
    const before = await snapshot(f);
    for (const path of [
      `/api/files/${file.code}`,
      `/api/files/${file.code}/download`,
      new URL(shared.json().public_url).pathname,
    ]) {
      const r = await f.server.inject({ url: path, headers: key.headers });
      expect(r.statusCode).toBe(410);
      expect(r.body).not.toContain("claim-secret-bytes");
    }
    const patch = await f.server.inject({
      method: "PATCH",
      url: `/api/files/${file.code}`,
      headers: key.headers,
      payload: { durable: true },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().code).toBe("FILE_DELETION_IN_PROGRESS");
    expect(await snapshot(f)).toEqual(before);
  });
  it("003 backfills deleted codes, constrains nullable claims, and never cascades reservations", async () => {
    const f = await createOwnedTestDatabase();
    disposers.push(f.close);
    const migrations = await loadMigrations();
    await f.db.query(migrations[0].sql);
    await f.db.query(
      "INSERT INTO files(code,original_name,storage_key,mime_type,size_bytes,uploaded_by_type,is_durable,deleted_at) VALUES('F-ABCDE','synthetic','synthetic','text/plain',0,'admin',true,now())",
    );
    await migrate(f.db);
    expect((await f.db.query("SELECT * FROM issued_file_codes")).rows).toEqual([
      { code: "F-ABCDE" },
    ]);
    expect(
      (await f.db.query("SELECT lifecycle_state FROM files")).rows,
    ).toEqual([{ lifecycle_state: "deleted" }]);
    await expect(
      f.db.query(
        "UPDATE files SET lifecycle_state='deleting',deleted_at=NULL,deletion_claim_id=gen_random_uuid(),deletion_claimed_at=now(),deletion_claim_reason=NULL",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      f.db.query(
        "UPDATE files SET lifecycle_state='active',deleted_at=NULL,deletion_claim_reason='manual'",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      f.db.query("DELETE FROM issued_file_codes"),
    ).rejects.toMatchObject({ code: "23503" });
    await f.db.query("DELETE FROM files");
    expect((await f.db.query("SELECT * FROM issued_file_codes")).rows).toEqual([
      { code: "F-ABCDE" },
    ]);
  });
  it("003 rejects invalid source code and rolls back backfill rather than renaming history", async () => {
    const f = await createOwnedTestDatabase();
    disposers.push(f.close);
    await f.db.query((await loadMigrations())[0].sql);
    await f.db.query(
      "INSERT INTO files(code,original_name,storage_key,mime_type,size_bytes,uploaded_by_type,is_durable) VALUES('F-OLD01','synthetic','synthetic','text/plain',0,'admin',true)",
    );
    await expect(migrate(f.db)).rejects.toMatchObject({ code: "23514" });
    expect((await f.db.query("SELECT code FROM files")).rows).toEqual([
      { code: "F-OLD01" },
    ]);
    expect(
      (await f.db.query("SELECT to_regclass('issued_file_codes') AS registry"))
        .rows,
    ).toEqual([{ registry: null }]);
  });
  it("expired unclaimed retention cannot resurrect bytes", async () => {
    const f = await fixture();
    const file = await f.uploadSynthetic({
      text: "expired",
      permissions: "upload",
    });
    const key = await f.createSyntheticKey(all);
    await f.db.query(
      "UPDATE files SET expires_at=clock_timestamp() WHERE code=$1",
      [file.code],
    );
    const before = await snapshot(f);
    const r = await f.server.inject({
      method: "PATCH",
      url: `/api/files/${file.code}`,
      headers: key.headers,
      payload: { durable: true },
    });
    expect(r.statusCode).toBe(410);
    expect(await snapshot(f)).toEqual(before);
  });
  it("cookie mutation defenses reject all cross-origin writes without changing file, credential or session tables", async () => {
    const f = await fixture();
    const cookie = await login(f);
    const file = await f.uploadSynthetic({
      text: "csrf fixture",
      permissions: "upload",
    });
    const createdKey = await f.createSyntheticKey([]);
    const requests = [
      {
        method: "POST",
        url: "/api/auth/login",
        payload: {
          username: f.config.adminUsername,
          password: "synthetic-unused-fixture-password",
        },
      },
      { method: "POST", url: "/api/auth/logout" },
      { method: "POST", url: "/api/files", payload: {} },
      {
        method: "PATCH",
        url: `/api/files/${file.code}`,
        payload: { durable: true },
      },
      { method: "DELETE", url: `/api/files/${file.code}` },
      {
        method: "POST",
        url: `/api/files/${file.code}/share`,
        payload: { expires_at: new Date(Date.now() + 60000).toISOString() },
      },
      { method: "DELETE", url: `/api/share-links/${randomUUID()}` },
      {
        method: "POST",
        url: "/api/admin/api-keys",
        payload: { name: "csrf key" },
      },
      {
        method: "PATCH",
        url: `/api/admin/api-keys/${createdKey.id}`,
        payload: { can_upload: true },
      },
      { method: "DELETE", url: `/api/admin/api-keys/${createdKey.id}` },
    ];
    const before = await snapshot(f);
    const credentials = (await f.db.query("SELECT * FROM api_keys ORDER BY id"))
      .rows;
    const sessions = (
      await f.db.query("SELECT * FROM admin_sessions ORDER BY id")
    ).rows;
    for (const request of requests)
      for (const browserHeaders of [
        { origin: "https://cross.example" },
        { origin: f.config.publicBaseUrl, "sec-fetch-site": "cross-site" },
      ]) {
        const response = await f.server.inject({
          ...request,
          method: request.method as "POST",
          headers: { cookie, ...browserHeaders },
        });
        expect(response.statusCode).toBe(403);
        expect(await snapshot(f)).toEqual(before);
        expect(
          (await f.db.query("SELECT * FROM api_keys ORDER BY id")).rows,
        ).toEqual(credentials);
        expect(
          (await f.db.query("SELECT * FROM admin_sessions ORDER BY id")).rows,
        ).toEqual(sessions);
      }
  });

  it("003 rejects duplicate source history without deleting or renaming source rows", async () => {
    const f = await createOwnedTestDatabase();
    disposers.push(f.close);
    await f.db.query((await loadMigrations())[0].sql);
    await f.db.query("ALTER TABLE files DROP CONSTRAINT files_code_key");
    await f.db.query(
      "INSERT INTO files(code,original_name,storage_key,mime_type,size_bytes,uploaded_by_type,is_durable) VALUES('F-ABCDE','synthetic','synthetic','text/plain',0,'admin',true),('F-ABCDE','synthetic','synthetic2','text/plain',0,'admin',true)",
    );
    await expect(migrate(f.db)).rejects.toMatchObject({ code: "23505" });
    expect((await f.db.query("SELECT code FROM files")).rows).toEqual([
      { code: "F-ABCDE" },
      { code: "F-ABCDE" },
    ]);
    expect(
      (await f.db.query("SELECT to_regclass('issued_file_codes') AS registry"))
        .rows,
    ).toEqual([{ registry: null }]);
  });
  it("003 nullable lifecycle consistency rejects every partial claim", async () => {
    const f = await fixture();
    const file = await f.uploadSynthetic({
      text: "constraints",
      permissions: "upload",
    });
    const invalidStates = [
      "lifecycle_state='active',deleted_at=now(),deletion_claim_id=NULL,deletion_claimed_at=NULL,deletion_claim_reason=NULL",
      "lifecycle_state='active',deleted_at=NULL,deletion_claim_id=gen_random_uuid(),deletion_claimed_at=NULL,deletion_claim_reason=NULL",
      "lifecycle_state='deleting',deleted_at=NULL,deletion_claim_id=NULL,deletion_claimed_at=now(),deletion_claim_reason='expired'",
      "lifecycle_state='deleting',deleted_at=NULL,deletion_claim_id=gen_random_uuid(),deletion_claimed_at=NULL,deletion_claim_reason='expired'",
      "lifecycle_state='deleting',deleted_at=NULL,deletion_claim_id=gen_random_uuid(),deletion_claimed_at=now(),deletion_claim_reason=NULL",
      "lifecycle_state='deleting',deleted_at=NULL,deletion_claim_id=gen_random_uuid(),deletion_claimed_at=now(),deletion_claim_reason='invalid'",
      "lifecycle_state='deleted',deleted_at=NULL,deletion_claim_id=NULL,deletion_claimed_at=NULL,deletion_claim_reason=NULL",
      "lifecycle_state='deleted',deleted_at=now(),deletion_claim_id=gen_random_uuid(),deletion_claimed_at=now(),deletion_claim_reason=NULL",
      "lifecycle_state='invalid',deleted_at=NULL,deletion_claim_id=NULL,deletion_claimed_at=NULL,deletion_claim_reason=NULL",
    ];
    for (const state of invalidStates)
      await expect(
        f.db.query(`UPDATE files SET ${state} WHERE code=$1`, [file.code]),
      ).rejects.toMatchObject({ code: "23514" });
    const columns = (
      await f.db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name='issued_file_codes'",
      )
    ).rows;
    expect(columns).toEqual([{ column_name: "code" }]);
  });
});
