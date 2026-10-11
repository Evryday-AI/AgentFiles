import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
export interface InstanceInfo {
  name: "AgentFiles";
  base_url: string;
  retention_days: number;
  max_upload_bytes: number;
  allow_persistent_files: boolean;
  skill_url: string;
}
export async function registerInstanceRoutes(server: FastifyInstance, options: {
  config: AppConfig;
}) {
  // Fixed asset URL works in source and dist/server. No request path, key or
  // environment variable participates in resolving or rendering the asset.
  const skill = await readFile(new URL("../../skills/agentfiles/SKILL.md", import.meta.url), "utf8");
  const config = options.config;
  const info: InstanceInfo = {
    name: "AgentFiles",
    base_url: config.publicBaseUrl,
    retention_days: config.retentionDays,
    max_upload_bytes: config.maxUploadBytes,
    allow_persistent_files: config.allowPersistentFiles,
    skill_url: new URL("/skills/agentfiles/SKILL.md", config.publicBaseUrl).href,
  };
  server.get("/api/instance", async () => info);
  server.get("/skills/agentfiles/SKILL.md", async (_request, reply) => reply
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .type("text/plain; charset=utf-8").send(skill));
}
