import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { isolatedEnvironment } from "./smoke-compose.mjs";
import { sanitizeBrowserOutput } from "./browser-output.mjs";
if (!process.env.AGENTFILES_TEST_DATABASE_URL || process.env.DATABASE_URL)
  throw new Error("Explicit isolated test database required");
// Playwright's downloaded FFmpeg serves its own tooling, not the fixture's
// independent PNG/WebM/WAV generator. Check the host prerequisite before DB work.
const mediaTool = spawnSync("ffmpeg", ["-version"], {
  env: isolatedEnvironment(process.env),
  windowsHide: true,
  stdio: "ignore",
  timeout: 10000,
});
if (mediaTool.status !== 0) {
  process.stderr.write(
    "Browser fixtures require FFmpeg on PATH; install FFmpeg before running test:browser.\n",
  );
  process.exit(1);
}
// Each viewport receives a fresh HTTP server/database. Production throttles are
// unchanged, and earlier mutations cannot leak into another project's fixture.
if (!process.argv.slice(2).some((arg) => arg.startsWith("--project"))) {
  let failed = false;
  for (const project of ["desktop", "phone-viewport", "minimum-width"]) {
    const result = spawnSync(
      process.execPath,
      [process.argv[1], ...process.argv.slice(2), `--project=${project}`],
      {
        env: process.env,
        windowsHide: true,
        encoding: "utf8",
        timeout: 300000,
      },
    );
    process.stdout.write(
      sanitizeBrowserOutput(`${result.stdout ?? ""}${result.stderr ?? ""}`, [
        process.env.AGENTFILES_TEST_DATABASE_URL,
      ]),
    );
    if (result.status !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
const directory = resolve(".private/browser", randomBytes(12).toString("hex"));
await mkdir(directory, { recursive: true });
const reservation = createServer();
await new Promise((done, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", done);
});
const port = reservation.address().port;
await new Promise((done, reject) =>
  reservation.close((error) => (error ? reject(error) : done())),
);
const env = {
  ...isolatedEnvironment(process.env),
  AGENTFILES_TEST_DATABASE_URL: process.env.AGENTFILES_TEST_DATABASE_URL,
  AGENTFILES_BROWSER_FIXTURE_DIR: directory,
  AGENTFILES_BROWSER_PORT: String(port),
};
let output = "";
const child = spawn(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)],
  { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    output += chunk.toString();
    if (output.length > 2_000_000) child.kill();
  });
const status = await new Promise((done, reject) => {
  child.once("error", reject);
  child.once("close", done);
});
let state;
try {
  state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
} catch {}
const secrets = [
  env.AGENTFILES_TEST_DATABASE_URL,
  new URL(env.AGENTFILES_TEST_DATABASE_URL).password,
  state?.password,
  state?.databaseUrl,
].filter(Boolean);
const clean = sanitizeBrowserOutput(output, secrets);
await writeFile(join(directory, "run.log"), clean, { mode: 0o600 });
// Windows may terminate webServer without running its signal handlers. Drop
// only this run's registered sibling database and its bounded owned temp root.
if (state) {
  const source = new URL(env.AGENTFILES_TEST_DATABASE_URL),
    owned = new URL(state.databaseUrl);
  const name = owned.pathname.slice(1);
  if (
    state.directory !== directory ||
    owned.host !== source.host ||
    owned.username !== source.username ||
    owned.password !== source.password ||
    !/^agentfiles_test_[a-f0-9]{24}$/.test(name) ||
    owned.pathname === source.pathname ||
    dirname(resolve(state.storageRoot)) !== resolve(tmpdir()) ||
    !resolve(state.storageRoot).startsWith(
      resolve(join(tmpdir(), "agentfiles-integration-")),
    )
  )
    throw new Error("Unowned browser cleanup refused");
  const controller = new pg.Pool({ connectionString: source.href });
  try {
    await controller.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await controller.end();
  }
  await rm(state.storageRoot, { recursive: true, force: true });
}
process.stdout.write(clean);
process.exitCode = typeof status === "number" ? status : 1;
