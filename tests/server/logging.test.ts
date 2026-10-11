import { Writable } from "node:stream";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/server/index";
import { safeLoggerOptions } from "../../src/server/logging";
import Fastify from "fastify";
import { testConfig } from "../helpers/config";
const sentinels = [
  "SHARE_TOKEN_SENTINEL",
  "AUTH_SECRET_SENTINEL",
  "COOKIE_SECRET_SENTINEL",
  "PASSWORD_SECRET_SENTINEL",
  "STORAGE_PATH_SENTINEL",
  "DB_CONNECTION_SENTINEL",
  "HASH_SECRET_SENTINEL",
];
describe("actual Pino JSON logging", () => {
  it("captures successful public download and failed auth/storage without credential/path sentinels", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "agentfiles-logging-"));
    const filePath = join(storageRoot, "synthetic");
    await writeFile(filePath, "synthetic download");
    let logs = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs += chunk.toString();
        callback();
      },
    });
    const at = new Date();
    const row = {
      id: "synthetic",
      file_id: "synthetic",
      file_code: "F-ABCDE",
      token_hash: sentinels[6],
      expires_at: new Date(at.getTime() + 60000),
      max_downloads: null,
      download_count: 1,
      created_by_type: "admin",
      created_by_name: "synthetic",
      created_at: at,
      revoked_at: null,
      download_file_id: "synthetic",
      download_file_code: "F-ABCDE",
      download_original_name: sentinels[4],
      download_storage_key: "synthetic",
      download_mime_type: "text/plain",
      download_size_bytes: 18,
      download_uploaded_by_type: "admin",
      download_uploaded_by_name: "synthetic",
      download_created_at: at,
      download_updated_at: at,
      download_expires_at: new Date(at.getTime() + 60000),
      download_is_durable: false,
      download_deleted_at: null,
      download_deleted_reason: null,
      download_lifecycle_state: "active",
      download_sha256: null,
      download_thumbnail_key: null,
      download_metadata: { secret: sentinels[6] },
    };
    let fail = false;
    const db = {
      query: async <T>() => ({
        rows: [
          {
            ...row,
            download_storage_key: fail
              ? sentinels[4]
              : row.download_storage_key,
          },
        ] as T[],
        rowCount: 1,
      }),
      withClient: async () => {
        throw new Error(sentinels[5]);
      },
      close: async () => {},
    };
    const server = buildServer(testConfig({ storageRoot }), {
      db,
      loggerStream: stream,
    });
    try {
      const r = await server.inject({
        url: `/s/${sentinels[0]}?password=${sentinels[3]}`,
        headers: {
          authorization: `Bearer ${sentinels[1]}`,
          cookie: sentinels[2],
        },
      });
      expect(r.statusCode).toBe(200);
      expect(r.body).toBe("synthetic download");
      expect(
        (
          await server.inject({
            url: "/api/files/F-ABCDE",
            headers: {
              authorization: `Bearer ${sentinels[1]}`,
              cookie: sentinels[2],
            },
          })
        ).statusCode,
      ).toBe(401);
      fail = true;
      expect((await server.inject(`/s/${sentinels[0]}`)).statusCode).toBe(500);
      const entries = logs
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries.length).toBeGreaterThan(3);
      expect(entries.some((x) => x.req?.url === "/s/:token")).toBe(true);
      expect(entries.some((x) => x.err?.message === "Request failed")).toBe(
        true,
      );
      for (const secret of sentinels) expect(logs).not.toContain(secret);
      expect(logs).not.toContain(storageRoot);
    } finally {
      await server.close();
      await rm(storageRoot, { recursive: true });
    }
  });
  it("serializes arbitrary error properties and redacts explicit secret fields", async () => {
    let logs = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs += chunk.toString();
        callback();
      },
    });
    const server = Fastify({ logger: { ...safeLoggerOptions, stream } });
    server.log.error(
      {
        err: Object.assign(new Error(sentinels[5]), {
          password: sentinels[3],
          path: sentinels[4],
        }),
        error: new Error(sentinels[6]),
        authorization: sentinels[1],
        cookie: sentinels[2],
        secret: sentinels[0],
        password: sentinels[3],
        session_hash: sentinels[6],
        key_hash: sentinels[6],
        body: { secret: sentinels[0] },
      },
      "synthetic failure",
    );
    await server.close();
    expect(logs).toContain("REDACTED");
    for (const secret of sentinels) expect(logs).not.toContain(secret);
  });
});
