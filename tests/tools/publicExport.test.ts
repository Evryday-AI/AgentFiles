import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const scratch = resolve(".private/export-tests");
const scanner = resolve("scripts/check-public-export.mjs");
const owned: string[] = [];
async function fixture() {
  await mkdir(scratch, { recursive: true });
  expect(await realpath(scratch)).toBe(scratch);
  const root = await mkdtemp(resolve(scratch, "run-"));
  owned.push(root);
  return root;
}
async function put(root: string, name: string, value: string | Buffer) {
  const path = resolve(root, name), suffix = relative(root, path);
  expect(suffix.startsWith("..")).toBe(false);
  expect(isAbsolute(suffix)).toBe(false);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, value);
}
function scan(root: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [scanner, "--root", root, ...args], { encoding: "utf8", windowsHide: true });
  return { status: result.status, output: result.stdout + result.stderr };
}
afterEach(async () => {
  for (const root of owned.splice(0)) {
    const suffix = relative(scratch, root);
    expect(suffix && !suffix.startsWith("..") && !isAbsolute(suffix)).toBeTruthy();
    expect(await realpath(root)).toBe(root);
    await rm(root, { recursive: true });
  }
});

describe("public export guard", () => {
  it("allows reviewed text, license notices, reserved URLs and setup sentinels", async () => {
    const root = await fixture();
    await put(root, ".env.example", "SESSION_SECRET=GENERATE_WITH_SETUP\nDATABASE_URL='postgresql://agentfiles:GENERATE_WITH_SETUP@db:5432/agentfiles'\n");
    await put(root, "THIRD_PARTY_NOTICES.md", "MIT copyright notice\nhttps://example.com/demo\n");
    expect(scan(root).status).toBe(0);
  });
  it.each([".env", ".env.production", "nested/uploads/file.txt", ".private/notes.md", ".codebase-memory/graph.db", "node_modules/package/index.js", "dist/server.js", "artifacts/source.zip", "backups/database.dump", "test-results/trace.zip", "screenshot.png", ".cache/notes.txt", ".codex/memory.md", "private/provenance.txt", "media/portrait.svg"]) ("rejects forbidden artifact %s", async (name) => {
    const root = await fixture();
    await put(root, name, "synthetic forbidden artifact");
    const result = scan(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("forbidden-artifact");
  });
  it("rejects binary bytes even when disguised as text", async () => {
    const root = await fixture();
    await put(root, "source.txt", Buffer.from([255, 0, 17]));
    const result = scan(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("binary-artifact");
  });
  it.each([
    Buffer.from([1, 2, 3]),
    Buffer.from([8, 11, 12, 27, 31, 127]),
    Buffer.from(String.fromCharCode(0x85, 0x9f), "utf8"),
  ])("rejects NUL-free UTF-8 non-text controls without exposing content", async (controls) => {
    const root = await fixture();
    const body = "synthetic-binary-body";
    await put(root, "payload.bin", Buffer.concat([Buffer.from(body), controls]));
    const result = scan(root);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.output).findings).toEqual([
      { category: "binary-artifact", count: 1, path: "payload.bin" },
    ]);
    expect(result.output).not.toContain(body);
  });
  it("preserves normal UTF-8 text with tab, LF and CR whitespace", async () => {
    const root = await fixture();
    await put(root, "source.txt", "café ελληνικά 中文 😀\tindent\nLF\r\nCRLF\ronly CR\n");
    const result = scan(root);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output).findings).toEqual([]);
  });
  it("rejects credential patterns without revealing matched values", async () => {
    const root = await fixture();
    const secret = "af_" + "a".repeat(24) + "_" + "b".repeat(64);
    await put(root, "config.txt", "token=" + secret);
    const result = scan(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("credential");
    expect(result.output).not.toContain(secret);
  });
  it("rejects private password hashes without revealing salt or hash", async () => {
    const root = await fixture();
    const value = "$" + "argon2id$v=19$m=65536,t=3,p=4$" + "A".repeat(22) + "$" + "B".repeat(43);
    await put(root, "config.txt", value);
    const result = scan(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("credential");
    expect(result.output).not.toContain(value);
  });
  it("rejects credentials in filenames and redacts the reported relative path", async () => {
    const root = await fixture();
    const value = "af_" + "c".repeat(24) + "_" + "d".repeat(64);
    await put(root, value + ".txt", "safe synthetic text");
    const result = scan(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("credential");
    expect(result.output).toContain("[redacted].txt");
    expect(result.output).not.toContain(value);
  });
  it.each(["C:" + "\\Users\\synthetic\\project", "/" + "home/synthetic/project", "C:" + "\\dev\\private-project"]) ("rejects absolute private source paths without echoing content", async (value) => {
    const root = await fixture();
    await put(root, "notes.md", value);
    const result = scan(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("private-path");
    expect(result.output).not.toContain(value);
  });
  it("accepts optional literal identifier rules outside the export and redacts filenames", async () => {
    const root = await fixture(), rules = await fixture();
    const value = "synthetic-private-identifier";
    await put(rules, "patterns.json", JSON.stringify([{ category: "owner", value }]));
    await put(root, value + ".txt", value);
    const result = scan(root, ["--private-patterns", resolve(rules, "patterns.json")]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("private-identifier");
    expect(result.output).not.toContain(value);
  });
  it("does not follow a directory junction outside the export", async () => {
    const root = await fixture(), outside = await fixture();
    await put(outside, "safe.txt", "synthetic outside data");
    await symlink(outside, resolve(root, "link"), process.platform === "win32" ? "junction" : "dir");
    const result = scan(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("redirected-path");
    expect(await readFile(resolve(outside, "safe.txt"), "utf8")).toBe("synthetic outside data");
  });
  it("refuses an export root that redirects outside the explicitly resolved directory", async () => {
    const owner = await fixture(), outside = await fixture();
    await symlink(outside, resolve(owner, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(scan(resolve(owner, "link")).status).toBe(1);
  });
  it("scans tracked files only, including staged additions, and ignores untracked fixtures", async () => {
    const root = await fixture();
    const git = (args: string[]) => expect(spawnSync("git", args, { cwd: root, windowsHide: true }).status).toBe(0);
    git(["init", "--quiet"]);
    await put(root, "README.md", "safe public source");
    git(["add", "README.md"]);
    await put(root, ".env", "ignored runtime data");
    expect(scan(root, ["--tracked"]).status).toBe(0);
    git(["add", ".env"]);
    expect(scan(root, ["--tracked"]).status).toBe(1);
  });
  it("fails closed for invalid options, missing roots and invalid identifier input", async () => {
    const root = await fixture();
    expect(scan(root, ["--unknown"]).status).toBe(1);
    expect(scan(resolve(root, "absent")).status).toBe(1);
    await put(root, "patterns.json", "{}");
    expect(scan(root, ["--private-patterns", resolve(root, "patterns.json")]).status).toBe(1);
  });
});
