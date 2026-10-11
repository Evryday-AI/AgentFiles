import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { argon2id, hash } from "argon2";
import { loadConfig, type AppConfig } from "../../src/server/config";

const defaults = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://fixture:fixture@localhost:5432/agentfiles_test",
  STORAGE_ROOT: join(tmpdir(), "agentfiles-test"),
  SESSION_SECRET: randomBytes(32).toString("hex"),
  ADMIN_PASSWORD_HASH: await hash("synthetic-unused-fixture-password", { type: argon2id }),
});
mkdirSync(defaults.storageRoot, { recursive: true });

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...defaults, ...overrides };
}
