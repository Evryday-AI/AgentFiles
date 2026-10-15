import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIntegrationFixture, syntheticMultipart } from "../helpers/integration";
import { isolatedEnvironment, sanitizeDiagnostics } from "../../scripts/smoke-compose.mjs";
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of disposers.splice(0).reverse())
  await close(); });
async function fixture() {
  const reservation = createServer();
  await new Promise<void>((done, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", done);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Fixture address missing");
  const port = address.port;
  await new Promise<void>((done, reject) => reservation.close(error => error ? reject(error) : done()));
  const f = await createIntegrationFixture({ publicBaseUrl: `http://127.0.0.1:${port}`, port });
  disposers.push(f.close);
  await f.server.listen({ port, host: "127.0.0.1" });
  return f;
}
async function runPython(f: Awaited<ReturnType<typeof fixture>>, key: string, args: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "agentfiles-client-"));
  disposers.push(async () => { if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.split(/[\\/]/).at(-1)?.startsWith("agentfiles-client-"))
    throw new Error("Unowned client path"); await rm(directory, { recursive: true }); });
  const source = join(directory, "hello.txt");
  await writeFile(source, "AgentFiles independent subprocess fixture\n");
  const outcome = await new Promise<{
    status: number | null;
    output: string;
  }>((done, reject) => {
    const child = spawn(process.platform === "win32" ? "python" : "python3", [resolve("examples/roundtrip.py"), source, "--output-dir", directory, ...args], { env: { ...isolatedEnvironment(process.env), AGENTFILES_BASE_URL: f.config.publicBaseUrl, AGENTFILES_API_KEY: key }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const capture = (chunk: Buffer) => { output += chunk.toString(); if (output.length > 32768)
      child.kill(); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => child.kill(), 20000);
    child.on("error", () => { clearTimeout(timer); reject(new Error("Python client unavailable")); });
    child.on("close", status => { clearTimeout(timer); done({ status, output }); });
  });
  expect(outcome.output.includes(key)).toBe(false);
  return { ...outcome, directory, diagnostic: sanitizeDiagnostics(outcome.output, [key]) };
}
describe("independent agent subprocess and permission boundaries", () => {
  it("runs native Python upload, lookup, private and anonymous download, SHA, explicit share/revoke/delete", async () => {
    const f = await fixture();
    const key = await f.createSyntheticKey(["can_upload", "can_download", "can_share", "can_delete"]);
    const r = await runPython(f, key.secret, ["--share-expires-at", new Date(Date.now() + 60000).toISOString(), "--revoke-share", "--delete"]);
    expect(r.status, r.diagnostic).toBe(0);
    const result = JSON.parse(r.output.slice(r.output.indexOf("\n") + 1));
    expect(result.verified_sha256).toBe(result.sha256);
    expect(result.anonymous_share_verified).toBe(true);
    expect(result.remote_deleted).toBe(true);
    expect(result.share_revoked).toBe(true);
    expect(await readFile(result.downloaded_to, "utf8")).toBe("AgentFiles independent subprocess fixture\n");
    expect((await f.server.inject({ url: `/api/files/${result.code}`, headers: key.headers })).statusCode).toBe(404);
    expect((await f.server.inject(new URL(result.share.public_url).pathname)).statusCode).toBe(410);
  });
  it("denies revoked keys on the next request and upload-only/download-only boundaries", async () => {
    const f = await fixture();
    const upload = await f.createSyntheticKey(["can_upload"]);
    const download = await f.createSyntheticKey(["can_download"]);
    const file = await f.uploadSynthetic({ text: "permission fixture", permissions: "upload" });
    expect((await f.server.inject({ url: `/api/files/${file.code}`, headers: upload.headers })).statusCode).toBe(403);
    expect((await f.server.inject({ method: "POST", url: "/api/files", headers: { ...download.headers, ...syntheticMultipart("denied").headers }, payload: syntheticMultipart("denied").payload })).statusCode).toBe(403);
    for (const method of ["PATCH", "DELETE"] as const)
      expect((await f.server.inject({ method, url: `/api/files/${file.code}`, headers: download.headers, ...(method === "PATCH" ? { payload: { durable: true } } : {}) })).statusCode).toBe(403);
    await f.db.query("UPDATE api_keys SET revoked_at=now() WHERE id=$1", [download.id]);
    expect((await f.server.inject({ url: `/api/files/${file.code}/download`, headers: download.headers })).statusCode).toBe(401);
    const r = await runPython(f, download.secret);
    expect(r.status).toBe(1);
    expect(r.output).toContain("HTTP 200 does not mean authenticated");
    expect(Number((await f.db.query("SELECT count(*) FROM files")).rows[0].count)).toBe(1);
  });
  it("does not downgrade explicit persistence when installation policy denies it", async () => {
    const f = await fixture();
    const key = await f.createSyntheticKey(["can_upload", "can_download", "can_mark_durable"]);
    const r = await runPython(f, key.secret, ["--persist"]);
    expect(r.status).toBe(1);
    expect(r.output.includes("HTTP 403")).toBe(true);
    expect(Number((await f.db.query("SELECT count(*) FROM files")).rows[0].count)).toBe(0);
    expect(Number((await f.db.query("SELECT count(*) FROM issued_file_codes")).rows[0].count)).toBe(0);
  });
});
