import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyFilePath, loadOrCreateLocalSecret } from './localSecret';

describe('loadOrCreateLocalSecret', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kysoqr-vneid-key-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates a key next to the database once, then reuses it', () => {
    const dbPath = path.join(dir, 'nested', 'vneid.sqlite');
    const first = loadOrCreateLocalSecret(dbPath);
    expect(first.created).toBe(true);
    expect(first.secret).toHaveLength(32);
    expect(first.file).toBe(path.join(dir, 'nested', 'vneid.key'));
    expect(readFileSync(first.file, 'utf8').trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== 'win32') expect(statSync(first.file).mode & 0o777).toBe(0o600);

    const second = loadOrCreateLocalSecret(dbPath);
    expect(second.created).toBe(false);
    expect(second.secret.equals(first.secret)).toBe(true);
  });

  it('never replaces a damaged key file', () => {
    const dbPath = path.join(dir, 'vneid.sqlite');
    mkdirSync(dir, { recursive: true });
    writeFileSync(keyFilePath(dbPath), 'too short');
    expect(() => loadOrCreateLocalSecret(dbPath)).toThrow(/not a valid VNeID key/);
    expect(readFileSync(keyFilePath(dbPath), 'utf8')).toBe('too short');
  });

  it('gives an in-memory database a throwaway key', () => {
    const a = loadOrCreateLocalSecret(':memory:');
    const b = loadOrCreateLocalSecret(':memory:');
    expect(a.secret.equals(b.secret)).toBe(false);
  });
});
