import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  mkdir,
  readdir,
  lstat,
  realpath,
  open,
  unlink,
  statfs,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
  sep,
  win32,
} from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FilePolicyError } from "./filePolicy.js";

export interface SaveUploadInput {
  storageRoot: string;
  code?: string;
  originalName: string;
  stream: NodeJS.ReadableStream;
  onKey?: (key: string) => void;
  checkpoint?: () => Promise<void>;
  idleTimeoutMs?: number;
  protectKey?: (key: string) => () => void;
}
export interface SavedUpload {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}
export interface StagedUpload {
  tempKey: string;
  sizeBytes: number;
  sha256: string;
  extension: string;
}
export const MULTIPART_IDLE_TIMEOUT_MS = 30_000;
function invalid(): never {
  throw new Error("Invalid storage key.");
}
export function storagePath(storageRoot: string, key: string): string {
  const root = resolve(storageRoot);
  if (
    !key.trim() ||
    isAbsolute(key) ||
    win32.isAbsolute(key) ||
    key.includes(":") ||
    key.includes("\0") ||
    key.split(/[\\/]/).some((p) => !p || p === "." || p === "..")
  )
    invalid();
  const path = resolve(root, key);
  if (path === root || !path.startsWith(root + sep)) invalid();
  return path;
}
// The exclusively app-owned mount prevents ancestor swaps by external writers.
async function safePath(
  rootInput: string,
  key: string,
  allowMissing = false,
): Promise<string> {
  const root = resolve(rootInput),
    target = storagePath(root, key);
  await safeRoot(root);
  const canonicalRoot = await realpath(root);
  let current = root;
  const parts = target.slice(root.length + 1).split(sep);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissing && nodeCode(error) === "ENOENT") return target;
      throw error;
    }
    if (info.isSymbolicLink()) invalid();
    const canonical = await realpath(current);
    if (!canonical.startsWith(canonicalRoot + sep)) invalid();
    if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())
      invalid();
  }
  return target;
}
const rootIdentities = new Map<string, string>();
export async function verifyStorageRoot(root: string) {
  await safeRoot(root);
}
async function safeRoot(root: string) {
  for (let current = resolve(root); ; current = dirname(current)) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
    const canonical = await realpath(current);
    const normalize = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    if (normalize(canonical) !== normalize(current)) invalid();
    if (current === resolve(root)) {
      const identity = `${info.dev}:${info.ino}`;
      const prior = rootIdentities.get(current);
      if (prior !== undefined && prior !== identity)
        throw new Error("Storage mount identity changed");
      rootIdentities.set(current, identity);
    }
    if (dirname(current) === current) break;
  }
}
async function ownedDirectory(root: string, key: string) {
  await safePath(root, key + "/probe", true);
  await mkdir(storagePath(root, key), { mode: 0o700 }).catch((error) => {
    if (nodeCode(error) !== "EEXIST") throw error;
  });
  await safePath(root, key + "/probe", true);
}
export async function stageUpload(
  input: SaveUploadInput & { maxBytes: number },
): Promise<StagedUpload> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1)
    throw new Error("Invalid upload limit");
  if ((input.stream as Readable).destroyed)
    throw new FilePolicyError(400, "Upload interrupted", "INVALID_INPUT");
  const root = resolve(input.storageRoot);
  await ownedDirectory(root, ".tmp");
  const tempKey = `.tmp/${randomUUID()}.upload`,
    tempPath = await safePath(root, tempKey, true);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectIdle!: (error: Error) => void;
  const idle = new Promise<never>((_resolve, reject) => {
    rejectIdle = reject;
  });
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const error = new FilePolicyError(
        408,
        "Upload idle timeout",
        "UPLOAD_IDLE_TIMEOUT",
      );
      (input.stream as Readable).destroy(error);
      rejectIdle(error);
    }, input.idleTimeoutMs ?? MULTIPART_IDLE_TIMEOUT_MS);
    idleTimer.unref();
  };
  const meter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      resetIdle();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (sizeBytes + bytes.length > input.maxBytes) {
        callback(
          new FilePolicyError(
            413,
            "Upload exceeds configured limit",
            "UPLOAD_TOO_LARGE",
          ),
        );
        return;
      }
      sizeBytes += bytes.length;
      hash.update(bytes);
      Promise.resolve()
        .then(() => input.checkpoint?.())
        .then(() => callback(null, bytes), callback);
    },
  });
  const releaseProspective = input.protectKey?.(tempKey);
  const handle = await open(
    tempPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  ).catch((error) => {
    releaseProspective?.();
    throw error;
  });
  input.onKey?.(tempKey);
  releaseProspective?.();
  const output = handle.createWriteStream();
  try {
    if ((input.stream as Readable).destroyed)
      throw new FilePolicyError(400, "Upload interrupted", "INVALID_INPUT");
    resetIdle();
    await Promise.race([pipeline(input.stream, meter, output), idle]);
  } catch (error) {
    output.destroy();
    meter.destroy();
    await handle.close().catch(() => {});
    await discardUpload(root, tempKey).catch(() => {});
    throw error;
  } finally {
    clearTimeout(idleTimer);
    await handle.close().catch(() => {});
  }
  return {
    tempKey,
    sizeBytes,
    sha256: hash.digest("hex"),
    extension: sanitizeExtension(input.originalName),
  };
}
export async function finalizeUpload(
  root: string,
  staged: StagedUpload,
  onKey?: (key: string) => void,
  protectKey?: (key: string) => () => void,
): Promise<SavedUpload> {
  if (
    !/^\.tmp\/[a-f0-9-]{36}\.upload$/.test(staged.tempKey) ||
    !/^(?:\.[a-z0-9]{1,15})?$/.test(staged.extension)
  )
    invalid();
  const temp = await safePath(root, staged.tempKey);
  await ownedDirectory(root, "files");
  const storageKey = `files/${randomUUID()}${staged.extension}`,
    final = await safePath(root, storageKey, true);
  // EEXIST never grants ownership of a conflicting earlier path.
  const releaseProspective = protectKey?.(storageKey);
  try {
    await link(temp, final);
    onKey?.(storageKey);
  } finally {
    releaseProspective?.();
  }
  await discardUpload(root, staged.tempKey);
  return { storageKey, sizeBytes: staged.sizeBytes, sha256: staged.sha256 };
}
// Internal callers supply a complete stream. HTTP multipart uses stage/finalize.
export async function saveUploadStream(
  input: SaveUploadInput,
): Promise<SavedUpload> {
  const staged = await stageUpload({ ...input, maxBytes: 1073741824 });
  let finalKey: string | undefined;
  try {
    return await finalizeUpload(input.storageRoot, staged, (key) => {
      finalKey = key;
      input.onKey?.(key);
    });
  } catch (error) {
    await discardUpload(input.storageRoot, staged.tempKey).catch(() => {});
    if (finalKey)
      await discardUpload(input.storageRoot, finalKey).catch(() => {});
    throw error;
  }
}
export async function openDownloadStream(
  root: string,
  key: string,
): Promise<NodeJS.ReadableStream> {
  const path = await safePath(root, key),
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) invalid();
    return handle.createReadStream();
  } catch (error) {
    await handle.close();
    throw error;
  }
}
export async function discardUpload(root: string, key: string): Promise<void> {
  await safeRoot(root);
  let path;
  try {
    path = await safePath(root, key);
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return;
    throw error;
  }
  await unlink(path).catch((error) => {
    if (nodeCode(error) !== "ENOENT") throw error;
  });
}
export const deleteStoredFile = discardUpload;
export async function storedFileBytes(
  root: string,
  key: string,
): Promise<number> {
  await safeRoot(root);
  try {
    return (await lstat(await safePath(root, key))).size;
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return 0;
    throw error;
  }
}
export async function getStorageUsage(
  rootInput: string,
): Promise<{ bytes: number }> {
  const root = resolve(rootInput);
  await safeRoot(root);
  const counted = new Set<string>();
  async function count(directory: string): Promise<number> {
    let total = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name),
        info = await lstat(path);
      if (info.isSymbolicLink()) invalid();
      if (info.isDirectory()) {
        await safePath(
          root,
          path
            .slice(root.length + 1)
            .split(sep)
            .join("/") + "/probe",
          true,
        );
        total += await count(path);
      } else if (info.isFile()) {
        if (directory === root && entry.name === ".agentfiles-volume") continue;
        const identity = `${info.dev}:${info.ino}`;
        if (!counted.has(identity)) {
          total += info.size;
          counted.add(identity);
        }
      } else invalid();
      if (!Number.isSafeInteger(total))
        throw new Error("Storage measurement failed");
    }
    return total;
  }
  return { bytes: await count(root) };
}
export async function getFreeDiskBytes(root: string): Promise<number> {
  await safeRoot(root);
  const stats = await statfs(root, { bigint: true });
  return Number(stats.bavail * stats.bsize);
}
function sanitizeExtension(name: string) {
  const extension = extname(basename(name.replaceAll("\\", "/"))).toLowerCase();
  return /^\.[a-z0-9]{1,15}$/.test(extension) ? extension : "";
}
function nodeCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}
