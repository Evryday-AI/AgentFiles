import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteStoredFile,
  getStorageUsage,
  openDownloadStream,
  saveUploadStream,
  stageUpload,
  finalizeUpload,
} from "../../src/server/storage";

let root = "";

describe("staged validation boundary", () => {
  it.each([9,10,11])("meters multiple chunks at exact cap: %i", async (size) => {
    root = await mkdtemp(join(tmpdir(), "agentfiles-"));
    const stage = stageUpload({storageRoot:root, originalName:"../hostile.PNG", maxBytes:10, stream:Readable.from([Buffer.alloc(4), Buffer.alloc(size-4)])});
    if(size > 10) {
      await expect(stage).rejects.toMatchObject({statusCode:413, code:"UPLOAD_TOO_LARGE"});
      expect(await getStorageUsage(root)).toEqual({bytes:0});
    } else {
      const staged = await stage;
      expect(staged.tempKey).toMatch(/^\.tmp\//);
      expect(staged.sizeBytes).toBe(size);
      const final = await finalizeUpload(root,staged);
      expect(final.storageKey).toMatch(/^files\/[a-f0-9-]{36}\.png$/);
      await expect(readFile(join(root,staged.tempKey))).rejects.toMatchObject({code:"ENOENT"});
    }
  });
  it.each([".", "./", "/", "C:/absolute", "safe/../safe.txt"])("rejects unsafe key %s", async key => {
    root = await mkdtemp(join(tmpdir(), "agentfiles-"));
    await expect(deleteStoredFile(root,key)).rejects.toThrow("Invalid storage key.");
  });
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("saveUploadStream", () => {
  it("streams upload content to a final storage key", async () => {
    root = await mkdtemp(join(tmpdir(), "agentfiles-"));
    const result = await saveUploadStream({
      storageRoot: root,
      code: "F-ABCDE",
      originalName: "hello.txt",
      stream: Readable.from(["hello"]),
    });

    await expect(readFile(join(root, result.storageKey), "utf8")).resolves.toBe("hello");
    expect(result.sizeBytes).toBe(5);
    expect(result.sha256).toHaveLength(64);
  });

  it("sanitizes original filename paths down to a safe extension", async () => {
    root = await mkdtemp(join(tmpdir(), "agentfiles-"));

    const result = await saveUploadStream({
      storageRoot: root,
      code: "F-SAFE1",
      originalName: "../avatar.PNG",
      stream: Readable.from(["image"]),
    });

    expect(result.storageKey).toMatch(/^files\/[a-f0-9-]{36}\.png$/);
  });

  it("uses opaque paths so a repeated code cannot select earlier bytes", async () => {
    root = await mkdtemp(join(tmpdir(), "agentfiles-"));
    const first = await saveUploadStream({ storageRoot: root, code: "F-ABCDE", originalName: "dupe.txt", stream: Readable.from(["first"]) });
    const second = await saveUploadStream({ storageRoot: root, code: "F-ABCDE", originalName: "dupe.txt", stream: Readable.from(["second"]) });
    expect(first.storageKey).not.toBe(second.storageKey);
    await expect(readFile(join(root, first.storageKey), "utf8")).resolves.toBe("first");
    await expect(readFile(join(root, second.storageKey), "utf8")).resolves.toBe("second");
  });
});

describe("stored file helpers", () => {
  it("opens, counts, and deletes stored file bytes", async () => {
    root = await mkdtemp(join(tmpdir(), "agentfiles-"));
    const saved = await saveUploadStream({
      storageRoot: root,
      code: "F-BYTES",
      originalName: "bytes.bin",
      stream: Readable.from([Buffer.from([1, 2, 3])]),
    });

    const stream = await openDownloadStream(root, saved.storageKey);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(Buffer.concat(chunks).toString("hex")).toBe("010203");
    await expect(getStorageUsage(root)).resolves.toEqual({ bytes: 3 });
    await deleteStoredFile(root, saved.storageKey);
    await expect(readFile(join(root, saved.storageKey))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects storage keys that escape the storage root", async () => {
    root = await mkdtemp(join(tmpdir(), "agentfiles-"));
    await writeFile(join(root, "safe.txt"), "safe");

    await expect(openDownloadStream(root, "../safe.txt")).rejects.toThrow("Invalid storage key.");
    await expect(deleteStoredFile(root, "../safe.txt")).rejects.toThrow("Invalid storage key.");
  });

  it("rejects empty storage keys before they can resolve to the storage root", async () => {
    root = await mkdtemp(join(tmpdir(), "agentfiles-"));

    await expect(openDownloadStream(root, "")).rejects.toThrow("Invalid storage key.");
    await expect(deleteStoredFile(root, "")).rejects.toThrow("Invalid storage key.");
  });
});
