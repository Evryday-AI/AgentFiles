import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const clientBase = 'node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20';

export async function runAgentSmoke({ root, fixture, app, cookie, command, compose, secrets, record }) {
  const context = resolve(fixture.directory, 'agent-client');
  await mkdir(resolve(context, 'examples'), { recursive: true });
  await mkdir(resolve(context, 'tests/examples'), { recursive: true });
  // Individually reviewed public clients/tests only. No repository-wide copy.
  for (const name of ['upload.sh', 'roundtrip.py']) {
    await writeFile(resolve(context, 'examples', name), await readFile(resolve(root, 'examples', name)));
  }
  for (const name of ['test_roundtrip.py', 'test_shell.py']) {
    await writeFile(resolve(context, 'tests/examples', name), await readFile(resolve(root, 'tests/examples', name)));
  }
  await writeFile(resolve(context, 'hello.txt'), 'AgentFiles Compose independent hello fixture\n');
  await writeFile(resolve(context, 'portrait.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="400" viewBox="0 0 240 400"><rect width="240" height="400" fill="#345"/><circle cx="120" cy="140" r="55" fill="#fec"/><path d="M30 380V300a90 90 0 0 1 180 0v80" fill="#8bc"/></svg>');
  await writeFile(resolve(context, 'Dockerfile'), `FROM ${clientBase}\nRUN apt-get update && apt-get install -y --no-install-recommends bash=5.2.15-2+b13 curl=7.88.1-10+deb12u15 jq=1.6-2.1+deb12u2 python3=3.11.2-1+b1 coreutils=9.1-1 && rm -rf /var/lib/apt/lists/*\nWORKDIR /work\nCOPY examples/ ./examples/\nCOPY tests/ ./tests/\nCOPY hello.txt portrait.svg ./\nRUN chown -R node:node /work\nUSER node\n`);
  const image = `${fixture.project}-client:test`;
  await command(['build', '--tag', image, context], { timeout: 180000 });
  try {
    // Mock-origin/security tests use network:none, with only loopback servers.
    await command(['run', '--rm', '--label', `agentfiles.fixture=${fixture.project}`, '--network', 'none', '-e', 'AGENTFILES_SHELL_TESTS=1', image, 'python3', '-m', 'unittest', 'discover', '-s', 'tests/examples', '-p', 'test_*.py']);
    await command(['run', '--rm', '--label', `agentfiles.fixture=${fixture.project}`, '--network', 'none', image, 'bash', '-n', 'examples/upload.sh']);
    await command(['run', '--rm', '--label', `agentfiles.fixture=${fixture.project}`, '--network', 'none', image, 'python3', '-m', 'py_compile', 'examples/roundtrip.py']);
    record('Linux Python/Bash negative-origin, redirect sink, limits, exclusivity, checksum and uncertain-upload checks');

    const endpoint = `http://127.0.0.1:${fixture.port}`;
    const origin = fixture.origin;
    const infoResponse = await fetch(endpoint + '/api/instance', { redirect: 'error' });
    assert.equal(infoResponse.status, 200);
    const info = await infoResponse.json();
    assert.deepEqual(Object.keys(info).sort(), ['name', 'base_url', 'retention_days', 'max_upload_bytes', 'allow_persistent_files', 'skill_url'].sort());
    assert.equal(info.base_url, origin);
    assert.equal(info.retention_days, 7);
    const skillResponse = await fetch(endpoint + '/skills/agentfiles/SKILL.md', { redirect: 'error' });
    assert.equal(skillResponse.status, 200);
    const distributedSkill = await skillResponse.text();
    assert.equal(distributedSkill, await readFile(resolve(root, 'skills/agentfiles/SKILL.md'), 'utf8'));
    for (const secret of secrets) assert.equal(distributedSkill.includes(secret), false, 'Skill artifact contains a fixture secret');
    const admin = async (path, method, body) => {
      const response = await fetch(endpoint + path, { method, redirect: 'error', headers: { cookie, origin, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, method === 'POST' ? 201 : 200, 'Synthetic administrator request failed');
      return response.json();
    };
    const key = async (name, grants) => {
      const created = await admin('/api/admin/api-keys', 'POST', { name, can_upload: false, can_download: false, can_list: false, can_delete: false, can_mark_durable: false, can_share: false, ...grants });
      secrets.push(created.secret);
      return created;
    };
    const run = async (name, principal, args, allowFailure = false) => {
      const envFile = resolve(fixture.directory, `${name}-client.env`);
      await writeFile(envFile, `AGENTFILES_BASE_URL=${origin}\nAGENTFILES_API_KEY=${principal.secret}\n`, { mode: 0o600, flag: 'wx' });
      return command(['run', '--rm', '--label', `agentfiles.fixture=${fixture.project}`, '--network', `container:${app}`, '--env-file', envFile, image, ...args], { allowFailure });
    };
    const results = [];
    for (const [name, args, input] of [
      ['python', ['python3', 'examples/roundtrip.py', 'hello.txt'], 'hello.txt'],
      ['shell', ['bash', 'examples/upload.sh', 'portrait.svg'], 'portrait.svg'],
    ]) {
      const principal = await key(`Compose ${name} agent`, { can_upload: true, can_download: true, can_share: true, can_delete: true });
      const expiry = new Date(Date.now() + 600000).toISOString();
      const outcome = await run(name, principal, [...args, '--share-expires-at', expiry, '--revoke-share', '--delete']);
      const result = JSON.parse(outcome.output.trim().split('\n').at(-1));
      secrets.push(result.share.public_url, new URL(result.share.public_url).pathname.slice(3));
      const expected = createHash('sha256').update(await readFile(resolve(context, input))).digest('hex');
      assert.equal(result.verified_sha256, expected, 'Independent client checksum failed');
      assert.equal(result.sha256, expected);
      assert.equal(result.anonymous_share_verified, true);
      assert.equal(result.share_revoked, true);
      assert.equal(result.remote_deleted, true);
      assert.match(result.code, /^F-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
      assert.equal(new URL(result.private_url).origin, origin);
      assert(Date.parse(result.expires_at) > Date.now());
      const revoked = await fetch(endpoint + new URL(result.share.public_url).pathname, { redirect: 'error' });
      assert.equal(revoked.status, 410);
      await admin(`/api/admin/api-keys/${principal.apiKey.id}`, 'DELETE');
      const denied = await fetch(`${endpoint}/api/files/${result.code}/download`, { headers: { authorization: `Bearer ${principal.secret}` }, redirect: 'error' });
      assert.equal(denied.status, 401);
      results.push(result);
      record(`${name} actual Compose scoped-key upload, lookup, private/anonymous SHA download, share revocation, deletion and revoked-key denial`);
    }
    const uploadOnly = await key('Compose upload-only', { can_upload: true });
    const downloadOnly = await key('Compose download-only', { can_download: true });
    const form = new FormData(); form.set('file', new Blob(['expiry fixture']), 'expiry.txt');
    const uploaded = await fetch(endpoint + '/api/files', { method: 'POST', headers: { authorization: `Bearer ${uploadOnly.secret}` }, body: form, redirect: 'error' });
    assert.equal(uploaded.status, 201); const file = await uploaded.json();
    const inspect = await fetch(`${endpoint}/api/files/${file.code}`, { headers: { authorization: `Bearer ${uploadOnly.secret}` }, redirect: 'error' });
    assert.equal(inspect.status, 403);
    const forbidden = await fetch(endpoint + '/api/files', { method: 'POST', headers: { authorization: `Bearer ${downloadOnly.secret}` }, body: form, redirect: 'error' });
    assert.equal(forbidden.status, 403);
    const deniedDelete = await fetch(`${endpoint}/api/files/${file.code}`, { method: 'DELETE', headers: { authorization: `Bearer ${downloadOnly.secret}` }, redirect: 'error' });
    assert.equal(deniedDelete.status, 403);
    // Exact fixture-owned DB only; no public clock/expiry-control API. Ordinary
    // runtime retention remains seven days. Server access blocks before cleanup.
    assert.match(file.code, /^F-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
    await compose(fixture, ['exec', '-T', 'db', 'psql', '-U', 'agentfiles', '-d', 'agentfiles', '-v', 'ON_ERROR_STOP=1', '-c', `UPDATE files SET expires_at=clock_timestamp()-interval '1 second' WHERE code='${file.code}'`]);
    const expired = await fetch(`${endpoint}/api/files/${file.code}`, { headers: { authorization: `Bearer ${downloadOnly.secret}` }, redirect: 'error' });
    assert.equal(expired.status, 410);
    record('actual scoped permission denials and fixture-only SQL expiry blocks new metadata before cleanup');
  } finally {
    await command(['image', 'rm', image], { allowFailure: true });
  }
}
