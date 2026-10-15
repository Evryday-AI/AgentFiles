import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, lstat, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import argon2 from 'argon2';
import { createSetupFile } from './setup-lib.mjs';
import { runAgentSmoke } from './smoke-agents.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const childEnvironmentNames = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'COMSPEC', 'LANG', 'LC_ALL', 'TERM', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']);

export function ownedChild(parent, name) {
  const target = resolve(parent, name);
  const suffix = relative(parent, target);
  assert(suffix && suffix !== '..' && !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(suffix), 'Scratch path escapes owned root');
  return target;
}

export function isolatedEnvironment(source) {
  // Allow only process/tool discovery and local OS settings. No ambient app,
  // database, cloud, client, npm or proxy configuration enters fixture children.
  return Object.fromEntries(Object.entries(source).filter(([key]) => childEnvironmentNames.has(key.toUpperCase())));
}

export function parseSmokeOptions(args) {
  if (args.some(arg => !['--agents', '--operations'].includes(arg)) || new Set(args).size !== args.length) throw new Error('Unknown or duplicate smoke option');
  return { agents: args.includes('--agents'), operations: args.includes('--operations') };
}

export function sanitizeDiagnostics(value, secrets = []) {
  let clean = String(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) clean = clean.split(secret).join('[redacted]');
  clean = clean.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[database URL redacted]')
    .replace(/\/(?:s|share)\/[^\s"'?]+/gi, '/s/[redacted]')
    .replace(/(?:authorization|cookie|set-cookie)[=:][^\r\n]+/gi, '[header redacted]');
  return clean.length > 4096 ? `[bounded]\n${clean.slice(-4086)}` : clean;
}

// Pass protected archives directly through a read-only descriptor. Docker cp
// preserves mode but creates root-owned files, unreadable by UID 1000 at 0600.
export async function captureCommand(executable, args, { cwd, env, timeout = 180000, inputFile } = {}) {
  const input = inputFile === undefined ? undefined : await open(inputFile, 'r');
  try {
    return await new Promise((done, reject) => {
      const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: [input?.fd ?? 'ignore', 'pipe', 'pipe'] });
      let output = '';
      const capture = chunk => { output = (output + chunk.toString()).slice(-65536); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      const timer = setTimeout(() => { child.kill(); }, timeout);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); done({ code, output }); });
    });
  } finally { await input?.close(); }
}

export async function runComposeSmoke(args = process.argv.slice(2)) {
  const options = parseSmokeOptions(args);
  const template = await readFile(resolve(root, 'compose.yaml'), 'utf8');
  const scratch = ownedChild(root, '.private/compose-smoke');
  await mkdir(scratch, { recursive: true });
  assert.equal(await realpath(scratch), scratch, 'Scratch root must not redirect');
  assert(!(await lstat(scratch)).isSymbolicLink(), 'Scratch root must be a directory');
  const project = `afsmoke-${randomBytes(8).toString('hex')}`;
  const directory = ownedChild(scratch, project);
  await mkdir(directory);
  const env = isolatedEnvironment(process.env);
  const secrets = [];
  const results = [];
  const projects = [];
  const record = (scenario) => { results.push({ scenario, result: 'pass' }); console.log(`PASS ${scenario}`); };
  const command = async (args, { allowFailure = false, timeout = 180000, inputFile } = {}) => {
    const outcome = await captureCommand('docker', args, { cwd: directory, env, timeout, inputFile });
    if (!allowFailure && outcome.code !== 0) throw new Error(`Docker command failed: ${sanitizeDiagnostics(outcome.output, secrets)}`);
    return outcome;
  };
  const compose = (fixture, args, options) => command(['compose', '--project-name', fixture.project, '--project-directory', fixture.directory, '--env-file', resolve(fixture.directory, '.env'), '-f', resolve(fixture.directory, 'compose.yaml'), ...args], options);
  const inspect = async (id, format) => (await command(['inspect', '--format', format, id])).output.trim();
  const id = async (fixture, service) => (await compose(fixture, ['ps', '--all', '--quiet', service])).output.trim();
  const ownedContainer = async (fixture, service) => {
    const container = await id(fixture, service);
    assert(container, `Missing ${service} container`);
    assert.equal(await inspect(container, '{{index .Config.Labels "com.docker.compose.project"}}'), fixture.project, 'Container ownership mismatch');
    return container;
  };
  const fixture = async (suffix, source = template, services = ['db', 'migrate', 'app']) => {
    const name = suffix ? `${project}-${suffix}` : project;
    const target = suffix ? ownedChild(directory, suffix) : directory;
    await mkdir(target, { recursive: true });
    const server = createServer();
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const port = server.address().port;
    await new Promise(done => server.close(done));
    const password = randomBytes(24).toString('hex');
    secrets.push(password);
    const origin = options.agents && !suffix ? 'http://127.0.0.1:3000' : `http://localhost:${port}`;
    await createSetupFile({ directory: target, input: { mode: 'local', origin, adminName: 'smoke-$-admin', password, confirmation: password }, hashPassword: value => argon2.hash(value, { type: argon2.argon2id }), randomBytes });
    let configuration = await readFile(resolve(target, '.env'), 'utf8');
    configuration = configuration.replace("APP_PORT='3000'", `APP_PORT='${port}'`);
    secrets.push(...[...configuration.matchAll(/^(?:POSTGRES_PASSWORD|SESSION_SECRET|ADMIN_PASSWORD_HASH|DATABASE_URL)='(.*)'$/gm)].map(m => m[1]));
    await writeFile(resolve(target, '.env'), configuration, { mode: 0o600 });
    // Resolve only reviewed build contexts; env_file remains in this scratch fixture.
    await writeFile(resolve(target, 'compose.yaml'), source.replaceAll('context: .', `context: '${root.replaceAll('\\', '/')}'`).replaceAll('agentfiles-local:0.1.0', `${project}:test`));
    const databaseUrl = configuration.match(/^DATABASE_URL='(.*)'$/m)[1];
    const item = { project: name, directory: target, port, origin, password, services, databaseUrl };
    projects.push(item);
    return item;
  };
  const waitReady = async (item) => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try { const response = await fetch(`http://127.0.0.1:${item.port}/api/ready`, { signal: AbortSignal.timeout(4000) }); if (response.status === 200 && (await response.json()).ready) return; } catch {}
      await new Promise(done => setTimeout(done, 500));
    }
    throw new Error('Readiness deadline exceeded');
  };
  let failure;
  try {
    const main = await fixture('');
    await compose(main, ['config', '--quiet']);
    record('isolated Compose validation');
    console.log('Building reviewed runtime image with fresh dependency stages...');
    await compose(main, ['build'], { timeout: 600000 });
    record('Linux amd64 multi-stage build');
    await compose(main, ['up', '-d']);
    await waitReady(main);
    const db = await ownedContainer(main, 'db');
    const app = await ownedContainer(main, 'app');
    const migration = await ownedContainer(main, 'migrate');
    assert.equal(await inspect(db, '{{.State.Health.Status}}'), 'healthy');
    assert.equal(await inspect(migration, '{{.State.ExitCode}}'), '0');
    const times = JSON.parse((await inspect(app, '{{json .State}}')));
    const migrationState = JSON.parse(await inspect(migration, '{{json .State}}'));
    assert(Date.parse(times.StartedAt) >= Date.parse(migrationState.FinishedAt), 'App started before migration completion');
    assert.equal(await inspect(db, '{{json .HostConfig.PortBindings}}'), '{}');
    assert((await inspect(app, '{{json .HostConfig.PortBindings}}')).includes('127.0.0.1'));
    assert.equal(await inspect(app, '{{.Config.StopTimeout}}'), '15');
    const storageCheck = await compose(main, ['exec', '-T', 'app', 'node', '--input-type=module', '-e', "import fs from 'node:fs'; const s=fs.statSync('/data/storage'); if(process.getuid()!==1000 || s.uid!==1000 || (s.mode & 2))process.exit(1); fs.writeFileSync('/data/storage/volume-probe','owned'); fs.unlinkSync('/data/storage/volume-probe'); console.log('uid1000 owned writable root');"]);
    assert(storageCheck.output.includes('uid1000'));
    const artifactChecks = await compose(main, ['exec', '-T', 'app', 'node', '--input-type=module', '-e', "import fs from 'node:fs'; import crypto from 'node:crypto'; for(const p of ['LICENSE','THIRD_PARTY_NOTICES.md','skills/agentfiles/SKILL.md','dist-client/assets/app.js'])if(!fs.existsSync(p))process.exit(1); for(const p of ['.env','.private','tests','src','node_modules/vite'])if(fs.existsSync(p))process.exit(1); console.log(JSON.stringify(fs.readdirSync('dist/server/migrations').map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync('dist/server/migrations/'+n)).digest('hex')])));"]);
    for (const [name, checksum] of JSON.parse(artifactChecks.output.trim())) {
      assert.equal(createHash('sha256').update(await readFile(resolve(root, 'src/server/migrations', name))).digest('hex'), checksum, 'Image changed immutable migration bytes');
    }
    record('database health and migration completion gate app; no DB port; loopback app port; volume copy-up ownership');
    const base = `http://127.0.0.1:${main.port}`;
    const origin = main.origin;
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/assets/app.js`)).status, 200);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ username: 'smoke-$-admin', password: main.password }) });
    assert.equal(login.status, 200, 'Synthetic login failed');
    const setCookie = login.headers.get('set-cookie');
    assert(setCookie?.includes('HttpOnly') && setCookie.includes('SameSite=Lax') && !setCookie.includes('Secure'), 'Local cookie flags differ');
    const cookie = setCookie.split(';')[0]; secrets.push(cookie, setCookie);
    const bytes = Buffer.from(`AgentFiles isolated synthetic fixture ${randomBytes(32).toString('hex')}\n`);
    const form = new FormData(); form.set('file', new Blob([bytes], { type: 'text/plain' }), 'fixture.txt');
    const uploaded = await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie, origin }, body: form });
    assert.equal(uploaded.status, 201, 'Upload failed');
    const file = await uploaded.json();
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    const download = async () => {
      const response = await fetch(`${base}/api/files/${file.code}/download`, { headers: { cookie } });
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      const metadata = await fetch(`${base}/api/files/${file.code}`, { headers: { cookie } });
      assert.equal(metadata.status, 200); assert.equal((await metadata.json()).sha256, file.sha256);
    };
    await download();
    record('localhost login cookie, client assets, authenticated upload and SHA-256 download');
    if (options.operations) {
      const { runOperationsSmoke } = await import('./operations-compose.mjs');
      await runOperationsSmoke({ root, main, directory, fixture, command, compose, ownedContainer, inspect, waitReady, bytes, file, cookie, secrets, record, download });
    }
    if (options.agents) {
      await runAgentSmoke({ root, fixture: main, app, cookie, command, compose, secrets, record });
    }
    await compose(main, ['stop', 'db']);
    const readinessStart = Date.now();
    const unavailable = await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(5000) });
    assert.equal(unavailable.status, 503); assert.deepEqual(await unavailable.json(), { ready: false });
    assert(Date.now() - readinessStart < 4500);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    record('DB outage gives bounded readiness503 and liveness200');
    await compose(main, ['start', 'db']); await waitReady(main);
    await compose(main, ['up', '-d', '--no-deps', '--force-recreate', 'app']); await waitReady(main); await download();
    record('app recreation preserves metadata, session and stored bytes');
    // Exercise both actual Linux OS signals against the real running entry point.
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const current = await ownedContainer(main, 'app');
      const started = Date.now();
      await command(['kill', '--signal', signal, current]);
      assert.equal((await command(['wait', current], { timeout: 15000 })).output.trim(), '0', `${signal} did not drain successfully`);
      assert(Date.now() - started < 14000, 'Shutdown exceeded grace');
      await compose(main, ['up', '-d', '--no-deps', 'app']); await waitReady(main);
    }
    record('actual Linux SIGINT and SIGTERM drain with exit0 within15s grace');
    // All permission mutations are restricted to this project's exact named volume.
    const mounts = JSON.parse(await inspect(await ownedContainer(main, 'app'), '{{json .Mounts}}'));
    const storage = mounts.find(m => m.Destination === '/data/storage');
    assert(storage?.Type === 'volume');
    assert.equal((await command(['volume', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', storage.Name])).output.trim(), main.project);
    await compose(main, ['stop', 'app']);
    for (const [description, mutation] of [['wrong POSIX owner', 'chown 0:0 /data/storage'], ['world-writable POSIX root', 'chown 1000:1000 /data/storage && chmod 0777 /data/storage']]) {
      await compose(main, ['run', '--rm', '--no-deps', '--user', '0:0', '--entrypoint', 'sh', 'app', '-c', mutation]);
      const rejected = await compose(main, ['run', '--rm', '--no-deps', 'app'], { allowFailure: true, timeout: 20000 });
      assert.equal(rejected.code, 1, `${description} accepted`);
      assert(rejected.output.includes('Server startup failed; check configuration and storage permissions.'));
    }
    await compose(main, ['run', '--rm', '--no-deps', '--user', '0:0', '--entrypoint', 'sh', 'app', '-c', 'chown 1000:1000 /data/storage && chmod 0750 /data/storage']);
    await compose(main, ['up', '-d', '--no-deps', '--force-recreate', 'app']); await waitReady(main); await download();
    record('POSIX wrong-owner/world-write fail closed; owned volume restored without byte loss');
    const failed = await fixture('migration-failure');
    await compose(failed, ['config', '--quiet']);
    await compose(failed, ['up', '-d', 'db']);
    await compose(failed, ['run', '--rm', 'migrate']);
    await compose(failed, ['exec', '-T', 'db', 'psql', '-U', 'agentfiles', '-d', 'agentfiles', '-v', 'ON_ERROR_STOP=1', '-c', "UPDATE schema_migrations SET checksum='synthetic-corruption' WHERE version=1"]);
    const rejected = await compose(failed, ['up', '-d'], { allowFailure: true });
    assert.notEqual(rejected.code, 0, 'Corrupt migration unexpectedly succeeded');
    const badMigration = await ownedContainer(failed, 'migrate');
    assert.equal(await inspect(badMigration, '{{.State.ExitCode}}'), '1');
    const blockedApp = await id(failed, 'app');
    if (blockedApp) assert.equal(await inspect(blockedApp, '{{.State.Status}}'), 'created');
    record('real checksum migration failure exits1 and prevents app startup');
    // The advanced fixture uses only our own disposable database. Give that DB
    // a temporary endpoint on the advanced project's owned default network.
    const advanced = await fixture('external', await readFile(resolve(root, 'compose.external-db.yaml'), 'utf8'), ['migrate', 'app']);
    const advancedEnv = resolve(advanced.directory, '.env');
    // A new storage volume must never share the main installation's metadata
    // or persistent volume identity. This sibling DB is on our owned server.
    await compose(main, ['exec', '-T', 'db', 'psql', '-U', 'agentfiles', '-d', 'agentfiles', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE agentfiles_external']);
    const advancedUrl = new URL(main.databaseUrl);
    advancedUrl.pathname = '/agentfiles_external';
    secrets.push(advancedUrl.href);
    await writeFile(advancedEnv, (await readFile(advancedEnv, 'utf8')).replace(/^DATABASE_URL='.*'$/m, `DATABASE_URL='${advancedUrl.href}'`), { mode: 0o600 });
    await compose(advanced, ['config', '--quiet']);
    await compose(advanced, ['create', 'migrate']);
    const network = `${advanced.project}_default`;
    assert.equal((await command(['network', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', network])).output.trim(), advanced.project);
    const currentDb = await ownedContainer(main, 'db');
    await command(['network', 'connect', '--alias', 'db', network, currentDb]);
    try {
      await compose(advanced, ['up', '-d']); await waitReady(advanced);
      assert.equal(await inspect(await ownedContainer(advanced, 'migrate'), '{{.State.ExitCode}}'), '0');
      assert.equal((await fetch(`http://127.0.0.1:${advanced.port}/api/health`)).status, 200);
      record('complete external-database Compose starts independently with owned synthetic DB and migration gate');
    } finally { await command(['network', 'disconnect', network, currentDb]); }
  } catch (error) {
    failure = sanitizeDiagnostics(error.message, secrets);
    console.error(failure);
    for (const item of projects) {
      const logs = await compose(item, ['logs', '--no-color', '--tail', '20'], { allowFailure: true }).catch(() => ({ output: 'Diagnostics unavailable' }));
      await writeFile(resolve(item.directory, 'diagnostics.txt'), sanitizeDiagnostics(logs.output, secrets), { mode: 0o600 });
    }
  } finally {
    // No generic pruning, root .env, ambient URL, bind storage or other projects.
    for (const item of projects.reverse()) {
      try {
        for (const service of item.services) if (await id(item, service)) await ownedContainer(item, service);
        await compose(item, ['down', '--volumes', '--remove-orphans']);
      } catch (error) { failure ??= sanitizeDiagnostics(error.message, secrets); }
    }
    await writeFile(resolve(directory, 'results.json'), JSON.stringify({ project, results, failure: failure ?? null, cleanup: 'only unique runner-owned Compose projects and disposable volumes' }, null, 2), { mode: 0o600 });
  }
  if (failure) throw new Error('Smoke failed');
  console.log(`Compose smoke complete: ${results.length} scenarios; owned disposable services/volumes removed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runComposeSmoke().catch(() => { console.error('Compose smoke failed; see the bounded sanitized diagnostics in the owned scratch run.'); process.exitCode = 1; });
}
