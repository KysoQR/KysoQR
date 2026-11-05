import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOX, createSamplePdf } from '../pdfSign/testHelpers';
import { CsignError } from './csignClient';
import { VneidError } from './errors';
import { verifyPdfSignatures } from '../verification/verifyPdfSignatures';
import {
  finalizeSigning,
  getStatus,
  listCredentialsForCitizen,
  resetVneidServiceForTests,
  startSigning,
} from './service';
import { CITIZEN_PID, createTestContext, credentialOf, vneidIdentity } from './testKit';

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof VneidError) return error.code;
    throw error;
  }
  return undefined;
}

describe('certificate list and the certificate the user picks', () => {
  let pdf: Buffer;
  beforeAll(async () => {
    pdf = await createSamplePdf();
  });
  beforeEach(() => {
    resetVneidServiceForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists usable certificates first, with why the others cannot sign, and no personal data', async () => {
    const ctx = createTestContext();
    const inactive = credentialOf(vneidIdentity(), { certStatus: 0 });
    const usable = credentialOf(ctx.identity);
    ctx.csign.credentials = [inactive, usable];

    const views = await listCredentialsForCitizen(ctx.deps, CITIZEN_PID);
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({
      credentialId: usable.credentialId,
      issuer: 'KysoQR Test Issuing CA',
      keyBits: 2048,
      usable: true,
      rootTrusted: true,
    });
    expect(views[0]!.validTo).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(views[1]).toMatchObject({
      credentialId: inactive.credentialId,
      usable: false,
      reason: 'NOT_ACTIVE',
      rootTrusted: false,
    });
    const json = JSON.stringify(views);
    expect(json).not.toContain('Nguyen Van Test');
    expect(json).not.toContain(CITIZEN_PID);
  });

  it('reports a test root without refusing the certificate', async () => {
    const ctx = createTestContext();
    ctx.deps.trustStore = {
      isConfigured: () => true,
      isTrustedRoot: () => false,
      getTrustedRootPems: () => [],
    };
    const [view] = await listCredentialsForCitizen(ctx.deps, CITIZEN_PID);
    expect(view).toMatchObject({ usable: true, rootTrusted: false });
  });

  it('maps an empty list, CSign "no certificate" and a bad number to clear errors', async () => {
    const ctx = createTestContext();
    expect(await codeOf(() => listCredentialsForCitizen(ctx.deps, '123'))).toBe(
      'VNEID_INVALID_INPUT'
    );
    ctx.csign.credentials = [];
    expect(await codeOf(() => listCredentialsForCitizen(ctx.deps, CITIZEN_PID))).toBe(
      'VNEID_NO_CERTIFICATE'
    );
    ctx.csign.listCredentials = async () => {
      throw new CsignError('NO_CERTIFICATE', '/api/credentials/list', 'refused', { code: '04' });
    };
    expect(await codeOf(() => listCredentialsForCitizen(ctx.deps, CITIZEN_PID))).toBe(
      'VNEID_NO_CERTIFICATE'
    );
    ctx.csign.listCredentials = async () => {
      throw new CsignError('TIMEOUT', '/api/credentials/list', 'no answer in time');
    };
    expect(await codeOf(() => listCredentialsForCitizen(ctx.deps, CITIZEN_PID))).toBe(
      'VNEID_UPSTREAM'
    );
  });

  it('signs with exactly the certificate the user picked, after checking it again', async () => {
    const ctx = createTestContext();
    const other = credentialOf(vneidIdentity());
    ctx.csign.credentials = [credentialOf(ctx.identity), other];
    const start = (credentialId?: string) =>
      startSigning(ctx.deps, {
        pdf,
        fields: [BOX],
        citizenPid: CITIZEN_PID,
        language: 'vi',
        credentialId,
      });

    const started = await start(other.credentialId);
    expect(ctx.csign.lastRequest.credentialId).toBe(other.credentialId);
    expect(started.documentName).toBe(ctx.csign.lastRequest.documentName);

    const second = createTestContext();
    second.csign.credentials = [credentialOf(second.identity)];
    expect(
      await codeOf(() =>
        startSigning(second.deps, {
          pdf,
          fields: [BOX],
          citizenPid: CITIZEN_PID,
          language: 'vi',
          credentialId: 'ABCDEF0123',
        })
      )
    ).toBe('VNEID_NO_CERTIFICATE');

    const third = createTestContext();
    const blocked = credentialOf(third.identity, { certStatus: 0 });
    third.csign.credentials = [blocked];
    expect(
      await codeOf(() =>
        startSigning(third.deps, {
          pdf,
          fields: [BOX],
          citizenPid: CITIZEN_PID,
          language: 'vi',
          credentialId: blocked.credentialId,
        })
      )
    ).toBe('VNEID_CERT_INVALID');
    expect(second.csign.signRequests).toHaveLength(0);
    expect(third.csign.signRequests).toHaveLength(0);
  });

  it('signs with a certificate whose CA chain from CSign does not link up (UAT), with a warning', async () => {
    // What CSign UAT does with CMC certificates: the certificate is listed
    // with another CA's certificates (same name here, another key).
    const ctx = createTestContext();
    const own = credentialOf(ctx.identity);
    const foreign = credentialOf(vneidIdentity());
    ctx.csign.credentials = [
      { ...own, certificates: [own.certificates[0]!, ...foreign.certificates.slice(1)] },
    ];
    const warnings: string[] = [];
    vi.mocked(console.warn).mockImplementation((...args: unknown[]) => {
      warnings.push(
        args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
      );
    });

    const [view] = await listCredentialsForCitizen(ctx.deps, CITIZEN_PID);
    expect(view).toMatchObject({
      usable: true,
      chainVerified: false,
      chainIssue: 'signature-mismatch',
      rootTrusted: false,
    });

    const started = await startSigning(ctx.deps, {
      pdf,
      fields: [BOX],
      citizenPid: CITIZEN_PID,
      language: 'vi',
      credentialId: own.credentialId,
    });
    expect(warnings.some((line) => line.includes('does not link up'))).toBe(true);
    const ticket = { transactionId: started.transactionId, clientSecret: started.clientSecret };
    ctx.csign.complete();
    expect((await getStatus(ctx.deps, ticket)).status).toBe('SIGNED');
    const signed = await finalizeSigning(ctx.deps, { ...ticket, original: pdf });

    const [result] = await verifyPdfSignatures(signed, ctx.identity.trustStore);
    // The signature and the content are fine; only the CA chain is missing.
    expect(result!.contentIntact).toBe(true);
    expect(['SIGNED_VALID', 'ROOT_NOT_TRUSTED', 'CHAIN_VALIDATION_FAILED']).toContain(
      result!.status
    );
    expect(warnings.join('\n')).not.toContain('Nguyen Van Test');
  });
});
