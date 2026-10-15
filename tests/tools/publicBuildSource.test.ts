import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isolatedEnvironment } from '../../scripts/smoke-compose.mjs';
const operations = await import('../../scripts/operations-compose.mjs') as any;

it('materializes only fresh owned public build source without changing private siblings', async () => {
  expect(operations.materializePublicBuildSource).toBeTypeOf('function');
  const parent = await mkdtemp(join(tmpdir(), 'agentfiles-public-build-'));
  try {
    const target = join(parent, 'source');
    const secret = join(parent, '.env'); await writeFile(secret, 'synthetic-private', { mode: 0o600 });
    await operations.materializePublicBuildSource(target, [['package.json', Buffer.from('{"type":"module"}\n')], ['src/server/migrations/001.sql', Buffer.from('SELECT 1;\n')]]);
    expect(await readFile(join(target, 'src/server/migrations/001.sql'), 'utf8')).toBe('SELECT 1;\n');
    expect(await readFile(secret, 'utf8')).toBe('synthetic-private');
    await expect(operations.materializePublicBuildSource(parent, [])).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(operations.materializePublicBuildSource(join(parent, 'escape-check'), [['../outside', Buffer.from('forbidden')]])).rejects.toThrow('escapes owned root');
  } finally {
    if (dirname(resolve(parent)) !== resolve(tmpdir()) || !resolve(parent).startsWith(join(resolve(tmpdir()), 'agentfiles-public-build-'))) throw new Error('Unowned public build cleanup refused');
    await rm(parent, { recursive: true });
  }
});

it.skipIf(process.platform === 'win32')('preserves public readability and private modes under a real umask077 child', async () => {
  expect(operations.materializePublicBuildSource).toBeTypeOf('function');
  const parent = await mkdtemp(join(tmpdir(), 'agentfiles-public-build-'));
  try {
    const source = `import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {join} from 'node:path';import {materializePublicBuildSource} from ${JSON.stringify(pathToFileURL(resolve('scripts/operations-compose.mjs')).href)};process.umask(0o077);const parent=process.argv[1];await fs.chmod(parent,0o700);const secret=join(parent,'.env');await fs.writeFile(secret,'synthetic-private',{mode:0o600});const target=join(parent,'source');await materializePublicBuildSource(target,[['package.json',Buffer.from('{}')],['src/server/migrations/001.sql',Buffer.from('SELECT 1;')],['skills/agentfiles/SKILL.md',Buffer.from('public')],['LICENSE',Buffer.from('public')]]);for(const path of ['','src','src/server','src/server/migrations','skills','skills/agentfiles'])assert.equal((await fs.stat(join(target,path))).mode&0o777,0o755);for(const path of ['package.json','src/server/migrations/001.sql','skills/agentfiles/SKILL.md','LICENSE'])assert.equal((await fs.stat(join(target,path))).mode&0o777,0o644);assert.equal((await fs.stat(parent)).mode&0o777,0o700);assert.equal((await fs.stat(secret)).mode&0o777,0o600);`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, parent], { env: isolatedEnvironment(process.env), encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
  } finally {
    if (dirname(resolve(parent)) !== resolve(tmpdir()) || !resolve(parent).startsWith(join(resolve(tmpdir()), 'agentfiles-public-build-'))) throw new Error('Unowned public build cleanup refused');
    await rm(parent, { recursive: true });
  }
});
