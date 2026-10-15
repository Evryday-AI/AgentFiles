import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { backupProject, verifyBackup, validateRecoveryRegistry } from './backup.mjs';
import { isolatedEnvironment, ownedChild } from './smoke-compose.mjs';

export async function runOperationsSmoke(ctx) {
  const { root, main, directory, fixture, command, compose, ownedContainer, inspect, waitReady, bytes, file, cookie, secrets, record, download } = ctx;
  const sql = async (item, query) => (await compose(item, ['exec', '-T', 'db', 'psql', '-U', 'agentfiles', '-d', 'agentfiles', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query])).output.trim();
  const json = async (item, query) => JSON.parse(await sql(item, query));
  const edit = async (item, updates) => {
    const path = resolve(item.directory, '.env'); let text = await readFile(path, 'utf8');
    for (const [key, value] of Object.entries(updates)) text = text.replace(new RegExp(`^${key}='.*'$`, 'm'), `${key}='${value}'`);
    await writeFile(path, text, { mode: 0o600 });
  };
  const upload = async (item, credential, text) => {
    const form = new FormData(); form.set('file', new Blob([text]), 'synthetic.txt');
    const response = await fetch(`http://127.0.0.1:${item.port}/api/files`, { method: 'POST', headers: { cookie: credential, origin: item.origin }, body: form });
    assert.equal(response.status, 201); return response.json();
  };
  const login = async (item, password = item.password) => {
    const response = await fetch(`http://127.0.0.1:${item.port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: item.origin }, body: JSON.stringify({ username: 'smoke-$-admin', password }) });
    assert.equal(response.status, 200); const value = response.headers.get('set-cookie').split(';')[0]; secrets.push(value); return value;
  };
  await compose(main, ['down']);
  await compose(main, ['up', '-d', 'db']);
  await compose(main, ['run', '--rm', 'migrate']);
  await compose(main, ['up', '-d']); await waitReady(main); await download();
  await compose(main, ['up', '-d', '--no-deps', '--force-recreate', 'db']); await waitReady(main); await download();
  record('normal down preserves both volumes; fresh explicit migration and DB recreation preserve file SHA');
  await assert.rejects(backupProject({ project: `${main.project}-absent`, output: resolve(directory, 'backups'), cwd: main.directory }));
  const nestedSource = (await readFile(resolve(root, 'compose.yaml'), 'utf8'))
    .replace('- storage:/data/storage', '- storage:/data/storage\n      - nested:/data/storage/.synthetic-nested') + '\n  nested:\n';
  const nested = await fixture('nested-mount', nestedSource);
  const expectedImages = { app: await inspect(await ownedContainer(main, 'app'), '{{.Image}}'), db: await inspect(await ownedContainer(main, 'db'), '{{.Image}}') };
  try {
    await compose(nested, ['up', '-d']); await waitReady(nested);
    const nestedApp = await ownedContainer(nested, 'app');
    const before = JSON.parse(await inspect(nestedApp, '{{json .State}}'));
    const output = ownedChild(nested.directory, 'refused-backups');
    await assert.rejects(backupProject({ project: nested.project, output, cwd: nested.directory }), /additional storage mounts/);
    await assert.rejects(access(output), { code: 'ENOENT' });
    const after = JSON.parse(await inspect(nestedApp, '{{json .State}}'));
    assert.equal(after.Running, true); assert.equal(after.StartedAt, before.StartedAt); assert.equal(after.FinishedAt, before.FinishedAt);
    record('owned nested storage volume refused before output creation or app shutdown');
  } finally {
    for (const service of ['app', 'migrate', 'db']) {
      const container = await ownedContainer(nested, service);
      assert.equal(await inspect(container, '{{index .Config.Labels "com.docker.compose.service"}}'), service);
      assert.equal(await inspect(container, '{{.Image}}'), expectedImages[service === 'db' ? 'db' : 'app']);
    }
    for (const name of ['storage', 'database', 'nested']) {
      const volume = JSON.parse((await command(['volume', 'inspect', `${nested.project}_${name}`])).output)[0];
      assert.equal(volume.Name, `${nested.project}_${name}`);
      assert.equal(volume.Labels['com.docker.compose.project'], nested.project);
      assert.equal(volume.Labels['com.docker.compose.volume'], name);
    }
    await compose(nested, ['down', '--volumes']);
  }
  const pending = await upload(main, cookie, 'pending-claim-bytes');
  const expired = await upload(main, cookie, 'expired-snapshot-bytes');
  await compose(main, ['stop', 'app']);
  await sql(main, `UPDATE files SET lifecycle_state='deleting',deletion_claim_id='${randomUUID()}',deletion_claimed_at=now(),deletion_claim_reason='manual' WHERE code='${pending.code}'; UPDATE files SET expires_at=now()-interval '1 second' WHERE code='${expired.code}';`);
  const pendingCode = pending.code;
  const old = await backupProject({ project: main.project, output: resolve(directory, 'backups'), cwd: main.directory });
  const manifest = await verifyBackup(old);
  assert.equal(manifest.schema.length, 4); assert.equal(manifest.inventory.pending_claims, 1);
  assert.equal(await inspect(await ownedContainer(main, 'app'), '{{.State.Running}}'), 'false', 'Originally stopped app must remain stopped');
  await compose(main, ['start', 'app']); await waitReady(main);
  const later = await upload(main, cookie, 'later-issued-then-purged');
  const deleteLater = await fetch(`http://127.0.0.1:${main.port}/api/files/${later.code}`, { method: 'DELETE', headers: { cookie, origin: main.origin } }); assert.equal(deleteLater.status, 200);
  await sql(main, `DELETE FROM events WHERE file_id IN(SELECT id FROM files WHERE code='${later.code}'); DELETE FROM files WHERE code='${later.code}';`);
  const latest = await backupProject({ project: main.project, output: resolve(directory, 'backups'), cwd: main.directory });
  assert.equal(await inspect(await ownedContainer(main, 'app'), '{{.State.Running}}'), 'true', 'Running app resumed in finally');
  await compose(main, ['exec', '-T', 'app', 'node', '-e', "require('node:fs').writeFileSync('/data/storage/.synthetic-unreadable','fixture',{mode:0o000});"]);
  try {
    await assert.rejects(backupProject({ project: main.project, output: resolve(directory, 'backups'), cwd: main.directory }));
    assert.equal(await inspect(await ownedContainer(main, 'app'), '{{.State.Running}}'), 'true', 'Failed archive must resume previously running app');
  } finally { await compose(main, ['exec', '-T', 'app', 'node', '-e', "require('node:fs').unlinkSync('/data/storage/.synthetic-unreadable');"]); }
  const evidence = JSON.parse(await readFile(resolve(latest, 'registry.json'), 'utf8'));
  assert(evidence.codes.includes(later.code));
  assert.equal(await sql(main, `SELECT count(*) FROM files WHERE code='${later.code}'`), '0');
  record('coordinated owned backup contains ledger, marker, complete registry/claim; successful and failed archive finally resume running app');
  const restore = await fixture('restore');
  const sourceConfig = await readFile(resolve(main.directory, '.env'), 'utf8');
  await edit(restore, { ADMIN_PASSWORD_HASH: sourceConfig.match(/^ADMIN_PASSWORD_HASH='(.*)'$/m)[1], FILE_ISSUANCE_ENABLED: 'false' });
  await compose(restore, ['up', '-d', '--wait', '--wait-timeout', '90', 'db']);
  const restoreDb = await ownedContainer(restore, 'db');
  await command(['cp', resolve(old, 'database.dump'), `${restoreDb}:/tmp/owned-restore.dump`]);
  await compose(restore, ['exec', '-T', 'db', 'pg_restore', '-U', 'agentfiles', '-d', 'agentfiles', '--exit-on-error', '--no-owner', '--no-acl', '/tmp/owned-restore.dump']);
  await compose(restore, ['create', 'app']);
  const restoredApp = await ownedContainer(restore, 'app');
  const mounts = JSON.parse(await inspect(restoredApp, '{{json .Mounts}}'));
  const volume = mounts.find(m => m.Destination === '/data/storage'); assert.equal(volume.Type, 'volume');
  assert.equal((await command(['volume', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', volume.Name])).output.trim(), restore.project);
  const helper = `${restore.project}-extract`;
  const image = await inspect(restoredApp, '{{.Image}}');
  try {
    await command(['create', '--interactive', '--name', helper, '--label', `agentfiles.restore-fixture=${restore.project}`, '--network', 'none', '--user', '1000:1000', '--mount', `type=volume,src=${volume.Name},dst=/data/storage`, '--entrypoint', 'tar', image, '-C', '/data/storage', '-xzf', '-']);
    await command(['start', '-a', '-i', helper], { inputFile: resolve(old, 'storage.tar.gz') });
  } finally {
    assert.equal(await inspect(helper, '{{.Name}}'), `/${helper}`);
    assert.equal(await inspect(helper, '{{index .Config.Labels "agentfiles.restore-fixture"}}'), restore.project);
    assert.equal(await inspect(helper, '{{.Image}}'), image);
    await command(['rm', helper]);
  }
  assert.equal(await sql(restore, `SELECT count(*) FROM files WHERE lifecycle_state='deleting' AND code='${pendingCode}'`), '1');
  const restoredRegistry = await json(restore, 'SELECT json_agg(code ORDER BY code) FROM issued_file_codes');
  assert(!restoredRegistry.includes(later.code));
  assert.equal(await sql(restore, 'SELECT volume_id FROM storage_volume_identity WHERE singleton'), manifest.volumeId);
  const original = await json(restore, `SELECT row_to_json(f) FROM files f WHERE code='${file.code}'`);
  await compose(restore, ['run', '--rm', '--no-deps', '--entrypoint', 'node', 'app', '--input-type=module', '-e', `import fs from 'node:fs';import crypto from 'node:crypto'; const marker=fs.readFileSync('/data/storage/.agentfiles-volume','utf8'); if(marker!=='${manifest.volumeId}')process.exit(1); if(crypto.createHash('sha256').update(fs.readFileSync('/data/storage/${original.storage_key}')).digest('hex')!=='${file.sha256}')process.exit(1); const s=fs.statSync('/data/storage');if(s.uid!==1000||(s.mode&2))process.exit(1);`]);
  await compose(restore, ['run', '--rm', '--no-deps', '--entrypoint', 'node', 'app', '--input-type=module', '-e', `import fs from 'node:fs';fs.writeFileSync('/data/storage/.agentfiles-volume','${randomUUID()}');`]);
  const mismatched = await compose(restore, ['run', '--rm', '--no-deps', 'app'], { allowFailure: true, timeout: 20000 });
  assert.equal(mismatched.code, 1, 'Mismatched restored marker must refuse startup');
  await compose(restore, ['run', '--rm', '--no-deps', '--entrypoint', 'node', 'app', '--input-type=module', '-e', `import fs from 'node:fs';fs.writeFileSync('/data/storage/.agentfiles-volume','${manifest.volumeId}');`]);
  await compose(restore, ['run', '--rm', 'migrate']); await compose(restore, ['up', '-d']); await waitReady(restore);
  assert.equal((await fetch(`http://127.0.0.1:${restore.port}/api/files/${file.code}/download`, { headers: { cookie } })).status, 401, 'Restored sessions must not survive new secret');
  const restoredCookie = await login(restore, main.password);
  assert.equal((await fetch(`http://127.0.0.1:${restore.port}/api/files/${file.code}/download`)).status, 401);
  const restoredDownload = await fetch(`http://127.0.0.1:${restore.port}/api/files/${file.code}/download`, { headers: { cookie: restoredCookie } });
  assert.equal(restoredDownload.status, 200); assert.deepEqual(Buffer.from(await restoredDownload.arrayBuffer()), bytes);
  assert([404,410].includes((await fetch(`http://127.0.0.1:${restore.port}/api/files/${expired.code}`, { headers: { cookie: restoredCookie } })).status));
  const blockedForm = new FormData(); blockedForm.set('file', new Blob(['disabled']), 'disabled.txt');
  const blocked = await fetch(`http://127.0.0.1:${restore.port}/api/files`, { method: 'POST', headers: { cookie: restoredCookie, origin: restore.origin }, body: blockedForm });
  assert.equal(blocked.status, 503); assert.equal((await blocked.json()).code, 'FILE_ISSUANCE_DISABLED');
  assert.equal(await sql(restore, `SELECT lifecycle_state FROM files WHERE code='${pendingCode}'`), 'deleted');
  record('isolated restore verifies bytes/auth/new secret/marker/permissions/ledger; pending claim resumes; expired access denied; no later evidence leaves uploads disabled');
  await compose(restore, ['stop', 'app']);
  await compose(main, ['stop', 'app']);
  const codes = validateRecoveryRegistry(evidence, manifest.volumeId, true);
  // The runner controls every synthetic issuance after the old backup and
  // proves this is the surviving source's current full quiesced boundary.
  await writeFile(resolve(restore.directory, 'coverage-attestation.json'), JSON.stringify({ sourceBoundary: evidence.boundary, attestation: 'All later committed issuance covered; fixture owner admits no later writes before enabling recovered issuance.' }), { mode: 0o600 });
  await sql(restore, `BEGIN; LOCK TABLE issued_file_codes IN SHARE ROW EXCLUSIVE MODE; INSERT INTO issued_file_codes(code) VALUES ${codes.map(code => `('${code}')`).join(',')} ON CONFLICT DO NOTHING; DELETE FROM admin_sessions; COMMIT;`);
  await edit(restore, { FILE_ISSUANCE_ENABLED: 'true' });
  await compose(restore, ['up', '-d', '--no-deps', '--force-recreate', 'app']); await waitReady(restore);
  const newCookie = await login(restore, main.password);
  const replacement = await upload(restore, newCookie, 'new-file-after-recovery'); assert.notEqual(replacement.code, later.code);
  assert.equal((await fetch(`http://127.0.0.1:${restore.port}/api/files/${later.code}`, { headers: { cookie: newCookie } })).status, 404);
  assert.equal(await sql(restore, `SELECT count(*) FROM issued_file_codes WHERE code='${later.code}'`), '1');
  // Retire the recovered writer before resuming the original fixture used by
  // later smoke checks. Preserve its newly committed reservation there too.
  await compose(restore, ['stop', 'app']);
  const recoveredCodes = await json(restore, 'SELECT json_agg(code ORDER BY code) FROM issued_file_codes');
  validateRecoveryRegistry({ ...evidence, codes: recoveredCodes }, manifest.volumeId, true);
  await sql(main, `BEGIN; LOCK TABLE issued_file_codes IN SHARE ROW EXCLUSIVE MODE; INSERT INTO issued_file_codes(code) VALUES ${recoveredCodes.map(code => `('${code}')`).join(',')} ON CONFLICT DO NOTHING; COMMIT;`);
  await compose(main, ['start', 'app']); await waitReady(main);
  record('old snapshot merges all later code-only reservations including purged details before explicit issuance enablement');
  await runExperimentalUpgrade({ ...ctx, sql, json, edit, login, upload });
}

async function runExperimentalUpgrade(ctx) {
  const { root, directory, fixture, command, compose, ownedContainer, inspect, waitReady, sql, json, edit, login, upload, record } = ctx;
  const baseline = 'b4c99bba7e625678ff55cb71ff2ed04d6e9902ac';
  const target = ownedChild(directory, 'baseline-source'); await mkdir(target);
  const env = isolatedEnvironment(process.env);
  const git = args => { const r = spawnSync('git', args, { cwd: root, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }); assert.equal(r.status, 0, 'Public baseline read failed'); return r.stdout; };
  const paths = git(['ls-tree', '-r', '--name-only', baseline, 'src/server', 'src/client', 'skills/agentfiles', 'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.client.json', 'vite.config.ts', 'LICENSE', 'THIRD_PARTY_NOTICES.md']).toString().trim().split('\n');
  for (const path of paths) { const destination = ownedChild(target, path); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, git(['show', `${baseline}:${path}`])); }
  const baselineImage = `${ctx.main.project}-baseline:test`;
  const source = (await readFile(resolve(root, 'compose.yaml'), 'utf8')).replaceAll('context: .', `context: '${target.replaceAll('\\', '/')}'`).replaceAll('agentfiles-local:0.1.0', baselineImage);
  const old = await fixture('upgrade', source);
  await compose(old, ['build'], { timeout: 600000 }); await compose(old, ['up', '-d']); await waitReady(old);
  const credential = await login(old); const data = 'experimental-baseline-bytes'; const file = await upload(old, credential, data);
  assert.equal(await sql(old, 'SELECT max(version) FROM schema_migrations'), '2');
  await compose(old, ['stop', 'app']);
  const oldApp = await ownedContainer(old, 'app'); const oldImage = await inspect(oldApp, '{{.Image}}');
  const db = await ownedContainer(old, 'db');
  // Matched baseline snapshot uses pg_dump inside the dedicated fixture DB.
  await compose(old, ['exec', '-T', 'db', 'pg_dump', '-U', 'agentfiles', '-d', 'agentfiles', '--format=custom', '--file=/tmp/baseline.dump']);
  const baselineDump = resolve(old.directory, 'baseline.dump');
  await command(['cp', `${db}:/tmp/baseline.dump`, baselineDump]);
  const oldMounts = JSON.parse(await inspect(oldApp, '{{json .Mounts}}'));
  const oldVolume = oldMounts.find(m => m.Destination === '/data/storage');
  assert.equal((await command(['volume', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', oldVolume.Name])).output.trim(), old.project);
  const snapshotHelper = `${old.project}-snapshot`;
  const baselineArchive = resolve(old.directory, 'baseline-storage.tar');
  try {
    await command(['create', '--name', snapshotHelper, '--label', `agentfiles.restore-fixture=${old.project}`, '--network', 'none', '--user', '1000:1000', '--mount', `type=volume,src=${oldVolume.Name},dst=/data/storage,readonly`, '--entrypoint', 'tar', oldImage, '-C', '/data/storage', '-cf', '/tmp/baseline-storage.tar', '.']);
    await command(['start', '-a', snapshotHelper]);
    await command(['cp', `${snapshotHelper}:/tmp/baseline-storage.tar`, baselineArchive]);
  } finally { assert.equal(await inspect(snapshotHelper, '{{index .Config.Labels "agentfiles.restore-fixture"}}'), old.project); await command(['rm', snapshotHelper]); }
  const before = await json(old, `SELECT row_to_json(f) FROM files f WHERE code='${file.code}'`);
  const marker = randomUUID();
  await compose(old, ['run', '--rm', '--no-deps', '--entrypoint', 'node', 'app', '--input-type=module', '-e', `import fs from 'node:fs'; fs.writeFileSync('/data/storage/.agentfiles-volume','${marker}',{flag:'wx',mode:0o600});`]);
  await writeFile(resolve(old.directory, 'pairing-attestation.json'), JSON.stringify({ baseline, completeCodes: [file.code], originalExclusivelyOwnedSyntheticVolume: true, marker }), { mode: 0o600 });
  let currentCompose = await readFile(resolve(old.directory, 'compose.yaml'), 'utf8');
  currentCompose = currentCompose.replaceAll(`context: '${target.replaceAll('\\', '/')}'`, `context: '${root.replaceAll('\\', '/')}'`).replaceAll(baselineImage, `${ctx.main.project}:test`);
  // Use the already built reviewed runtime by exact local image ID.
  const currentImage = await inspect(await ownedContainer(ctx.main, 'app'), '{{.Image}}');
  currentCompose = currentCompose.replaceAll(/image: .*/g, match => match.includes('postgres:') ? match : `image: ${currentImage}`);
  await writeFile(resolve(old.directory, 'compose.yaml'), currentCompose);
  await edit(old, { FILE_ISSUANCE_ENABLED: 'false' });
  await compose(old, ['run', '--rm', 'migrate']);
  assert.equal(await sql(old, 'SELECT max(version) FROM schema_migrations'), '4');
  const unpaired = await compose(old, ['run', '--rm', '--no-deps', 'app'], { allowFailure: true, timeout: 20000 });
  assert.equal(unpaired.code, 1, 'Nonempty pre-pairing DB must fail closed');
  await sql(old, `INSERT INTO storage_volume_identity(singleton,volume_id) VALUES(true,'${marker}');`);
  await compose(old, ['up', '-d', '--no-deps', '--force-recreate', 'app']); await waitReady(old);
  const updatedCookie = await login(old);
  const result = await fetch(`http://127.0.0.1:${old.port}/api/files/${file.code}/download`, { headers: { cookie: updatedCookie } }); assert.equal(result.status, 200); assert.equal(await result.text(), data);
  const ledger = await json(old, 'SELECT json_agg(t) FROM (SELECT version,checksum FROM schema_migrations ORDER BY version)t');
  const migrationFiles = await readdir(resolve(root, 'src/server/migrations'));
  for (const entry of ledger) {
    const path = migrationFiles.find(path => path.startsWith(String(entry.version).padStart(3, '0')));
    assert.equal(entry.checksum, createHash('sha256').update(await readFile(resolve(root, 'src/server/migrations', path))).digest('hex'));
  }
  await compose(old, ['stop', 'app']);
  await compose(old, ['run', '--rm', '--no-deps', '--entrypoint', 'node', 'app', '--input-type=module', '-e', `import fs from 'node:fs';fs.writeFileSync('/data/storage/${before.storage_key}','synthetic-mutated-after-upgrade');`]);
  const incompatible = await command(['run', '--rm', '--network', `${old.project}_default`, '--env-file', resolve(old.directory, '.env'), '--entrypoint', 'node', oldImage, 'dist/server/migrate.js'], { allowFailure: true }); assert.notEqual(incompatible.code, 0);
  // No post-backup issuance was admitted in this pre-registry rollback: the
  // explicitly disabled runtime proves there are no later codes to recover.
  const rollback = await fixture('rollback', source);
  await compose(rollback, ['up', '-d', '--wait', '--wait-timeout', '90', 'db']);
  const rollbackDb = await ownedContainer(rollback, 'db');
  await command(['cp', baselineDump, `${rollbackDb}:/tmp/baseline.dump`]);
  await compose(rollback, ['exec', '-T', 'db', 'pg_restore', '-U', 'agentfiles', '-d', 'agentfiles', '--exit-on-error', '/tmp/baseline.dump']);
  assert.equal(await sql(rollback, 'SELECT max(version) FROM schema_migrations'), '2');
  const restored = await json(rollback, `SELECT row_to_json(f) FROM files f WHERE code='${file.code}'`); assert.equal(restored.storage_key, before.storage_key);
  await compose(rollback, ['create', 'app']);
  const rollbackApp = await ownedContainer(rollback, 'app');
  const rollbackVolume = JSON.parse(await inspect(rollbackApp, '{{json .Mounts}}')).find(m => m.Destination === '/data/storage');
  assert.equal((await command(['volume', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', rollbackVolume.Name])).output.trim(), rollback.project);
  const restoreHelper = `${rollback.project}-extract`;
  try {
    await command(['create', '--interactive', '--name', restoreHelper, '--label', `agentfiles.restore-fixture=${rollback.project}`, '--network', 'none', '--user', '1000:1000', '--mount', `type=volume,src=${rollbackVolume.Name},dst=/data/storage`, '--entrypoint', 'tar', oldImage, '-C', '/data/storage', '-xf', '-']);
    await command(['start', '-a', '-i', restoreHelper], { inputFile: baselineArchive });
  } finally {
    assert.equal(await inspect(restoreHelper, '{{.Name}}'), `/${restoreHelper}`);
    assert.equal(await inspect(restoreHelper, '{{index .Config.Labels "agentfiles.restore-fixture"}}'), rollback.project);
    assert.equal(await inspect(restoreHelper, '{{.Image}}'), oldImage);
    await command(['rm', restoreHelper]);
  }
  await compose(rollback, ['run', '--rm', 'migrate']); await compose(rollback, ['up', '-d']); await waitReady(rollback);
  const rollbackCookie = await login(rollback); const rolledBack = await fetch(`http://127.0.0.1:${rollback.port}/api/files/${file.code}/download`, { headers: { cookie: rollbackCookie } }); assert.equal(rolledBack.status, 200); assert.equal(await rolledBack.text(), data);
  await compose(rollback, ['stop', 'app']);
  record('experimental phase-B revision upgrade schema2-to4 with explicit offline original-volume/full-history attestation; immutable ledger; old migrate rejects new DB; mechanical matched DB+archived bytes rollback into new volumes, old app stopped after read verification');
}
