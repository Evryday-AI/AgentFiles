import { isIP } from "node:net";
import { parsePublicOrigin, type DeploymentMode } from "./originPolicy.js";

export type AppConfig = ReturnType<typeof loadConfig>;

// Never put supplied values in errors: they may contain credentials.
function invalid(name: string): never { throw new Error(`${name} is invalid`); }

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name];
  if (!value || !value.trim() || value === "GENERATE_WITH_SETUP") invalid(name);
  return value;
}

function integer(source: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = source[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) invalid(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(name);
  return value;
}

function enumValue<T extends string>(source: NodeJS.ProcessEnv, name: string, allowed: readonly T[], fallback: T): T {
  const value = source[name] ?? fallback;
  if (!allowed.includes(value as T)) invalid(name);
  return value as T;
}

function safeBase64(value: string, encoding: "base64" | "base64url", minimumBytes: number): boolean {
  const pattern = encoding === "base64" ? /^[A-Za-z0-9+/]+={0,2}$/ : /^[A-Za-z0-9_-]+={0,2}$/;
  if (!pattern.test(value)) return false;
  const bytes = Buffer.from(value, encoding);
  const canonical = bytes.toString(encoding);
  return bytes.length >= minimumBytes && (value === canonical || value === canonical.replace(/=+$/, ""));
}

function sessionSecret(source: NodeJS.ProcessEnv): string {
  const value = required(source, "SESSION_SECRET");
  const hex = /^[a-fA-F0-9]+$/.test(value) && value.length % 2 === 0 && value.length >= 64;
  if (!hex && !safeBase64(value, "base64", 32) && !safeBase64(value, "base64url", 32)) invalid("SESSION_SECRET");
  return value;
}

function adminPasswordHash(source: NodeJS.ProcessEnv): string {
  const value = required(source, "ADMIN_PASSWORD_HASH");
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(value);
  if (!match) invalid("ADMIN_PASSWORD_HASH");
  const [memory, iterations, parallelism] = match.slice(1, 4).map(Number);
  // Argon2 uses uint32 memory/time costs and a 24-bit maximum lane count.
  // Larger safe JS integers can wrap at the native boundary and make login unusable.
  if (![memory, iterations, parallelism].every((n) => Number.isSafeInteger(n) && n > 0) ||
      memory > 2 ** 32 - 1 || iterations > 2 ** 32 - 1 || parallelism > 2 ** 24 - 1 || memory < 8 * parallelism ||
      !safeBase64(match[4], "base64", 8) || !safeBase64(match[5], "base64", 16)) invalid("ADMIN_PASSWORD_HASH");
  return value;
}

export function validatedDatabaseUrl(source: NodeJS.ProcessEnv): string {
  const value = required(source, "DATABASE_URL");
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || url.hash) invalid("DATABASE_URL");
  } catch { invalid("DATABASE_URL"); }
  return value;
}

function proxyAddresses(source: NodeJS.ProcessEnv, mode: DeploymentMode): false | string[] {
  const value = source.TRUST_PROXY;
  if (value === undefined || value === "") return false;
  if (mode === "local") invalid("TRUST_PROXY");
  const addresses = value.split(",").map((address) => address.trim());
  for (const address of addresses) {
    const parts = address.split("/");
    const family = isIP(parts[0]);
    if (!family || parts.length > 2) invalid("TRUST_PROXY");
    if (parts.length === 2 && (!/^\d+$/.test(parts[1]) || Number(parts[1]) > (family === 4 ? 32 : 128))) invalid("TRUST_PROXY");
    // A default route grants trust to every address.
    if (parts[1] !== undefined && Number(parts[1]) === 0) invalid("TRUST_PROXY");
  }
  return addresses;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env) {
  const nodeEnv = enumValue(source, "NODE_ENV", ["development", "test", "production"] as const, "development");
  const deploymentMode = enumValue(source, "DEPLOYMENT_MODE", ["local", "public"] as const, "local");
  const maxUploadBytes = integer(source, "MAX_UPLOAD_BYTES", 1073741824, 1);
  const maxStorageBytes = integer(source, "MAX_STORAGE_BYTES", 10737418240, 1);
  if (maxStorageBytes < maxUploadBytes) invalid("MAX_STORAGE_BYTES");
  const cleanupSeconds = integer(source, "CLEANUP_INTERVAL_SECONDS", 3600, 1, 86400);
  const orphanSeconds = integer(source, "ORPHAN_GRACE_SECONDS", 86400, 600, Math.floor(Number.MAX_SAFE_INTEGER / 1000));
  if (orphanSeconds < cleanupSeconds * 2) invalid("ORPHAN_GRACE_SECONDS");
  const persistence = source.ALLOW_PERSISTENT_FILES ?? "false";
  if (persistence !== "true" && persistence !== "false") invalid("ALLOW_PERSISTENT_FILES");
  const adminUsername = source.ADMIN_USERNAME ?? "admin";
  if (!adminUsername.trim() || adminUsername.length > 128) invalid("ADMIN_USERNAME");
  return {
    nodeEnv, deploymentMode,
    port: integer(source, "PORT", 3000, 1, 65535),
    databaseUrl: validatedDatabaseUrl(source),
    storageRoot: required(source, "STORAGE_ROOT"),
    sessionSecret: sessionSecret(source),
    adminUsername,
    adminPasswordHash: adminPasswordHash(source),
    publicBaseUrl: parsePublicOrigin(source.PUBLIC_BASE_URL ?? "http://localhost:3000", deploymentMode),
    trustProxy: proxyAddresses(source, deploymentMode),
    retentionDays: integer(source, "RETENTION_DAYS", 7, 1, 3650),
    allowPersistentFiles: persistence === "true",
    issuanceEnabled: enumValue(source, "FILE_ISSUANCE_ENABLED", ["true", "false"] as const, "true") === "true",
    maxUploadBytes, maxStorageBytes,
    minFreeDiskBytes: integer(source, "MIN_FREE_DISK_BYTES", 1073741824, 0),
    maxConcurrentUploads: integer(source, "MAX_CONCURRENT_UPLOADS", 4, 1, 64),
    cleanupIntervalMs: cleanupSeconds * 1000,
    orphanGraceMs: orphanSeconds * 1000,
    cleanupBatchSize: integer(source, "CLEANUP_BATCH_SIZE", 100, 1, 500),
    metadataRetentionDays: integer(source, "METADATA_RETENTION_DAYS", 30, 1, 3650),
    eventRetentionDays: integer(source, "EVENT_RETENTION_DAYS", 30, 1, 3650),
  };
}

export function cookieIsSecure(config: Pick<AppConfig, "deploymentMode">): boolean {
  return config.deploymentMode === "public";
}
