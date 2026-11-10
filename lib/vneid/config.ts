import { z } from 'zod';

/**
 * Configuration of the VNeID signing feature, read from the environment.
 *
 * Kept apart from lib/env.ts on purpose: that schema makes every variable
 * required for the CAS routes, and VNeID is optional -- with these variables
 * missing the VNeID routes answer VNEID_NOT_CONFIGURED and CAS keeps working.
 * As Rule/RULES.md asks, the CSign host and credentials have no default in
 * source. The database path has one (./.data/vneid.sqlite, git-ignored), and
 * the store key is not configured at all: it is generated once and kept next
 * to the database (lib/vneid/localSecret.ts). A setup needs only those three
 * variables. The timestamp authorities have public defaults too: TSA_URL, and
 * TSA_FALLBACK_URL asked when the first one fails (`off` turns either off;
 * TSA_URL=off signs without timestamps at all).
 *
 * Error messages name the variable and the rule it breaks, never its value.
 */

export interface VneidConfig {
  csign: { baseUrl: string; username: string; password: string };
  /** Present only when both the organization id and the webhook secret are set;
   * without it signing still works (query-status), the webhook route is off. */
  webhook: { organizationId: string; secrets: string[] } | undefined;
  dbPath: string;
  /** Sign requests that reach CSign, and certificate lookups, per 24 hours (each). */
  dailyCap: number;
  auditDays: number;
  requireCode: boolean;
  /** RFC 3161 timestamp authorities, asked in this order; empty = signatures
   * carry no timestamp. */
  tsaUrls: string[];
  /** false (VNEID_QUERY_STATUS=off): CSign is never asked with query-status,
   * results arrive by webhook only. For checking the webhook. */
  queryStatus: boolean;
}

export class VneidConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid VNeID configuration: ${problems.join('; ')}`);
    this.name = 'VneidConfigError';
    this.problems = problems;
  }
}

export const DEFAULT_DB_PATH = './.data/vneid.sqlite';
/** Public, free, trusted by Adobe Reader; any RFC 3161 TSA can replace it. */
export const DEFAULT_TSA_URL = 'http://timestamp.digicert.com';
/** Asked when the first TSA fails; also public, free and trusted by Adobe. */
export const DEFAULT_TSA_FALLBACK_URL = 'https://timestamp.sectigo.com';

/** `KEY=` in a .env file arrives as an empty string: treat it as unset. */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** Checked, not trimmed: a password may legitimately start or end with a space. */
const required = z
  .string({ error: 'is required' })
  .refine((value) => value.trim() !== '', 'is required');
const optionalText = z.preprocess(blankToUndefined, z.string().trim().optional());

function optionalInt(min: number, max: number, fallback: number) {
  return z.preprocess(
    blankToUndefined,
    z.coerce
      .number()
      .int(`must be a whole number between ${min} and ${max}`)
      .min(min, `must be a whole number between ${min} and ${max}`)
      .max(max, `must be a whole number between ${min} and ${max}`)
      .default(fallback)
  );
}

/** TSAs commonly answer on plain http: the token is signed, and lib/vneid/tsa.ts
 * accepts it only from a time-stamping certificate that chains to a trusted root. */
function isTsaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

/** A TSA URL or `off`; blank means `fallback`. */
function tsaSetting(fallback: string) {
  return z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .refine(
        (value) => value === 'off' || isTsaUrl(value),
        'must be an http(s):// URL without credentials or fragment, or off'
      )
      .default(fallback)
  );
}

function isHttpsBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

const schema = z
  .object({
    CMC_CA_HOST: required.refine(
      isHttpsBaseUrl,
      'must be an https:// URL without credentials, query or fragment'
    ),
    CMC_CA_USERNAME: required,
    CMC_CA_PASSWORD: required,
    VNEID_DB_PATH: z.preprocess(blankToUndefined, z.string().default(DEFAULT_DB_PATH)),
    VNEID_DAILY_CAP: optionalInt(1, 1_000_000, 5000),
    VNEID_AUDIT_DAYS: optionalInt(1, 3650, 90),
    VNEID_REQUIRE_CODE: z.preprocess(
      blankToUndefined,
      z.enum(['true', 'false'], { message: 'must be true or false' }).default('false')
    ),
    TSA_URL: tsaSetting(DEFAULT_TSA_URL),
    TSA_FALLBACK_URL: tsaSetting(DEFAULT_TSA_FALLBACK_URL),
    VNEID_QUERY_STATUS: z.preprocess(
      blankToUndefined,
      z.enum(['on', 'off'], { message: 'must be on or off' }).default('on')
    ),

    CSIGN_ORGANIZATION_ID: optionalText,
    CSIGN_WEBHOOK_SECRET: optionalText,
    CSIGN_WEBHOOK_SECRET_PREVIOUS: optionalText,
  })
  .refine(
    (env) => (env.CSIGN_ORGANIZATION_ID === undefined) === (env.CSIGN_WEBHOOK_SECRET === undefined),
    {
      message: 'set both CSIGN_ORGANIZATION_ID and CSIGN_WEBHOOK_SECRET, or neither',
      path: ['CSIGN_WEBHOOK_SECRET'],
    }
  )
  .refine((env) => env.VNEID_QUERY_STATUS === 'on' || env.CSIGN_WEBHOOK_SECRET !== undefined, {
    message:
      'is off but CSIGN_ORGANIZATION_ID / CSIGN_WEBHOOK_SECRET are not set: results only come by webhook',
    path: ['VNEID_QUERY_STATUS'],
  });

export function parseVneidConfig(env: Record<string, string | undefined>): VneidConfig {
  const parsed = schema.safeParse({
    CMC_CA_HOST: env.CMC_CA_HOST,
    CMC_CA_USERNAME: env.CMC_CA_USERNAME,
    CMC_CA_PASSWORD: env.CMC_CA_PASSWORD,
    VNEID_DB_PATH: env.VNEID_DB_PATH,
    VNEID_DAILY_CAP: env.VNEID_DAILY_CAP,
    VNEID_AUDIT_DAYS: env.VNEID_AUDIT_DAYS,
    VNEID_REQUIRE_CODE: env.VNEID_REQUIRE_CODE,
    TSA_URL: env.TSA_URL,
    TSA_FALLBACK_URL: env.TSA_FALLBACK_URL,
    VNEID_QUERY_STATUS: env.VNEID_QUERY_STATUS,

    CSIGN_ORGANIZATION_ID: env.CSIGN_ORGANIZATION_ID,
    CSIGN_WEBHOOK_SECRET: env.CSIGN_WEBHOOK_SECRET,
    CSIGN_WEBHOOK_SECRET_PREVIOUS: env.CSIGN_WEBHOOK_SECRET_PREVIOUS,
  });
  if (!parsed.success) {
    throw new VneidConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'} ${issue.message}`)
    );
  }
  const data = parsed.data;
  const webhookSecrets = [data.CSIGN_WEBHOOK_SECRET, data.CSIGN_WEBHOOK_SECRET_PREVIOUS].filter(
    (value): value is string => value !== undefined
  );
  return {
    csign: {
      baseUrl: data.CMC_CA_HOST,
      username: data.CMC_CA_USERNAME,
      password: data.CMC_CA_PASSWORD,
    },
    webhook:
      data.CSIGN_ORGANIZATION_ID !== undefined && data.CSIGN_WEBHOOK_SECRET !== undefined
        ? { organizationId: data.CSIGN_ORGANIZATION_ID, secrets: webhookSecrets }
        : undefined,
    dbPath: data.VNEID_DB_PATH,
    dailyCap: data.VNEID_DAILY_CAP,
    auditDays: data.VNEID_AUDIT_DAYS,
    requireCode: data.VNEID_REQUIRE_CODE === 'true',
    // TSA_URL=off turns timestamps off altogether; the same URL twice is asked once.
    tsaUrls:
      data.TSA_URL === 'off'
        ? []
        : [...new Set([data.TSA_URL, data.TSA_FALLBACK_URL])].filter((url) => url !== 'off'),
    queryStatus: data.VNEID_QUERY_STATUS === 'on',
  };
}

let cached: VneidConfig | undefined;

/** Parsed once, on first use. Throws VneidConfigError when something is missing. */
export function getVneidConfig(): VneidConfig {
  cached ??= parseVneidConfig(process.env);
  return cached;
}

/** Test-only: forget the cached configuration. */
export function resetVneidConfigForTests(): void {
  cached = undefined;
}
