import { existsSync } from "node:fs";
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

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);

export function buildServer(config: AppConfig = loadConfig()) {
  const server = Fastify({
    logger: config.nodeEnv !== "test",
  });

  server.get("/api/health", async () => ({
    ok: true,
    service: "agentfiles",
  }));

  void server.register(fastifyCookie, {
    secret: config.sessionSecret,
  });
  void server.register(fastifyRateLimit, {
    global: false,
  });
  void server.register(registerAdminRoutes, { config });
  void server.register(registerFilesRoutes, { config });
  void server.register(registerShareRoutes, { config });

  const cleanupIntervalMs =
    (config as AppConfig & { cleanupIntervalMs?: number }).cleanupIntervalMs ?? 60 * 60 * 1000;
  if (config.nodeEnv !== "test" && cleanupIntervalMs > 0) {
    const cleanupJob = startCleanupExpiredFilesJob({
      intervalMs: cleanupIntervalMs,
      cleanup: async () => {
        const result = await cleanupExpiredFiles({ storageRoot: config.storageRoot });
        for (const failure of result.failures) {
          server.log.error({ failure }, "Expired file byte cleanup failed");
        }
        return result;
      },
      onError: (error) => server.log.error({ error }, "Expired file cleanup failed"),
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

async function start() {
  const config = loadConfig();
  const server = buildServer(config);
  await server.listen({ host: "0.0.0.0", port: config.port });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
