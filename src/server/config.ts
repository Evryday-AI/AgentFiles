import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  STORAGE_ROOT: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD_HASH: z.string().min(1),
  RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(source);
  const publicBaseUrl = new URL(env.PUBLIC_BASE_URL);
  const productionLoopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (
    env.NODE_ENV === "production" &&
    (publicBaseUrl.protocol !== "https:" || productionLoopbackHosts.has(publicBaseUrl.hostname))
  ) {
    throw new Error("PUBLIC_BASE_URL must be set to an external HTTPS URL in production");
  }

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    storageRoot: env.STORAGE_ROOT,
    sessionSecret: env.SESSION_SECRET,
    adminUsername: env.ADMIN_USERNAME,
    adminPasswordHash: env.ADMIN_PASSWORD_HASH,
    retentionDays: env.RETENTION_DAYS,
    publicBaseUrl: env.PUBLIC_BASE_URL,
  };
}
