import { describe, expect, it } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
const runner = await import('../../scripts/smoke-compose.mjs');

describe('smoke process archive input', () => {
  it('feeds a protected binary file to stdin without changing its bytes', async () => {
    expect(typeof runner.captureCommand).toBe('function');
    const directory = await mkdtemp(join(tmpdir(), 'agentfiles-input-'));
    try {
      const archive = join(directory, 'archive');
      const bytes = randomBytes(256 * 1024 + 37);
      await writeFile(archive, bytes, { mode: 0o600 });
      const result = await runner.captureCommand(process.execPath, ['-e', "const h=require('node:crypto').createHash('sha256');process.stdin.on('data',c=>h.update(c));process.stdin.on('end',()=>process.stdout.write(h.digest('hex')));"], { inputFile: archive });
      if (process.platform !== 'win32') expect((await stat(archive)).mode & 0o777).toBe(0o600);
      expect(result.code).toBe(0);
      expect(result.output).toBe(createHash('sha256').update(bytes).digest('hex'));
    } finally {
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !target.startsWith(join(resolve(tmpdir()), 'agentfiles-input-'))) throw new Error('Unowned input fixture cleanup refused');
      await rm(target, { recursive: true });
    }
  });
  it('retains nonzero child status and diagnostics with file input', async () => {
    expect(typeof runner.captureCommand).toBe('function');
    const result = await runner.captureCommand(process.execPath, ['-e', "process.stderr.write('synthetic rejection');process.exit(7)"], { inputFile: new URL(import.meta.url) });
    expect(result).toEqual({ code: 7, output: 'synthetic rejection' });
  });
  it('rejects missing archive input before running the child', async () => {
    expect(typeof runner.captureCommand).toBe('function');
    await expect(runner.captureCommand(process.execPath, ['-e', 'process.exit(0)'], { inputFile: new URL('./absent-archive-fixture', import.meta.url) })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
