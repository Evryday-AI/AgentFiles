import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

// A missing runner is a missing feature, so RED reports an assertion failure.
const runner = await import('../../scripts/smoke-compose.mjs').catch(() => null);

describe('Compose smoke isolation', () => {
  it('provides the isolated runner', () => {
    expect(runner).not.toBeNull();
  });
  it('rejects paths outside its dedicated scratch root', () => {
    expect(runner?.ownedChild(resolve('tmp/smoke'), 'run-one')).toBe(resolve('tmp/smoke/run-one'));
    expect(() => runner?.ownedChild(resolve('tmp/smoke'), '../other')).toThrow();
    expect(() => runner?.ownedChild(resolve('tmp/smoke'), '.')).toThrow();
  });
  it('strips ambient app, PG, Docker and Compose configuration', () => {
    const clean = runner?.isolatedEnvironment({ PATH: 'tools', DATABASE_URL: 'sentinel', PGHOST: 'sentinel', COMPOSE_FILE: 'sentinel', DOCKER_HOST: 'sentinel', ADMIN_USERNAME: 'sentinel', APP_PORT: '9', VITE_SECRET: 'sentinel' });
    expect(clean).toEqual({ PATH: 'tools' });
  });
  it('bounds diagnostics and masks fixture secrets, cookies and URLs', () => {
    const output = runner?.sanitizeDiagnostics('password-secret postgresql://user:pw@host/db /s/share-token\ncookie=secret-cookie', ['password-secret', 'secret-cookie']);
    expect(output).not.toContain('password-secret');
    expect(output).not.toContain('secret-cookie');
    expect(output).not.toContain('user:pw');
    expect(output).not.toContain('share-token');
    expect(runner?.sanitizeDiagnostics('x'.repeat(5000)).length).toBeLessThanOrEqual(4096);
  });
});
