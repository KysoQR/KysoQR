import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Keeps `public/openapi/{vi,en}.yaml` (served at /docs) in sync with the real
 * route handlers: an API change that forgets the spec fails here, not in
 * front of an integrator. Routes are discovered from `app/api/**\/route.ts`;
 * each route's error codes are read straight from its source and compared
 * with the `x-error-codes` lists on its responses.
 */

const ROOT = process.cwd();
const API_DIR = path.join(ROOT, 'app', 'api');
/** Internal UI helpers, deliberately left out of the public API docs (none today). */
const UNDOCUMENTED_ROUTES = new Set<string>();
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components: { responses: Record<string, Response>; schemas: Record<string, unknown> };
};
type Operation = { responses: Record<string, Response | { $ref: string }> };
type Response = { 'x-error-codes'?: string[] };

function loadSpec(lang: 'vi' | 'en'): Spec {
  return parse(readFileSync(path.join(ROOT, 'public', 'openapi', `${lang}.yaml`), 'utf8')) as Spec;
}

function findRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return findRouteFiles(full);
    return entry.name === 'route.ts' ? [full] : [];
  });
}

/** `app/api/verify/signing-round/[orgIdSigned]/route.ts` → `/api/verify/signing-round/{orgIdSigned}` */
function toApiPath(file: string): string {
  const relative = path.relative(path.join(ROOT, 'app'), path.dirname(file)).split(path.sep).join('/');
  return `/${relative.replace(/\[([^\]]+)\]/g, '{$1}')}`;
}

const routes = findRouteFiles(API_DIR)
  .map((file) => {
    const source = readFileSync(file, 'utf8');
    const methods = HTTP_METHODS.filter((m) =>
      new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(source)
    );
    const errorCodes = new Set<string>([
      ...[...source.matchAll(/error:\s*'([A-Z_]+)'/g)].map((m) => m[1]!),
      ...[...source.matchAll(/badRequest\(\s*'([A-Z_]+)'/g)].map((m) => m[1]!),
    ]);
    if (source.includes('rateLimitedResponse(')) errorCodes.add('RATE_LIMITED');
    return { apiPath: toApiPath(file), methods, errorCodes };
  })
  .filter((route) => !UNDOCUMENTED_ROUTES.has(route.apiPath));

function specErrorCodes(spec: Spec, operation: Operation): Set<string> {
  const codes = new Set<string>();
  for (const response of Object.values(operation.responses)) {
    const resolved =
      '$ref' in response
        ? spec.components.responses[response.$ref.replace('#/components/responses/', '')]!
        : response;
    for (const code of resolved['x-error-codes'] ?? []) codes.add(code);
  }
  return codes;
}

describe.each(['vi', 'en'] as const)('public/openapi/%s.yaml', (lang) => {
  const spec = loadSpec(lang);

  it('documents exactly the public routes under app/api', () => {
    expect(Object.keys(spec.paths).sort()).toEqual(routes.map((r) => r.apiPath).sort());
  });

  it.each(routes.map((r) => [r.apiPath, r] as const))('%s: methods and error codes match the code', (_p, route) => {
    const pathItem = spec.paths[route.apiPath]!;
    expect(Object.keys(pathItem).sort()).toEqual(route.methods.map((m) => m.toLowerCase()).sort());
    for (const method of route.methods) {
      const operation = pathItem[method.toLowerCase()]!;
      expect([...specErrorCodes(spec, operation)].sort()).toEqual([...route.errorCodes].sort());
    }
  });
});

describe('vi.yaml and en.yaml', () => {
  const vi = loadSpec('vi');
  const en = loadSpec('en');

  it('have the same operations, response codes and schemas', () => {
    const shape = (spec: Spec) =>
      Object.entries(spec.paths).flatMap(([p, item]) =>
        Object.entries(item).map(([method, op]) => `${method} ${p} ${Object.keys(op.responses).join(',')}`)
      );
    expect(shape(en)).toEqual(shape(vi));
    expect(Object.keys(en.components.schemas)).toEqual(Object.keys(vi.components.schemas));
    expect(Object.keys(en.components.responses)).toEqual(Object.keys(vi.components.responses));
  });
});
