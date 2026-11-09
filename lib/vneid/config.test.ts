import { describe, expect, it } from 'vitest';
import { parseVneidConfig, VneidConfigError } from './config';

const base = {
  CMC_CA_HOST: 'https://csign.example.test',
  CMC_CA_USERNAME: 'org01',
  CMC_CA_PASSWORD: ' secret with spaces ',
  VNEID_DB_PATH: './.data/vneid.sqlite',
};

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    parseVneidConfig(env);
  } catch (error) {
    if (error instanceof VneidConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('parseVneidConfig', () => {
  it('reads a minimal configuration, with defaults only for tuning numbers', () => {
    const config = parseVneidConfig(base);
    expect(config.csign).toEqual({
      baseUrl: 'https://csign.example.test',
      username: 'org01',
      password: ' secret with spaces ',
    });
    expect(config.webhook).toBeUndefined();
    expect(config).toMatchObject({
      dailyCap: 5000,
      auditDays: 90,
      requireCode: false,
      tsaUrls: ['http://timestamp.digicert.com', 'https://timestamp.sectigo.com'],
    });
  });

  it('timestamps with two public TSAs by default, others, one, or none', () => {
    const tsaUrls = (env: Record<string, string>) => parseVneidConfig({ ...base, ...env }).tsaUrls;
    expect(tsaUrls({ TSA_URL: '', TSA_FALLBACK_URL: '' })).toEqual([
      'http://timestamp.digicert.com',
      'https://timestamp.sectigo.com',
    ]);
    expect(
      tsaUrls({ TSA_URL: 'https://tsa.example.test/tsr', TSA_FALLBACK_URL: 'http://tsa2.test' })
    ).toEqual(['https://tsa.example.test/tsr', 'http://tsa2.test']);
    expect(tsaUrls({ TSA_FALLBACK_URL: 'off' })).toEqual(['http://timestamp.digicert.com']);
    expect(tsaUrls({ TSA_URL: 'https://timestamp.sectigo.com' })).toEqual([
      'https://timestamp.sectigo.com',
    ]);
    expect(tsaUrls({ TSA_URL: 'off', TSA_FALLBACK_URL: 'http://tsa2.test' })).toEqual([]);
    for (const bad of ['ftp://tsa.example.test', 'http://user:pw@tsa.example.test', 'tsa']) {
      expect(problemsOf({ ...base, TSA_URL: bad }).some((p) => p.startsWith('TSA_URL'))).toBe(true);
      expect(
        problemsOf({ ...base, TSA_FALLBACK_URL: bad }).some((p) => p.startsWith('TSA_FALLBACK_URL'))
      ).toBe(true);
    }
  });

  it('names every missing variable without echoing any value', () => {
    const problems = problemsOf({ CMC_CA_PASSWORD: 'hunter2-should-not-leak' });
    for (const name of ['CMC_CA_HOST', 'CMC_CA_USERNAME']) {
      expect(problems.some((problem) => problem.startsWith(name))).toBe(true);
    }
    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).not.toContain('hunter2');
  });

  it('needs only the CSign host and credentials; the database path has a default', () => {
    const config = parseVneidConfig({
      CMC_CA_HOST: base.CMC_CA_HOST,
      CMC_CA_USERNAME: base.CMC_CA_USERNAME,
      CMC_CA_PASSWORD: base.CMC_CA_PASSWORD,
      VNEID_DB_PATH: '',
    });
    expect(config.dbPath).toBe('./.data/vneid.sqlite');
  });

  it('treats `KEY=` (empty) as unset', () => {
    expect(problemsOf({ ...base, CMC_CA_USERNAME: '' })).toEqual([
      expect.stringMatching(/^CMC_CA_USERNAME/),
    ]);
  });

  it('requires an https base URL without credentials, query or fragment', () => {
    for (const host of [
      'http://csign.example.test',
      'https://user:pw@csign.example.test',
      'https://csign.example.test/?x=1',
      'not a url',
    ]) {
      expect(problemsOf({ ...base, CMC_CA_HOST: host })).toEqual([
        expect.stringMatching(/^CMC_CA_HOST/),
      ]);
    }
  });

  it('enables the webhook only with both the organization id and the secret', () => {
    expect(problemsOf({ ...base, CSIGN_WEBHOOK_SECRET: 'whsec_x' })).toHaveLength(1);
    const config = parseVneidConfig({
      ...base,
      CSIGN_ORGANIZATION_ID: 'org-1',
      CSIGN_WEBHOOK_SECRET: 'whsec_now',
      CSIGN_WEBHOOK_SECRET_PREVIOUS: 'whsec_before',
    });
    expect(config.webhook).toEqual({
      organizationId: 'org-1',
      secrets: ['whsec_now', 'whsec_before'],
    });
  });

  it('validates the numbers and the code switch', () => {
    expect(problemsOf({ ...base, VNEID_DAILY_CAP: '0' })).toHaveLength(1);
    expect(parseVneidConfig({ ...base, VNEID_DAILY_CAP: '' }).dailyCap).toBe(5000);
    expect(problemsOf({ ...base, VNEID_AUDIT_DAYS: '1.5' })).toHaveLength(1);
    expect(problemsOf({ ...base, VNEID_REQUIRE_CODE: 'yes' })).toHaveLength(1);
    expect(parseVneidConfig({ ...base, VNEID_REQUIRE_CODE: 'true' }).requireCode).toBe(true);
  });

  it('asks query-status unless VNEID_QUERY_STATUS=off, which needs the webhook', () => {
    const webhook = { CSIGN_ORGANIZATION_ID: 'org-1', CSIGN_WEBHOOK_SECRET: 'whsec_now' };
    expect(parseVneidConfig(base).queryStatus).toBe(true);
    expect(parseVneidConfig({ ...base, VNEID_QUERY_STATUS: '' }).queryStatus).toBe(true);
    expect(parseVneidConfig({ ...base, ...webhook, VNEID_QUERY_STATUS: 'off' }).queryStatus).toBe(
      false
    );
    expect(problemsOf({ ...base, VNEID_QUERY_STATUS: 'off' })).toEqual([
      expect.stringMatching(/^VNEID_QUERY_STATUS is off but/),
    ]);
    expect(problemsOf({ ...base, VNEID_QUERY_STATUS: 'maybe' })).toEqual([
      expect.stringMatching(/^VNEID_QUERY_STATUS must be on or off/),
    ]);
  });
});
