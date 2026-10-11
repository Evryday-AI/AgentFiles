import { describe, expect, it } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { resolve, dirname } from "node:path";

const operations = await import("../../scripts/backup.mjs").catch(() => ({})) as any;
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
  it("rejects redirected/bind/unowned mounts", () => {
    expect(operations.assertOwnedVolume).toBeTypeOf("function");
    const mount = { Type: "volume", Name: "selected_storage", Destination: "/data/storage", RW: true };
    expect(() => operations.assertOwnedVolume(mount, { "com.docker.compose.project": "selected", "com.docker.compose.volume": "storage" }, "selected", "storage", "/data/storage")).not.toThrow();
    for (const bad of [{ ...mount, Type: "bind" }, { ...mount, Destination: "/other" }]) expect(() => operations.assertOwnedVolume(bad, {}, "selected", "storage", "/data/storage")).toThrow();
    expect(() => operations.assertOwnedVolume(mount, { "com.docker.compose.project": "other" }, "selected", "storage", "/data/storage")).toThrow();
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
