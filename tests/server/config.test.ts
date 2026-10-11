import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, argon2id } from "argon2";
import { beforeAll, describe, expect, it } from "vitest";
import { cookieIsSecure, loadConfig } from "../../src/server/config";

let passwordHash: string;
beforeAll(async () => { passwordHash = await hash("synthetic-config-password", { type: argon2id }); });
function validTestEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://fixture:fixture@localhost:5432/agentfiles_test",
    STORAGE_ROOT: join(tmpdir(), "agentfiles-config-fixture"),
    SESSION_SECRET: randomBytes(32).toString("hex"),
    ADMIN_PASSWORD_HASH: passwordHash,
    ADMIN_USERNAME: "admin",
  };
}

describe("loadConfig", () => {
  it("allows production optimizations with local HTTP only", () => {
    const cfg = loadConfig({ ...validTestEnv(), NODE_ENV: "production", DEPLOYMENT_MODE: "local" });
    expect(cfg).toMatchObject({ nodeEnv: "production", deploymentMode: "local", publicBaseUrl: "http://localhost:3000", trustProxy: false });
  });
  it("provides documented defaults in application units", () => {
    expect(loadConfig({ ...validTestEnv(), ADMIN_USERNAME: undefined })).toMatchObject({
      nodeEnv: "development", port: 3000, adminUsername: "admin", retentionDays: 7,
      allowPersistentFiles: false, maxUploadBytes: 1073741824, maxStorageBytes: 10737418240,
      minFreeDiskBytes: 1073741824, maxConcurrentUploads: 4, cleanupIntervalMs: 3600000,
      orphanGraceMs: 86400000, cleanupBatchSize: 100, metadataRetentionDays: 30, eventRetentionDays: 30,
    });
  });
  it("does not coerce a false string into enabled persistence", () => {
    expect(loadConfig({ ...validTestEnv(), ALLOW_PERSISTENT_FILES: "false" })).toMatchObject({ allowPersistentFiles: false });
    expect(loadConfig({ ...validTestEnv(), ALLOW_PERSISTENT_FILES: "true" })).toMatchObject({ allowPersistentFiles: true });
  });
  it.each(["1", "FALSE", "", "yes"])("rejects nonliteral booleans: %s", (value) => {
    expect(() => loadConfig({ ...validTestEnv(), ALLOW_PERSISTENT_FILES: value })).toThrow(/ALLOW_PERSISTENT_FILES/);
  });
  it("canonicalizes the origin and allows an explicit reviewed proxy list", () => {
    expect(loadConfig({ ...validTestEnv(), DEPLOYMENT_MODE: "public", PUBLIC_BASE_URL: "https://FILES.example:443/", TRUST_PROXY: "127.0.0.1, ::1/128,192.0.2.0/24" })).toMatchObject({ publicBaseUrl: "https://files.example", trustProxy: ["127.0.0.1", "::1/128", "192.0.2.0/24"] });
  });
  it.each(["http://files.example", "https://files.example", "http://192.168.1.2"])("rejects external local origins: %s", (origin) => {
    expect(() => loadConfig({ ...validTestEnv(), PUBLIC_BASE_URL: origin })).toThrow(/PUBLIC_BASE_URL/);
  });
  it.each(["http://files.example", "https://localhost", "https://127.0.0.1", "https://127.0.0.2", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://files.example/path", "https://user:pass@files.example", "https://files.example?x=1", "https://files.example#section"])("rejects unsafe public origin: %s", (origin) => {
    expect(() => loadConfig({ ...validTestEnv(), DEPLOYMENT_MODE: "public", PUBLIC_BASE_URL: origin })).toThrow(/PUBLIC_BASE_URL/);
  });
  it("rejects any local proxy trust", () => {
    expect(() => loadConfig({ ...validTestEnv(), TRUST_PROXY: "127.0.0.1" })).toThrow(/TRUST_PROXY/);
  });
  it.each(["true", "false", "1", "loopback", "files.example", "192.0.2.1/33", "::1/129", "192.0.2.1,"])("rejects unreviewable proxy setting: %s", (value) => {
    expect(() => loadConfig({ ...validTestEnv(), DEPLOYMENT_MODE: "public", PUBLIC_BASE_URL: "https://files.example", TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
  });
  it.each(["NaN", "Infinity", "-1", "1.5", "9007199254740992", "", "0x10", "1e3", " 3000 "])("rejects malformed numeric input: %s", (value) => {
    expect(() => loadConfig({ ...validTestEnv(), PORT: value })).toThrow(/PORT/);
  });
  it.each([
    ["PORT", "65536"], ["RETENTION_DAYS", "3651"], ["MAX_UPLOAD_BYTES", "0"],
    ["MAX_STORAGE_BYTES", "1"], ["MIN_FREE_DISK_BYTES", "-1"], ["MAX_CONCURRENT_UPLOADS", "65"],
    ["CLEANUP_INTERVAL_SECONDS", "86401"], ["ORPHAN_GRACE_SECONDS", "599"],
    ["ORPHAN_GRACE_SECONDS", "7199"], ["CLEANUP_BATCH_SIZE", "501"],
    ["METADATA_RETENTION_DAYS", "0"], ["EVENT_RETENTION_DAYS", "0"],
  ])("rejects numeric constraints on %s", (name, value) => {
    expect(() => loadConfig({ ...validTestEnv(), [name]: value })).toThrow(new RegExp(name));
  });
  it("accepts explicit boundaries and converts seconds once", () => {
    expect(loadConfig({ ...validTestEnv(), PORT: "65535", RETENTION_DAYS: "3650", MAX_UPLOAD_BYTES: "1", MAX_STORAGE_BYTES: "1", MIN_FREE_DISK_BYTES: "0", MAX_CONCURRENT_UPLOADS: "64", CLEANUP_INTERVAL_SECONDS: "300", ORPHAN_GRACE_SECONDS: "600", CLEANUP_BATCH_SIZE: "500" })).toMatchObject({ cleanupIntervalMs: 300000, orphanGraceMs: 600000, minFreeDiskBytes: 0 });
  });
  it.each(["GENERATE_WITH_SETUP", "short", "s".repeat(32)])("rejects weak or placeholder secrets", (secret) => {
    expect(() => loadConfig({ ...validTestEnv(), SESSION_SECRET: secret })).toThrow(/SESSION_SECRET/);
  });
  it.each(["GENERATE_WITH_SETUP", "invalid", "$argon2id$v=19$m=65536,t=3,p=4$abc$def", "$argon2i$v=19$m=65536,t=3,p=4$abc$def"])("rejects invalid hashes", (hashValue) => {
    expect(() => loadConfig({ ...validTestEnv(), ADMIN_PASSWORD_HASH: hashValue })).toThrow(/ADMIN_PASSWORD_HASH/);
  });
  it.each(["NODE_ENV", "DEPLOYMENT_MODE"])("rejects unknown enum values for %s", (name) => {
    expect(() => loadConfig({ ...validTestEnv(), [name]: "unknown" })).toThrow(new RegExp(name));
  });
  it.each(["", "a".repeat(129)])("rejects invalid administrator names", (value) => {
    expect(() => loadConfig({ ...validTestEnv(), ADMIN_USERNAME: value })).toThrow(/ADMIN_USERNAME/);
  });
  it.each(["https://user:credential@database.example/db", "postgres://", "postgres://localhost", "not-a-url"])("rejects invalid database URLs without exposing values", (value) => {
    try { loadConfig({ ...validTestEnv(), DATABASE_URL: value }); throw new Error("unexpected acceptance"); }
    catch (error) { expect(String(error)).toContain("DATABASE_URL"); expect(String(error)).not.toContain(value); }
  });
  it("requires storage and database configuration", () => {
    expect(() => loadConfig({ ...validTestEnv(), STORAGE_ROOT: "" })).toThrow(/STORAGE_ROOT/);
    expect(() => loadConfig({ ...validTestEnv(), DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });
  it.each(["hex", "base64", "base64url"] as const)("accepts random 32-byte %s secrets", (encoding) => {
    const secret = randomBytes(32).toString(encoding);
    expect(loadConfig({ ...validTestEnv(), SESSION_SECRET: secret }).sessionSecret).toBe(secret);
  });
  it("sets cookie security independently of optimization mode", () => {
    expect(cookieIsSecure(loadConfig({ ...validTestEnv(), NODE_ENV: "production" }))).toBe(false);
    expect(cookieIsSecure(loadConfig({ ...validTestEnv(), DEPLOYMENT_MODE: "public", PUBLIC_BASE_URL: "https://files.example" }))).toBe(true);
  });
});
