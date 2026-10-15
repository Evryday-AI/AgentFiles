import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isolatedEnvironment, ownedChild, sanitizeDiagnostics } from '../../scripts/smoke-compose.mjs';

it('Docker context includes reviewed source but excludes nested secrets, runtime and tests', async () => {
  const scratch = resolve('.private/build-context-tests');
  await mkdir(scratch, { recursive: true });
  expect(await realpath(scratch)).toBe(scratch);
  const directory = ownedChild(scratch, `context-${randomBytes(8).toString('hex')}`);
  const context = ownedChild(directory, 'input');
  const inventory = ownedChild(directory, 'inventory');
  await mkdir(context, { recursive: true });
  const included = [
    'package.json', 'package-lock.json', 'Dockerfile', 'Dockerfile.setup',
    'tsconfig.json', 'tsconfig.client.json', 'vite.config.ts', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'scripts/setup.mjs', 'scripts/setup-lib.mjs', 'src/server/index.ts', 'src/server/config.ts',
    'src/server/migrations/001_initial.sql', 'src/client/main.tsx', 'src/client/api.ts',
    'src/client/styles.css', 'src/client/components/UploadPanel.tsx', 'skills/agentfiles/SKILL.md',
  ];
  const forbiddenNames = [
    '.env.local', '.private/provenance.ts', 'private/provenance.ts', 'config/settings.json',
    'storage/fixture.ts', 'uploads/fixture.ts', 'data/fixture.ts', 'backups/fixture.sql',
    'tests/fixture.ts', '__tests__/fixture.ts', 'unit.test.ts', 'unit.spec.ts',
    'node_modules/fixture.ts', '.codebase-memory/fixture.ts', '.playwright-mcp/fixture.ts',
    '.impeccable/fixture.ts', 'tmp/fixture.ts', '.git/config', 'fixture.log', 'fixture.dump',
  ];
  const excluded = ['.env.local', '.private/provenance.ts', 'tests/fixture.ts', 'scripts/private.mjs'];
  for (const parent of ['src/server', 'src/client', 'src/client/components', 'skills/agentfiles']) {
    for (const name of forbiddenNames) excluded.push(`${parent}/${name}`);
  }
  try {
    // All fixture bytes are newly authored, never copied from nested source dirs.
    for (const name of [...included, ...excluded]) {
      const path = ownedChild(context, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'Synthetic build-context fixture.\n');
    }
    await writeFile(join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /\n');
    await writeFile(join(context, '.dockerignore'), await readFile('.dockerignore', 'utf8'));
    const built = spawnSync('docker', ['build', '--progress=plain', '--output', `type=local,dest=${inventory}`, context], {
      env: isolatedEnvironment(process.env), encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024,
    });
    expect(built.status, sanitizeDiagnostics(built.stderr)).toBe(0);
    const files = [];
    async function collect(directory, prefix = '') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) await collect(join(directory, entry.name), `${name}/`);
        else files.push(name);
      }
    }
    await collect(inventory);
    expect(included.filter(name => !files.includes(name)), 'Required build inputs missing').toEqual([]);
    expect(excluded.filter(name => files.includes(name)), 'Forbidden nested context inputs leaked').toEqual([]);
  } finally {
    // Recheck containment and physical identity before recursive fixture removal.
    expect(await realpath(directory)).toBe(ownedChild(scratch, directory));
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
