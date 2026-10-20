import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  OTEL_ALIAS_NEEDLE,
  OTEL_ALIAS_REPLACEMENT,
  patchOpenNextOtelAlias,
} from './patchOpenNextOtelAlias.js';

describe('patchOpenNextOtelAlias', () => {
  it('points the middleware bundler at Next’s compiled OpenTelemetry API', () => {
    const source = `alias: {\n  ${OTEL_ALIAS_NEEDLE}\n}`;
    const result = patchOpenNextOtelAlias(source);
    expect(result.changed).toBe(true);
    expect(result.source).toContain(OTEL_ALIAS_REPLACEMENT);
    expect(result.source).not.toContain(OTEL_ALIAS_NEEDLE);
  });

  it('is idempotent once the alias is absolute', () => {
    const source = `alias: {\n  ${OTEL_ALIAS_REPLACEMENT}\n}`;
    const result = patchOpenNextOtelAlias(source);
    expect(result.changed).toBe(false);
    expect(result.source).toBe(source);
  });

  it('fails when the OpenNext bundler no longer has the expected alias', () => {
    expect(() => patchOpenNextOtelAlias('alias: {}')).toThrow(/OpenTelemetry alias site changed/);
  });

  it('matches the installed OpenNext middleware bundler', () => {
    const installed = readFileSync(
      path.join(
        process.cwd(),
        'node_modules/@opennextjs/cloudflare/dist/cli/build/open-next/bundle-node-middleware.js',
      ),
      'utf8',
    );
    expect(installed.includes(OTEL_ALIAS_NEEDLE) || installed.includes(OTEL_ALIAS_REPLACEMENT)).toBe(
      true,
    );
  });
});
