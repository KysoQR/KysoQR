import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The store key: 32 random bytes generated on first start and kept in
 * `vneid.key` next to the database (owner-only permissions), then reused on
 * every later start. Nothing to configure.
 *
 * Whoever can read the database folder also gets the key, so that folder is
 * the thing to protect (systemd StateDirectory, mode 0700).
 *
 * An existing key file is never replaced: a new key would make every request
 * still in progress unreadable. A damaged file is reported instead (deleting
 * it is safe once no signing is in progress).
 */

export const KEY_FILE_NAME = 'vneid.key';
const MIN_SECRET_BYTES = 32;

export function decodeSecret(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length >= MIN_SECRET_BYTES ? bytes : undefined;
}

export function keyFilePath(dbPath: string): string {
  return path.join(path.dirname(path.resolve(dbPath)), KEY_FILE_NAME);
}

function readKeyFile(file: string): Buffer {
  const secret = decodeSecret(readFileSync(file, 'utf8').trim());
  if (!secret) {
    throw new Error(
      `${file} is not a valid VNeID key (delete it only if no signing is in progress)`
    );
  }
  return secret;
}

export function loadOrCreateLocalSecret(dbPath: string): {
  secret: Buffer;
  file: string;
  created: boolean;
} {
  // A throwaway in-memory database gets a throwaway key.
  if (dbPath === ':memory:') return { secret: randomBytes(32), file: ':memory:', created: true };
  const file = keyFilePath(dbPath);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    return { secret: readKeyFile(file), file, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    // 'wx': fails if another process created it meanwhile -- then use theirs.
    writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
    return { secret: readKeyFile(file), file, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return { secret: readKeyFile(file), file, created: false };
  }
}
