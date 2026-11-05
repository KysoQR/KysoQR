import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getVneidDeps', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kysoqr-vneid-deps-'));
    vi.stubEnv('CMC_CA_HOST', 'https://csign.example.test');
    vi.stubEnv('CMC_CA_USERNAME', 'org01');
    vi.stubEnv('CMC_CA_PASSWORD', 'not-a-real-password');
    vi.stubEnv('VNEID_DB_PATH', path.join(dir, 'vneid.sqlite'));
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    (await import('./service')).resetVneidServiceForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('shares one CSign session and one database across copies of the module', async () => {
    const first = (await import('./service')).getVneidDeps();
    // What Next.js does when another route bundle loads its own copy.
    vi.resetModules();
    const second = (await import('./service')).getVneidDeps();
    expect(second).toBe(first);
    expect(second.csign).toBe(first.csign);
    expect(second.store).toBe(first.store);
  });
});
