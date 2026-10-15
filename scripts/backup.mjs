import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { dirname, resolve, parse, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { isolatedEnvironment } from './smoke-compose.mjs';

export function parseBackupOptions(args) {
  assert(args.length === 4, 'Select exactly --project and --output');
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(['--project', '--output'].includes(args[i]) && !values[args[i]], 'Unknown or duplicate backup option');
    assert(args[i + 1] && !args[i + 1].startsWith('--'), 'Missing backup selection');
    values[args[i]] = args[i + 1];
  }
  assert(/^[a-z0-9][a-z0-9_-]{0,62}$/.test(values['--project']), 'Unsafe Compose project');
  return { project: values['--project'], output: values['--output'] };
}
export function assertQuiescent(state, { stage = 'unspecified', initiallyRunning } = {}) {
  // Docker state also contains arbitrary daemon errors. Keep failure evidence
  // to fixed labels and typed scalar fields; never include raw inspect/config.
  const diagnostic = {
    stage: ['after-stop', 'after-dump', 'after-archive'].includes(stage) ? stage : 'unspecified',
    initiallyRunning: typeof initiallyRunning === 'boolean' ? initiallyRunning : null,
    Running: typeof state?.Running === 'boolean' ? state.Running : null,
    ExitCode: Number.isInteger(state?.ExitCode) && state.ExitCode >= 0 && state.ExitCode <= 255 ? state.ExitCode : null,
    OOMKilled: typeof state?.OOMKilled === 'boolean' ? state.OOMKilled : null,
  };
  assert(state?.Running === false && state.ExitCode === 0, `App did not stop with a confirmed successful drain; backup refused ${JSON.stringify(diagnostic)}`);
}
export function assertOwnedVolume(mount, labels, project, name, destination) {
  assert(mount?.Type === 'volume' && mount.Destination === destination && mount.RW === true &&
    labels?.['com.docker.compose.project'] === project && labels?.['com.docker.compose.volume'] === name, 'Backup requires the selected project exact owned named volumes');
}
export function validateRecoveryRegistry(evidence, volumeId, coverageAttested = false) {
  // The attestation is an operator decision about surviving evidence and every
  // later committed issuance. Neither time nor cardinality proves that fact.
  assert(coverageAttested === true, 'Complete later issuance coverage must be established by the operator');
  assert(evidence?.version === 1 && evidence.volumeId === volumeId && evidence.boundary?.kind === 'quiesced-full-registry', 'Registry evidence does not match the installation');
  for (const field of ['stoppedApp', 'appImage', 'databaseSnapshot', 'generatedAt']) assert(typeof evidence.boundary[field] === 'string' && evidence.boundary[field], 'Missing issuance boundary');
  assert(Array.isArray(evidence.codes) && evidence.codes.length <= 32 ** 5 && evidence.codes.every(code => typeof code === 'string' && /^F-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(code)), 'Invalid canonical recovery code');
  return [...new Set(evidence.codes)];
}
export async function mergeRecoveryRegistry(db, evidence, volumeId, coverageAttested = false) {
  const codes = validateRecoveryRegistry(evidence, volumeId, coverageAttested);
  await db.withClient(async client => {
    await client.query('BEGIN');
    try {
      await client.query('LOCK TABLE issued_file_codes IN SHARE ROW EXCLUSIVE MODE');
      const identity = (await client.query('SELECT volume_id FROM storage_volume_identity WHERE singleton')).rows[0];
      assert(identity?.volume_id === volumeId, 'Restored installation identity differs');
      await client.query('INSERT INTO issued_file_codes(code) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [codes]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
  // This helper never changes FILE_ISSUANCE_ENABLED or config files.
}
export async function verifyBackup(directory) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  assert(manifest.version === 1 && manifest.complete === true, 'Incomplete backup');
  for (const file of ['database.dump', 'storage.tar.gz', 'registry.json']) {
    assert(await fileHash(resolve(directory, file)) === manifest.sha256[file], 'Backup checksum mismatch');
  }
  return manifest;
}
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function safeDirectory(path) {
  const target = resolve(path);
  for (let current = target; current !== parse(current).root; current = dirname(current)) {
    try {
      const info = await lstat(current);
      assert(info.isDirectory() && !info.isSymbolicLink(), 'Backup output redirects');
      assert((await realpath(current)).toLowerCase() === current.toLowerCase(), 'Backup output redirects');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  return target;
}
export async function backupProject({ project, output, cwd = process.cwd() }) {
  assert(/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project), 'Unsafe Compose project');
  const env = isolatedEnvironment(process.env);
  const docker = (args) => {
    const result = spawnSync('docker', args, { env, cwd, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    assert(result.status === 0, 'Owned Docker operation failed; inspect private operator diagnostics');
    return result.stdout.trim();
  };
  const ids = docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']).split('\n').filter(Boolean);
  assert(ids.length, 'Unknown/unowned Compose project');
  const containers = ids.map(id => JSON.parse(docker(['inspect', id]))[0]);
  assert(containers.every(c => c.Config.Labels['com.docker.compose.project'] === project && ['app', 'db', 'migrate'].includes(c.Config.Labels['com.docker.compose.service']) && c.Config.Labels['com.docker.compose.oneoff'] === 'False'), 'Unknown writer/service in selected project');
  const service = name => { const list = containers.filter(c => c.Config.Labels['com.docker.compose.service'] === name); assert(list.length === 1, 'Expected single dedicated service'); return list[0]; };
  const app = service('app'), db = service('db');
  assert(app.Config.Cmd?.join(' ') === 'node dist/server/index.js --host=0.0.0.0', 'Unsupported app command/writer');
  assert(db.State.Running && db.Config.Env.includes('POSTGRES_USER=agentfiles') && db.Config.Env.includes('POSTGRES_DB=agentfiles'), 'Unsupported dedicated database');
  const appValues = Object.fromEntries(app.Config.Env.map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
  const appDatabase = new URL(appValues.DATABASE_URL);
  const databasePassword = db.Config.Env.find(value => value.startsWith('POSTGRES_PASSWORD='))?.slice('POSTGRES_PASSWORD='.length);
  assert(appValues.STORAGE_ROOT === '/data/storage' && appDatabase.hostname === 'db' && appDatabase.pathname === '/agentfiles' && appDatabase.username === 'agentfiles' && ['','5432'].includes(appDatabase.port) && decodeURIComponent(appDatabase.password) === databasePassword, 'App must use the selected dedicated database and storage');
  assert(containers.filter(c => c.Config.Labels['com.docker.compose.service'] === 'migrate').every(c => !c.State.Running), 'Migration writer must be stopped');
  const storage = app.Mounts.find(m => m.Destination === '/data/storage');
  // The archive sees only this parent volume, never a nested container mount.
  // Normalize Linux destinations independently of the host's path semantics.
  const storageMounts = app.Mounts.filter(m => {
    assert(typeof m.Destination === 'string' && posix.isAbsolute(m.Destination), 'Invalid app mount destination');
    const destination = posix.normalize(m.Destination).replace(/\/+$/, '');
    return destination === '/data/storage' || destination.startsWith('/data/storage/');
  });
  assert(storageMounts.length === 1 && storageMounts[0] === storage, 'Backup refuses additional storage mounts or ambiguous storage root');
  const database = db.Mounts.find(m => m.Destination === '/var/lib/postgresql/data');
  for (const [mount, name, destination] of [[storage, 'storage', '/data/storage'], [database, 'database', '/var/lib/postgresql/data']]) {
    const volume = JSON.parse(docker(['volume', 'inspect', mount?.Name ?? 'invalid']))[0];
    assertOwnedVolume(mount, volume.Labels, project, name, destination);
    assert(volume.Driver === 'local' && Object.keys(volume.Options ?? {}).length === 0, 'Only plain exclusively owned local named volumes supported');
    const attached = docker(['ps', '-a', '--filter', `volume=${mount.Name}`, '--format', '{{.ID}}']).split('\n').filter(Boolean);
    assert(attached.every(id => ids.some(owned => id === owned)), 'Volume used outside selected project');
  }
  const target = resolve(output, `backup-${randomUUID()}`);
  const ignored = spawnSync('git', ['check-ignore', '--quiet', resolve(target, 'manifest.json')], { cwd, env, windowsHide: true });
  assert(ignored.status === 0, 'Backup output must be ignored runtime storage');
  await safeDirectory(dirname(target)); await mkdir(target, { mode: 0o700 });
  let stopped = false;
  const inspectApp = () => JSON.parse(docker(['inspect', app.Id]))[0];
  const confirmStopped = stage => assertQuiescent(inspectApp().State, { stage, initiallyRunning: app.State.Running });
  const sql = query => docker(['exec', db.Id, 'psql', '-U', 'agentfiles', '-d', 'agentfiles', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query]);
  const binary = async (args, file) => {
    const child = spawn('docker', args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // Never print runtime diagnostics, which can contain private metadata.
    child.stderr.resume();
    const result = new Promise((done, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? done() : reject(new Error('Backup stream failed'))); });
    const timer = setTimeout(() => child.kill(), 30 * 60 * 1000);
    try { await Promise.all([pipeline(child.stdout, createWriteStream(resolve(target, file), { flags: 'wx', mode: 0o600 })), result]); }
    finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); }
  };
  try {
    if (app.State.Running) { docker(['stop', '--time', '15', app.Id]); stopped = true; }
    confirmStopped('after-stop');
    const appVersion = docker(['run', '--rm', '--network', 'none', '--entrypoint', 'node', app.Image, '-p', "require('./package.json').version"]);
    assert(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(appVersion), 'Invalid packaged app version');
    const snapshot = sql('SELECT txid_current_snapshot()::text');
    const volumeId = sql('SELECT volume_id FROM storage_volume_identity WHERE singleton');
    const schema = JSON.parse(sql("SELECT coalesce(json_agg(t),'[]') FROM (SELECT version,checksum FROM schema_migrations ORDER BY version)t"));
    const codes = sql('SELECT code FROM issued_file_codes ORDER BY code').split('\n').filter(Boolean);
    const evidence = { version: 1, volumeId, boundary: { kind: 'quiesced-full-registry', stoppedApp: app.Id, appImage: app.Image, databaseSnapshot: snapshot, generatedAt: new Date().toISOString() }, codes };
    validateRecoveryRegistry(evidence, volumeId, true);
    await binary(['exec', db.Id, 'pg_dump', '-U', 'agentfiles', '-d', 'agentfiles', '--format=custom', '--no-owner', '--no-acl'], 'database.dump');
    confirmStopped('after-dump');
    await binary(['run', '--rm', '--network', 'none', '--user', '1000:1000', '--mount', `type=volume,src=${storage.Name},dst=/data/storage,readonly`, '--entrypoint', 'tar', app.Image, '-C', '/data/storage', '-czf', '-', '.'], 'storage.tar.gz');
    confirmStopped('after-archive');
    await writeFile(resolve(target, 'registry.json'), JSON.stringify(evidence), { mode: 0o600, flag: 'wx' });
    const sha256 = {};
    for (const file of ['database.dump', 'storage.tar.gz', 'registry.json']) sha256[file] = await fileHash(resolve(target, file));
    const inventory = JSON.parse(sql("SELECT json_build_object('files',count(*),'pending_claims',count(*) FILTER(WHERE lifecycle_state='deleting')) FROM files"));
    await writeFile(resolve(target, 'configuration-recovery.txt'), 'Private configuration is not copied automatically. Preserve the matching .env, encryption keys and administrator recovery material separately with restrictive permissions and authenticated encryption. On restore generate a new SESSION_SECRET, revoke sessions, and keep FILE_ISSUANCE_ENABLED=false until complete later-issued registry coverage is established. See docs/backups.md.\n', { mode: 0o600, flag: 'wx' });
    await writeFile(resolve(target, 'manifest.json'), JSON.stringify({ version: 1, complete: true, schema, appVersion, appImage: app.Image, volumeId, inventory, registryCount: codes.length, sha256 }, null, 2), { mode: 0o600, flag: 'wx' });
    return target;
  } finally {
    // Read-only backup operations do not change source DB/bytes. A stop that
    // succeeded is resumed even when a later dump/archive operation failed.
    if (stopped) docker(['start', app.Id]);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => backupProject(parseBackupOptions(process.argv.slice(2)))).then(() => console.log('Coordinated private backup complete; original app running/stopped state preserved.')).catch(() => { console.error('Backup refused or failed; inspect the selected private output and app state.'); process.exitCode = 1; });
}
