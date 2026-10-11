import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import argon2 from 'argon2';
import { createSetupFile } from '../../scripts/setup-lib.mjs';

interface SetupOptions {
  directory: string;
  input: { mode: string; origin: string; adminName: string; password: string; confirmation: string };
  hashPassword: (password: string) => Promise<string>;
  randomBytes: (size: number) => Buffer;
}
const setupFixture = (directory: string, password = 'synthetic password one'): SetupOptions => ({
  directory,
  input: { mode: 'local', origin: 'http://localhost:3000', adminName: 'synthetic admin', password, confirmation: password },
  hashPassword: (value) => argon2.hash(value, { type: argon2.argon2id }), randomBytes,
});
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'agentfiles-setup-')); });
afterEach(async () => {
  const target = resolve(root);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1)?.startsWith('agentfiles-setup-')) throw new Error('Unsafe test cleanup');
  await rm(target, { recursive: true, force: true });
});

describe('exclusive setup configuration', () => {
  it('creates independent secrets and a verifiable Argon2id password hash', async () => {
    const other = join(root, 'other'); await mkdir(other);
    await createSetupFile(setupFixture(root)); await createSetupFile(setupFixture(other));
    const first = parseEnv(await readFile(join(root, '.env'), 'utf8'));
    const second = parseEnv(await readFile(join(other, '.env'), 'utf8'));
    expect(first.SESSION_SECRET).toMatch(/^[a-f0-9]{64}$/);
    expect(first.POSTGRES_PASSWORD).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set([first.SESSION_SECRET, second.SESSION_SECRET, first.POSTGRES_PASSWORD, second.POSTGRES_PASSWORD]).size).toBe(4);
    expect(await argon2.verify(first.ADMIN_PASSWORD_HASH, 'synthetic password one')).toBe(true);
    expect(first.ADMIN_PASSWORD_HASH).toMatch(/^\$argon2id\$/);
    expect(first.POSTGRES_USER).toBe('agentfiles'); expect(first.POSTGRES_DB).toBe('agentfiles');
    expect(new URL(first.DATABASE_URL).hostname).toBe('db');
    expect(new URL(first.DATABASE_URL).password).toBe(first.POSTGRES_PASSWORD);
    expect(first.STORAGE_ROOT).toBe('/data/storage');
    if (process.platform !== 'win32') expect((await stat(join(root, '.env'))).mode & 0o777).toBe(0o600);
  });
  it('refuses replacement and preserves the first file', async () => {
    await createSetupFile(setupFixture(root)); const first = await readFile(join(root, '.env'), 'utf8');
    await expect(createSetupFile(setupFixture(root, 'synthetic password two'))).rejects.toThrow(/exists/);
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(first);
  });
  it('permits exactly one simultaneous writer', async () => {
    const results = await Promise.allSettled([createSetupFile(setupFixture(root)), createSetupFile(setupFixture(root, 'synthetic password two'))]);
    expect(results.filter(r => r.status === 'fulfilled')).length(1);
    const value = parseEnv(await readFile(join(root, '.env'), 'utf8'));
    expect(await argon2.verify(value.ADMIN_PASSWORD_HASH, 'synthetic password one') || await argon2.verify(value.ADMIN_PASSWORD_HASH, 'synthetic password two')).toBe(true);
  });
  it('preserves literal dollars, hashes, spaces, double quotes and backslashes', async () => {
    const fixture = setupFixture(root); fixture.input.adminName = 'literal $NAME # "quote" \\ slash';
    await createSetupFile(fixture);
    expect(parseEnv(await readFile(join(root, '.env'), 'utf8')).ADMIN_USERNAME).toBe(fixture.input.adminName);
  });
  it('canonicalizes a valid public origin using the shared origin policy', async () => {
    const fixture = setupFixture(root); fixture.input.mode = 'public'; fixture.input.origin = 'https://files.example/';
    await createSetupFile(fixture);
    expect(parseEnv(await readFile(join(root, '.env'), 'utf8')).PUBLIC_BASE_URL).toBe('https://files.example');
  });
  it.each([
    ['mode', 'other'], ['origin', 'http://files.example'], ['origin', 'https://synthetic:password@files.example'],
    ['adminName', ' '], ['adminName', 'x'.repeat(129)], ['adminName', "can't"], ['adminName', 'line\nnext'],
    ['adminName', 'nul\0byte'], ['password', 'short'], ['password', 'é'.repeat(513)], ['confirmation', 'different confirmation'],
    ['adminName', 'trailing\\'], ['adminName', 'trailing\\\\\\'],
  ])('rejects invalid %s without creating a file', async (key, value) => {
    const fixture = setupFixture(root); Object.assign(fixture.input, { [key]: value });
    await expect(createSetupFile(fixture)).rejects.toThrow(/Invalid setup/); expect(await readdir(root)).toEqual([]);
  });
  it('leaves no file when hashing fails and does not leak its error', async () => {
    const fixture = setupFixture(root); fixture.hashPassword = async () => { throw new Error(fixture.input.password); };
    await expect(createSetupFile(fixture)).rejects.toThrow(/^Unable to prepare setup configuration$/);
    expect(await readdir(root)).toEqual([]);
  });
  it('redacts filesystem errors without creating an output directory', async () => {
    await expect(createSetupFile(setupFixture(join(root, 'missing')))).rejects.toThrow(/^Unable to write setup configuration$/);
    expect(await readdir(root)).toEqual([]);
  });
  it('does not emit inputs or generated credentials', async () => {
    const stdout: string[] = [], stderr: string[] = [];
    const originalOut = process.stdout.write, originalErr = process.stderr.write;
    process.stdout.write = ((value: string) => { stdout.push(String(value)); return true; }) as typeof originalOut;
    process.stderr.write = ((value: string) => { stderr.push(String(value)); return true; }) as typeof originalErr;
    try { await createSetupFile(setupFixture(root)); } finally { process.stdout.write = originalOut; process.stderr.write = originalErr; }
    const values = parseEnv(await readFile(join(root, '.env'), 'utf8'));
    const output = stdout.join('') + stderr.join('');
    for (const secret of ['synthetic password one', values.ADMIN_PASSWORD_HASH, values.POSTGRES_PASSWORD, values.SESSION_SECRET]) expect(output).not.toContain(secret);
  });
  it('fails without a terminal and without writing or echoing supplied input', async () => {
    const result = spawnSync(process.execPath, ['scripts/setup.mjs', '--directory', root], { input: 'synthetic password one\n', encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/interactive terminal/);
    expect(result.stdout + result.stderr).not.toContain('synthetic password one'); expect(await readdir(root)).toEqual([]);
  });
  it('restores terminal mode and leaves no file on Ctrl+C', async () => {
    // A child-process terminal adapter makes cancellation deterministic on every
    // host. Real Linux and Docker Desktop terminal tests supplement this check.
    const adapter = join(root, 'terminal-adapter.mjs');
    await writeFile(adapter, `
      Object.defineProperty(process.stdin, 'isTTY', {value: true});
      Object.defineProperty(process.stdout, 'isTTY', {value: true});
      process.stdin.isRaw = false;
      process.stdin.setRawMode = (raw) => {
        process.stdin.isRaw = raw;
        if (!raw) process.stderr.write('Terminal restored\\n');
        return process.stdin;
      };
      process.stdin.resume = () => {
        queueMicrotask(() => process.stdin.emit('data', 'synthetic cancel secret\\x03'));
        return process.stdin;
      };
    `);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(adapter).href, 'scripts/setup.mjs', '--directory', root], { encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('Setup cancelled');
    expect(result.stderr).toContain('Terminal restored');
    expect(result.stdout + result.stderr).not.toContain('synthetic cancel secret');
    await expect(readFile(join(root, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
