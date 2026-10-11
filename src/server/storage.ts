import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface SaveUploadInput {
  storageRoot: string;
  code?: string;
  originalName: string;
  stream: NodeJS.ReadableStream;
}

export interface SavedUpload {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}

export const MULTIPART_IDLE_TIMEOUT_MS = 30_000;

export async function saveUploadStream(
  input: SaveUploadInput,
): Promise<SavedUpload> {
  const root = resolve(input.storageRoot);
  // Placement is independent of the finite human-code namespace. Neither an
  // uploaded filename nor a retried code candidate chooses existing byte paths.
  const safeCode = randomBytes(16).toString("hex");
  const extension = sanitizeExtension(input.originalName);
  const storageKey = `${safeCode}/${safeCode}${extension}`;
  const finalPath = storagePath(root, storageKey);
  const tmpKey = `.tmp/${safeCode}-${randomBytes(16).toString("hex")}.upload`;
  const tmpPath = storagePath(root, tmpKey);

  await mkdir(join(root, ".tmp"), { recursive: true });
  await mkdir(join(root, safeCode), { recursive: true });

  const hash = createHash("sha256");
  let sizeBytes = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () =>
        (input.stream as Readable).destroy(new Error("Upload idle timeout")),
      MULTIPART_IDLE_TIMEOUT_MS,
    );
    idleTimer.unref();
  };
  const meter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      resetIdleTimer();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += buffer.byteLength;
      hash.update(buffer);
      callback(null, buffer);
    },
  });

  try {
    resetIdleTimer();
    await pipeline(
      input.stream,
      meter,
      createWriteStream(tmpPath, { flags: "wx" }),
    );
    await link(tmpPath, finalPath);
    await rm(tmpPath, { force: true });
  } catch (error) {
    await rm(tmpPath, { force: true });
    await rmdir(dirname(finalPath)).catch(() => {});
    throw error;
  } finally {
    clearTimeout(idleTimer);
  }

  return {
    storageKey,
    sizeBytes,
    sha256: hash.digest("hex"),
  };
}

export async function openDownloadStream(
  storageRoot: string,
  storageKey: string,
): Promise<NodeJS.ReadableStream> {
  const filePath = storagePath(resolve(storageRoot), storageKey);
  await stat(filePath);
  return createReadStream(filePath);
}

export async function deleteStoredFile(
  storageRoot: string,
  storageKey: string,
): Promise<void> {
  const root = resolve(storageRoot);
  const path = storagePath(root, storageKey);
  await rm(path, { force: true });
  if (dirname(path) !== root) {
    try {
      await rmdir(dirname(path));
    } catch (error) {
      if (
        !isNodeError(error) ||
        !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")
      )
        throw error;
    }
  }
}

export async function getStorageUsage(
  storageRoot: string,
): Promise<{ bytes: number }> {
  return { bytes: await countBytes(resolve(storageRoot)) };
}

function sanitizeExtension(originalName: string): string {
  const extension = extname(basename(originalName)).toLowerCase();
  const safeExtension = extension.replace(/[^.a-z0-9]/g, "");
  return safeExtension.length > 1 && safeExtension.length <= 16
    ? safeExtension
    : "";
}

function storagePath(storageRoot: string, storageKey: string): string {
  if (storageKey.trim() === "") {
    throw new Error("Invalid storage key.");
  }
  const target = resolve(storageRoot, storageKey);
  if (target !== storageRoot && !target.startsWith(`${storageRoot}${sep}`)) {
    throw new Error("Invalid storage key.");
  }
  return target;
}

async function countBytes(directory: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await countBytes(entryPath);
    } else if (entry.isFile()) {
      total += (await stat(entryPath)).size;
    }
  }
  return total;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
