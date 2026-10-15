import { afterEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createIntegrationFixture, syntheticMultipart } from "../helpers/integration";
import { isolatedEnvironment } from "../../scripts/smoke-compose.mjs";
import { mergeRecoveryRegistry } from "../../scripts/backup.mjs";
import { verifyLocalHttps } from "../helpers/operations-https.mjs";

const fixtures: Awaited<ReturnType<typeof createIntegrationFixture>>[] = [];
const children: ChildProcess[] = [];
const current = new WeakMap<object, ChildProcess>();
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function fixture() {
  const f = await createIntegrationFixture({ maxUploadBytes: 1024, minFreeDiskBytes: 0, allowPersistentFiles: true, cleanupIntervalMs: 0 });
  fixtures.push(f); return f;
}
async function runtime(f: Awaited<ReturnType<typeof fixture>>, mode = "", extra: any = {}) {
  await f.server.close();
  const prior = current.get(f);
  if (prior && prior.exitCode === null && prior.signalCode === null) { prior.kill("SIGKILL"); await once(prior, "exit"); }
  const child = fork(resolve("tests/helpers/operations-child.mjs"), [], { env: isolatedEnvironment(process.env), windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.push(child);
  current.set(f, child);
  let seq = 0;
  const messages: any[] = [];
  child.on("message", message => messages.push(message));
  const wait = async (predicate: (message: any) => boolean) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const at = messages.findIndex(predicate);
      if (at >= 0) return messages.splice(at, 1)[0];
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Operational child failed before expected boundary");
      await new Promise(done => setTimeout(done, 10));
    }
    throw new Error("Operational child boundary deadline");
  };
  const call = async (command: string, input: any = {}) => {
    const id = ++seq; child.send({ id, command, ...input });
    const result = await wait(message => message.id === id);
    if (result.error) throw new Error("Operational child command failed");
    return result.value;
  };
  const result = await call("start", { config: { ...f.config, nodeEnv: "production" }, mode, ...extra });
  return { child, call, base: result.base, barrier: () => wait(message => message.boundary === mode), release: () => child.send({ command: "release" }), async crash() { child.kill("SIGKILL"); const outcome = await once(child, "exit"); expect(outcome[0] !== 0 || outcome[1] !== null).toBe(true); } };
}
const upload = (r: any, headers: any, text: string) => { const body = syntheticMultipart(text); return fetch(`${r.base}/api/files`, { method: "POST", headers: { ...headers, ...body.headers }, body: body.payload }).then(async response => ({ status: response.status, body: await response.json() })).catch(() => ({ status: 0 })); };
const row = async (f: any, code: string) => (await f.db.query("SELECT * FROM files WHERE code=$1", [code])).rows[0];

describe("compiled production runtime operations", () => {
  it.each(["upload-temp", "upload-final"])("reclaims only abandoned upload bytes after external process kill at %s", async mode => {
    const f = await fixture();
    const kept = await f.uploadSynthetic({ text: "preserved", permissions: ["can_upload", "can_mark_durable"], durable: true });
    const key = await f.createSyntheticKey(["can_upload", "can_download"]);
    const r = await runtime(f, mode);
    const pending = upload(r, key.headers, "abandoned");
    const boundary = await r.barrier();
    expect(await readFile(join(f.storageRoot, boundary.key), "utf8")).toBe("abandoned");
    expect((await f.db.query("SELECT count(*)::int AS n FROM files")).rows[0].n).toBe(1);
    await r.crash(); await pending;
    const restarted = await runtime(f);
    expect((await restarted.call("capacity")).managedBytes).toBe(18);
    const old = new Date(Date.now() - f.config.orphanGraceMs - 10000);
    await utimes(join(f.storageRoot, boundary.key), old, old);
    await restarted.call("maintenance");
    await expect(access(join(f.storageRoot, boundary.key))).rejects.toThrow();
    expect((await restarted.call("capacity")).managedBytes).toBe(9);
    const response = await fetch(`${restarted.base}/api/files/${kept.code}/download`, { headers: key.headers });
    expect(response.status).toBe(200); expect(await response.text()).toBe("preserved");
  });
  it.each(["delete-claimed", "delete-unlinked"])("resumes the same durable claim after external kill at %s", async mode => {
    const f = await fixture();
    const file = await f.uploadSynthetic({ text: "delete me", permissions: "upload" });
    const survivor = await f.uploadSynthetic({ text: "survivor", permissions: ["can_upload", "can_mark_durable"], durable: true });
    const key = await f.createSyntheticKey(["can_delete", "can_download", "can_mark_durable", "can_share"]);
    const r = await runtime(f, mode);
    const pending = fetch(`${r.base}/api/files/${file.code}`, { method: "DELETE", headers: key.headers }).catch(() => undefined);
    await r.barrier();
    const claimed = await row(f, file.code);
    expect(claimed.lifecycle_state).toBe("deleting"); expect(claimed.deletion_claim_id).toBeTruthy();
    if (mode === "delete-claimed") await access(join(f.storageRoot, claimed.storage_key));
    else await expect(access(join(f.storageRoot, claimed.storage_key))).rejects.toThrow();
    await r.crash(); await pending;
    const restarted = await runtime(f);
    expect((await restarted.call("capacity")).managedBytes).toBe(mode === "delete-claimed" ? 17 : 8);
    for (const [method, suffix, body] of [["GET", "", undefined], ["GET", "/download", undefined], ["PATCH", "", { durable: true }], ["POST", "/share", { expires_at: new Date(Date.now()+3600000).toISOString() }]] as const) {
      const response = await fetch(`${restarted.base}/api/files/${file.code}${suffix}`, { method, headers: { ...key.headers, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(response.status).toBe(method === "PATCH" ? 409 : 410);
    }
    await restarted.call("maintenance");
    const finalized = await row(f, file.code);
    expect(finalized.lifecycle_state).toBe("deleted"); expect(finalized.deletion_claim_id).toBe(claimed.deletion_claim_id);
    await expect(access(join(f.storageRoot, claimed.storage_key))).rejects.toThrow();
    expect((await restarted.call("capacity")).managedBytes).toBe(8);
    await restarted.call("maintenance"); expect((await restarted.call("capacity")).managedBytes).toBe(8);
    const preserved = await fetch(`${restarted.base}/api/files/${survivor.code}/download`, { headers: key.headers });
    expect(preserved.status).toBe(200); expect(await preserved.text()).toBe("survivor");
    expect((await f.db.query("SELECT count(*)::int n FROM issued_file_codes WHERE code=$1", [file.code])).rows[0].n).toBe(1);
  });
  it("preserves a successful keep against a stale cleanup candidate; delete-first refuses keep", async () => {
    const f = await fixture();
    const kept = await f.uploadSynthetic({ text: "keep", permissions: "upload" });
    const deleted = await f.uploadSynthetic({ text: "delete", permissions: "upload" });
    const key = await f.createSyntheticKey(["can_mark_durable", "can_delete"]);
    const r = await runtime(f);
    expect(await r.call("capture-expiry", { code: kept.code })).toBe(true);
    const keep = await fetch(`${r.base}/api/files/${kept.code}`, { method: "PATCH", headers: { ...key.headers, "content-type": "application/json" }, body: JSON.stringify({ durable: true }) });
    expect(keep.status).toBe(200);
    expect((await r.call("stale-cleanup", { code: kept.code })).deleted).toBe(0);
    await access(join(f.storageRoot, (await row(f, kept.code)).storage_key));
    const racing = await runtime(f, "delete-claimed");
    const remove = fetch(`${racing.base}/api/files/${deleted.code}`, { method: "DELETE", headers: key.headers });
    await racing.barrier();
    const competing = await fetch(`${racing.base}/api/files/${deleted.code}`, { method: "PATCH", headers: { ...key.headers, "content-type": "application/json" }, body: JSON.stringify({ durable: true }) });
    expect(competing.status).toBe(409); racing.release(); expect((await remove).status).toBe(200);
  });
  it("merges later purged reservations before issuance; without coverage uploads stay disabled", async () => {
    const f = await fixture();
    const file = await f.uploadSynthetic({ text: "old identity", permissions: "upload" });
    const key = await f.createSyntheticKey(["can_upload", "can_delete", "can_download"]);
    const r = await runtime(f);
    expect((await fetch(`${r.base}/api/files/${file.code}`, { method: "DELETE", headers: key.headers })).status).toBe(200);
    await f.db.query("UPDATE files SET deleted_at='2000-01-01' WHERE code=$1", [file.code]);
    await r.call("maintenance"); expect(await row(f, file.code)).toBeUndefined();
    const identity = (await f.db.query("SELECT volume_id FROM storage_volume_identity WHERE singleton")).rows[0].volume_id;
    const evidence = { version: 1, volumeId: identity, boundary: { kind: "quiesced-full-registry", stoppedApp: "owned-synthetic-stopped-writer", appImage: "compiled-runtime", databaseSnapshot: "test-boundary", generatedAt: new Date().toISOString() }, codes: [file.code] };
    await expect(mergeRecoveryRegistry(f.db, evidence, identity, false)).rejects.toThrow();
    const disabled = await runtime(f, "", { issuanceEnabled: false });
    expect((await upload(disabled, key.headers, "blocked")).status).toBe(503);
    await mergeRecoveryRegistry(f.db, evidence, identity, true);
    const collision = await runtime(f, "", { collision: file.code });
    const replacement = await upload(collision, key.headers, "new identity"); expect(replacement.status).toBe(201); expect((replacement as any).body.code).not.toBe(file.code);
    expect((await fetch(`${collision.base}/api/files/${file.code}`, { headers: key.headers })).status).toBe(404);
  });
  it("inserts a missing later reservation into a fresh recovery database without dropping existing codes", async () => {
    const source = await fixture();
    const later = await source.uploadSynthetic({ text: "later source identity", permissions: "upload" });
    const recovery = await fixture();
    const retained = await recovery.uploadSynthetic({ text: "existing recovery identity", permissions: "upload" });
    expect(retained.code).not.toBe(later.code);
    const reservations = async () => (await recovery.db.query<{ code: string }>("SELECT code FROM issued_file_codes ORDER BY code")).rows.map(row => row.code);
    expect(await reservations()).toEqual([retained.code]);
    expect(await row(recovery, later.code)).toBeUndefined();
    await source.server.close();
    await recovery.server.close();
    // Model an older snapshot's reservation/identity in a separate owned DB.
    // Only these synthetic fixtures are rebound, offline, to the same source
    // installation identity; neither app can issue during the registry export.
    await source.db.query("INSERT INTO issued_file_codes(code) VALUES($1)", [retained.code]);
    const identity = (await source.db.query("SELECT volume_id FROM storage_volume_identity WHERE singleton")).rows[0].volume_id;
    await recovery.db.query("UPDATE storage_volume_identity SET volume_id=$1 WHERE singleton", [identity]);
    await writeFile(join(recovery.storageRoot, ".agentfiles-volume"), identity, { mode: 0o600 });
    const codes = (await source.db.query<{ code: string }>("SELECT code FROM issued_file_codes ORDER BY code")).rows.map(row => row.code);
    const snapshot = (await source.db.query("SELECT txid_current_snapshot()::text AS boundary")).rows[0].boundary;
    const evidence = { version: 1, volumeId: identity, boundary: { kind: "quiesced-full-registry", stoppedApp: "owned-synthetic-stopped-source", appImage: "compiled-runtime", databaseSnapshot: snapshot, generatedAt: new Date().toISOString() }, codes };
    await mergeRecoveryRegistry(recovery.db, evidence, identity, true);
    expect(await reservations()).toEqual([retained.code, later.code].sort());
    const key = await recovery.createSyntheticKey(["can_upload", "can_download"]);
    const collision = await runtime(recovery, "", { collision: later.code });
    const replacement = await upload(collision, key.headers, "new recovered identity");
    expect(replacement.status).toBe(201); expect((replacement as any).body.code).not.toBe(later.code);
    expect(await reservations()).toContain(retained.code);
    expect(await reservations()).toContain(later.code);
    expect((await fetch(`${collision.base}/api/files/${later.code}`, { headers: key.headers })).status).toBe(404);
    const preserved = await fetch(`${collision.base}/api/files/${retained.code}/download`, { headers: key.headers });
    expect(preserved.status).toBe(200); expect(await preserved.text()).toBe("existing recovery identity");
  });
  it("injected ENOSPC after real staging fails safely without filling the host disk", async () => {
    const f = await fixture(); const key = await f.createSyntheticKey(["can_upload"]);
    const r = await runtime(f, "enospc");
    expect((await upload(r, key.headers, "space failure")).status).toBe(507);
    expect((await r.call("capacity")).managedBytes).toBe(0);
    expect((await f.db.query("SELECT count(*)::int n FROM issued_file_codes")).rows[0].n).toBe(0);
    expect(await readdir(join(f.storageRoot, ".tmp"))).toEqual([]);
  });
  it("denies restored expired bytes before maintenance physically removes them", async () => {
    const f = await fixture(); const file = await f.uploadSynthetic({ text: "expired", permissions: "upload" });
    const key = await f.createSyntheticKey(["can_download"]);
    await f.db.query("UPDATE files SET expires_at=now()-interval '1 second' WHERE code=$1", [file.code]);
    const r = await runtime(f); const stored = await row(f, file.code);
    await access(join(f.storageRoot, stored.storage_key));
    expect((await fetch(`${r.base}/api/files/${file.code}/download`, { headers: key.headers })).status).toBe(410);
    await r.call("maintenance"); await expect(access(join(f.storageRoot, stored.storage_key))).rejects.toThrow();
  });
  it("verifies local CA HTTPS in real Chromium with Secure cookies, proxy caps/timeouts and safe logs", async () => {
    const f = await fixture();
    const evidence = await verifyLocalHttps({ directory: join(f.storageRoot, "tls-fixture"), username: f.config.adminUsername, password: "synthetic-unused-fixture-password", startRuntime: (origin: string) => runtime(f, "", { config: { ...f.config, nodeEnv: "production", deploymentMode: "public", publicBaseUrl: origin, trustProxy: ["127.0.0.1"] } }) });
    expect(evidence.browser).toMatch(/^\d+\./);
  }, 30000);
});
