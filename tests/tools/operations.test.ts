import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdir, writeFile, rm, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { resolve, dirname } from "node:path";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: vi.fn(),
}));
afterEach(() => vi.mocked(spawnSync).mockReset());
const operations = await import("../../scripts/backup.mjs") as any;

function inspectedTopology(extraMounts: Array<Record<string, unknown>>) {
  const project = "selected";
  const labels = (service: string) => ({ "com.docker.compose.project": project, "com.docker.compose.service": service, "com.docker.compose.oneoff": "False" });
  const app = { Id: "synthetic-app", Config: { Labels: labels("app"), Cmd: ["node", "dist/server/index.js", "--host=0.0.0.0"], Env: ["STORAGE_ROOT=/data/storage", "DATABASE_URL=postgresql://agentfiles:synthetic@db/agentfiles"] }, State: { Running: true }, Mounts: [{ Type: "volume", Name: "selected_storage", Destination: "/data/storage", RW: true }, ...extraMounts] };
  const db = { Id: "synthetic-db", Config: { Labels: labels("db"), Env: ["POSTGRES_USER=agentfiles", "POSTGRES_DB=agentfiles", "POSTGRES_PASSWORD=synthetic"] }, State: { Running: true }, Mounts: [{ Type: "volume", Name: "selected_database", Destination: "/var/lib/postgresql/data", RW: true }] };
  const calls: Array<{ executable: string; args: string[] }> = [];
  vi.mocked(spawnSync).mockImplementation(((executable: string, args: string[]) => {
    calls.push({ executable, args });
    let stdout: string;
    if (executable === "git") return { status: 0, stdout: "" };
    if (args[0] === "ps") stdout = "synthetic-app\nsynthetic-db";
    else if (args[0] === "inspect") stdout = JSON.stringify([args[1] === app.Id ? app : db]);
    else if (args[0] === "volume" && args[1] === "inspect") stdout = JSON.stringify([{ Driver: "local", Options: {}, Labels: { "com.docker.compose.project": project, "com.docker.compose.volume": args[2] === "selected_storage" ? "storage" : "database" } }]);
    else return { status: 1, stdout: "" }; // Bound the synthetic run at the first mutation.
    return { status: 0, stdout };
  }) as any);
  return calls;
}
describe("owned operational backup boundaries", () => {
  it("provides a strictly selected project/output interface", () => {
    expect(operations.parseBackupOptions).toBeTypeOf("function");
    expect(operations.parseBackupOptions(["--project", "agentfiles", "--output", "./backups"])).toEqual({ project: "agentfiles", output: "./backups" });
  });
  it.each([[], ["--project", "../other", "--output", "backups"], ["--project", "a", "--output", "backups", "--project", "b"], ["--project", "a", "--output", "backups", "--live"]])("rejects missing, unsafe, duplicate or live options %j", args => {
    expect(operations.parseBackupOptions).toBeTypeOf("function");
    expect(() => operations.parseBackupOptions(args)).toThrow();
  });
  it("rejects an active or non-drained writer before archive/dump", () => {
    expect(operations.assertQuiescent).toBeTypeOf("function");
    expect(() => operations.assertQuiescent({ Running: true, ExitCode: 0 })).toThrow();
    expect(() => operations.assertQuiescent({ Running: false, ExitCode: 137 })).toThrow();
    expect(() => operations.assertQuiescent({ Running: false, ExitCode: 0 })).not.toThrow();
  });
  it("reports the selected backup stage and safe stopped state when drain fails", () => {
    const check = () => operations.assertQuiescent({ Running: false, ExitCode: 1, OOMKilled: false }, { stage: "after-stop", initiallyRunning: true });
    expect(check).toThrow('App did not stop with a confirmed successful drain; backup refused');
    expect(check).toThrow('"stage":"after-stop","initiallyRunning":true,"Running":false,"ExitCode":1,"OOMKilled":false');
  });
  it("bounds drain diagnostics and excludes untrusted state/configuration fields", () => {
    let message = "";
    try {
      operations.assertQuiescent({ Running: "private-sentinel", ExitCode: "private-sentinel", OOMKilled: "private-sentinel", Error: "private-sentinel", Env: ["private-sentinel"], StartedAt: "private-sentinel" }, { stage: "private-sentinel".repeat(1000), initiallyRunning: "private-sentinel" });
    } catch (error) { message = (error as Error).message; }
    expect(message).not.toContain("private-sentinel");
    expect(message).toContain('"stage":"unspecified","initiallyRunning":null,"Running":null,"ExitCode":null,"OOMKilled":null');
    expect(message.length).toBeLessThan(300);
  });
  it.each(["after-stop", "after-dump", "after-archive"])("keeps the same success requirement at %s", stage => {
    expect(() => operations.assertQuiescent({ Running: false, ExitCode: 0 }, { stage, initiallyRunning: false })).not.toThrow();
    expect(() => operations.assertQuiescent({ Running: true, ExitCode: 0 }, { stage, initiallyRunning: false })).toThrow();
    expect(() => operations.assertQuiescent({ Running: false, ExitCode: 137, OOMKilled: true }, { stage, initiallyRunning: false })).toThrow('"ExitCode":137,"OOMKilled":true');
  });
  it("rejects redirected/bind/unowned mounts", () => {
    expect(operations.assertOwnedVolume).toBeTypeOf("function");
    const mount = { Type: "volume", Name: "selected_storage", Destination: "/data/storage", RW: true };
    expect(() => operations.assertOwnedVolume(mount, { "com.docker.compose.project": "selected", "com.docker.compose.volume": "storage" }, "selected", "storage", "/data/storage")).not.toThrow();
    for (const bad of [{ ...mount, Type: "bind" }, { ...mount, Destination: "/other" }]) expect(() => operations.assertOwnedVolume(bad, {}, "selected", "storage", "/data/storage")).toThrow();
    expect(() => operations.assertOwnedVolume(mount, { "com.docker.compose.project": "other" }, "selected", "storage", "/data/storage")).toThrow();
  });
  it.each([
    ["volume", "/data/storage/files"],
    ["bind", "/data/storage/files"],
    ["tmpfs", "/data/storage/files"],
    ["bind", "/data/storage/files/payload.bin"],
    ["volume", "/data/storage/a/b/c"],
    ["volume", "/data//storage/./files"],
    ["volume", "/data/storage/../storage/files"],
    ["volume", "/data/storage"],
    ["volume", "/data/storage/"],
  ])("refuses extra %s at %s before output creation or stopping the writer", async (Type, Destination) => {
    const output = resolve(".private", `backup-preflight-${randomUUID()}`);
    const calls = inspectedTopology([{ Type, Destination, Name: "synthetic_extra", RW: true }]);
    try {
      await expect(operations.backupProject({ project: "selected", output })).rejects.toThrow("additional storage mounts");
      expect(calls.some(call => call.executable === "git")).toBe(false);
      expect(calls.every(call => ["ps", "inspect", "volume"].includes(call.args[0]))).toBe(true);
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(output, { recursive: true, force: true }); }
  });
  it.each([{ mounts: [] }, { mounts: [{ Type: "volume", Destination: "/data/storage-sibling/files", Name: "synthetic_sibling", RW: true }] }, { mounts: [{ Type: "tmpfs", Destination: "/data/storage2", RW: true }] }])("accepts ordinary owned storage and path-boundary siblings $mounts", async ({ mounts }) => {
    const calls = inspectedTopology(mounts);
    const output = resolve(".private", `backup-preflight-${randomUUID()}`);
    try {
      await expect(operations.backupProject({ project: "selected", output })).rejects.toThrow("Owned Docker operation failed");
      expect(calls.some(call => call.executable === "git")).toBe(true);
      expect(calls.some(call => call.args[0] === "stop")).toBe(true);
      await expect(access(output)).resolves.toBeUndefined();
    } finally { await rm(output, { recursive: true, force: true }); }
  });
  it("never infers complete later issuance from a timestamp/count", () => {
    expect(operations.validateRecoveryRegistry).toBeTypeOf("function");
    expect(() => operations.validateRecoveryRegistry({ codes: ["F-AAAAA"], generatedAt: new Date().toISOString(), count: 1 }, "volume", true)).toThrow();
    const evidence = { version: 1, volumeId: "volume", boundary: { kind: "quiesced-full-registry", stoppedApp: "container", appImage: "image", databaseSnapshot: "boundary", generatedAt: new Date().toISOString() }, codes: ["F-AAAAA"] };
    expect(() => operations.validateRecoveryRegistry(evidence, "volume", false)).toThrow();
    expect(operations.validateRecoveryRegistry(evidence, "volume", true)).toEqual(["F-AAAAA"]);
    expect(() => operations.validateRecoveryRegistry({ ...evidence, codes: ["F-AAAAA", "F-OOOOO"] }, "volume", true)).toThrow();
    expect(() => operations.validateRecoveryRegistry(evidence, "different", true)).toThrow();
  });
  it("rejects corrupt or incomplete snapshots before restore", async () => {
    const parent = resolve(".private"); const directory = resolve(parent, `backup-unit-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    try {
      const sha256: Record<string,string> = {};
      for (const file of ["database.dump", "storage.tar.gz", "registry.json"]) { const bytes=Buffer.from(`synthetic ${file}`); await writeFile(resolve(directory,file),bytes);sha256[file]=createHash("sha256").update(bytes).digest("hex"); }
      const manifest={version:1,complete:true,sha256}; await writeFile(resolve(directory,"manifest.json"),JSON.stringify(manifest));
      expect((await operations.verifyBackup(directory)).complete).toBe(true);
      await writeFile(resolve(directory,"database.dump"),"changed");
      await expect(operations.verifyBackup(directory)).rejects.toThrow("checksum");
      await writeFile(resolve(directory,"manifest.json"),JSON.stringify({...manifest,complete:false}));
      await expect(operations.verifyBackup(directory)).rejects.toThrow("Incomplete");
    } finally { expect(dirname(directory)).toBe(parent); await rm(directory,{recursive:true}); }
  });
});
