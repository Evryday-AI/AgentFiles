import { existsSync, constants } from "node:fs";
import { access, lstat, open, readFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { registerAdminRoutes } from "./adminRoutes.js";
import { cleanupExpiredFiles, startCleanupExpiredFilesJob } from "./cleanup.js";
import { loadConfig, type AppConfig } from "./config.js";
import { registerFilesRoutes } from "./filesRoutes.js";
import { registerShareRoutes } from "./shareRoutes.js";
import { createDatabase, type Database } from "./db.js";
import { checkReadiness } from "./health.js";
import { EXPECTED_SCHEMA_VERSION } from "./migrate.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);

export function buildServer(config: AppConfig, deps: { db?: Database } = {}) {
  const db = deps.db ?? createDatabase(config.databaseUrl);
  const server = Fastify({
    logger: config.nodeEnv === "test" ? false : { serializers: { err: () => ({ type: "Error", message: "Request failed", stack: "" }) } },
    trustProxy: config.trustProxy,
  });

  server.get("/api/health", async () => ({
    ok: true,
    service: "agentfiles",
  }));

  server.get("/api/ready", async (_request, reply) => {
    const ready = await checkReadiness(db, EXPECTED_SCHEMA_VERSION);
    return reply.code(ready ? 200 : 503).send({ ready });
  });
  if (!deps.db) server.addHook("onClose", async () => { await db.close(); });

  void server.register(fastifyCookie, {
    secret: config.sessionSecret,
  });
  void server.register(fastifyRateLimit, {
    global: false,
  });
  void server.register(registerAdminRoutes, { config, db });
  void server.register(registerFilesRoutes, { config, db });
  void server.register(registerShareRoutes, { config, db });

  const cleanupIntervalMs = config.cleanupIntervalMs;
  if (config.nodeEnv !== "test" && cleanupIntervalMs > 0) {
    const cleanupJob = startCleanupExpiredFilesJob({
      intervalMs: cleanupIntervalMs,
      cleanup: async () => {
        const result = await cleanupExpiredFiles({ storageRoot: config.storageRoot, db });
        if (result.failed > 0) server.log.error({ failed: result.failed }, "Expired file byte cleanup failed");
        return result;
      },
      onError: () => server.log.error("Expired file cleanup failed"),
    });
    server.addHook("onClose", async () => {
      await cleanupJob.stop();
    });
  }

  const clientAssetsRoot = resolve(currentDir, "../../dist-client/assets");
  if (existsSync(clientAssetsRoot)) {
    void server.register(fastifyStatic, {
      root: clientAssetsRoot,
      prefix: "/assets/",
    });
  }

  function sendAppShell(reply: import("fastify").FastifyReply) {
    reply.type("text/html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AgentFiles</title>
    <link rel="stylesheet" href="/assets/style.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`);
  }

  server.get("/", async (_request, reply) => {
    sendAppShell(reply);
  });

  server.get<{ Params: { code: string } }>("/files/:code", async (_request, reply) => {
    sendAppShell(reply);
  });

  return server;
}

export const SHUTDOWN_TIMEOUT_MS = 10_000;

export async function validateStorageRoot(storageRoot: string): Promise<void> {
  let probe: string | undefined;
  try {
    const stats = await lstat(storageRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink() ||
        (process.getuid && (stats.uid !== process.getuid() || (stats.mode & 0o002) !== 0))) throw new Error();
    await access(storageRoot, constants.R_OK | constants.W_OK | constants.X_OK);
    const candidate = resolve(storageRoot, `.agentfiles-preflight-${randomBytes(16).toString("hex")}`);
    const handle = await open(candidate, "wx", 0o600);
    probe = candidate;
    try { await handle.writeFile("agentfiles storage probe"); await handle.sync(); }
    finally { await handle.close(); }
    if (await readFile(candidate, "utf8") !== "agentfiles storage probe") throw new Error();
    await unlink(candidate); probe = undefined;
  } catch {
    if (probe) await unlink(probe).catch(() => {});
    throw new Error("STORAGE_ROOT is not an owned writable directory");
  }
}

// One shared deadline covers cleanup/active transfers and database close.
export async function shutdownServer(
  server: Pick<import("fastify").FastifyInstance, "close">,
  db: Pick<Database, "close">,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Reserve the final second for DB close, before the signal wrapper hard exit.
  const serverDeadline = deadline - Math.min(1000, timeoutMs / 10);
  const bounded = async (operation: () => Promise<unknown>, operationDeadline: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation().then(() => true, () => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, operationDeadline - Date.now())); }),
      ]);
    } catch { return false; }
    finally { clearTimeout(timer); }
  };
  const drained = await bounded(() => server.close(), serverDeadline);
  const closed = await bounded(() => db.close(), deadline);
  return drained && closed;
}

export function registerShutdownSignals(
  server: Pick<import("fastify").FastifyInstance, "close">,
  db: Pick<Database, "close">,
  lifecycle: { once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown; exit(code: number): void } = process,
): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    let exited = false;
    const exit = (code: number) => {
      if (exited) return;
      exited = true;
      clearTimeout(forcedExit);
      lifecycle.exit(code);
    };
    // shutdownServer starts DB close before this hard deadline, including hangs.
    const forcedExit = setTimeout(() => exit(1), SHUTDOWN_TIMEOUT_MS);
    void shutdownServer(server, db).then(drained => exit(drained ? 0 : 1));
  };
  lifecycle.once("SIGINT", stop);
  lifecycle.once("SIGTERM", stop);
}

async function start() {
  const config = loadConfig();
  await validateStorageRoot(config.storageRoot);
  const db = createDatabase(config.databaseUrl);
  const server = buildServer(config, { db });
  registerShutdownSignals(server, db);
  const host = process.argv.includes("--host=0.0.0.0") ? "0.0.0.0" : "127.0.0.1";
  try { await server.listen({ host, port: config.port }); }
  catch { await shutdownServer(server, db); throw new Error("Server startup failed"); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch(() => {
    console.error("Server startup failed; check configuration and storage permissions.");
    process.exitCode = 1;
  });
}
