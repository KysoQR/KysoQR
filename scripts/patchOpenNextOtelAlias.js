#!/usr/bin/env node
// OpenNext's Node middleware bundler aliases `@opentelemetry/api` to Next's
// compiled copy only when the app has not installed the real package.
// `@scalar/api-reference` pulls the real package in (via `ai`), so the alias
// is skipped. Next's file trace then copies `package.json` plus the CJS
// build, and esbuild — which resolves the `module` condition — looks for
// `build/esm/index.js` and fails.
//
// The middleware does not need a real tracer. Always point the import at
// Next's self-contained compiled build, which is what OpenNext already does
// for the server bundle.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLER = path.join(
  'node_modules',
  '@opennextjs',
  'cloudflare',
  'dist',
  'cli',
  'build',
  'open-next',
  'bundle-node-middleware.js',
);

export const OTEL_ALIAS_NEEDLE =
  '...(hasOpentelemetry ? {} : { "@opentelemetry/api": "next/dist/compiled/@opentelemetry/api" }),';

export const OTEL_ALIAS_REPLACEMENT =
  '"@opentelemetry/api": path.join(options.appBuildOutputPath, "node_modules", "next", "dist", "compiled", "@opentelemetry", "api", "index.js"),';

export function patchOpenNextOtelAlias(source) {
  if (source.includes(OTEL_ALIAS_REPLACEMENT)) {
    return { source, changed: false };
  }
  if (!source.includes(OTEL_ALIAS_NEEDLE)) {
    throw new Error(
      `Could not patch ${BUNDLER}: the OpenTelemetry alias site changed. Update scripts/patchOpenNextOtelAlias.js.`,
    );
  }
  return {
    source: source.replace(OTEL_ALIAS_NEEDLE, OTEL_ALIAS_REPLACEMENT),
    changed: true,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filePath = path.join(process.cwd(), BUNDLER);
  const result = patchOpenNextOtelAlias(readFileSync(filePath, 'utf8'));
  if (result.changed) {
    writeFileSync(filePath, result.source);
  }
}
