import { X509Certificate } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SoftIdentity } from '../pdfSign/testHelpers';
import type { TrustStore } from '../trustStore/TrustStore';
import {
  CertPolicyError,
  chooseCredential,
  evaluateCredentials,
  summarizeCredential,
  withPinnedRoot,
} from './certPolicy';
import { CITIZEN_PID, credentialOf, OTHER_PID, rootSha256Of, vneidIdentity } from './testKit';

const DAY = 86_400_000;

function failureOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof CertPolicyError) return error.failure;
    throw error;
  }
  return undefined;
}

describe('chooseCredential', () => {
  let identity: SoftIdentity;
  let options: { now: Date; trustStore: TrustStore };

  beforeAll(() => {
    identity = vneidIdentity();
    options = { now: new Date(), trustStore: identity.trustStore };
  });

  it('accepts a VNeID-like certificate for the CCCD that was entered', () => {
    const accepted = chooseCredential([credentialOf(identity)], CITIZEN_PID, options);
    expect(accepted.certificateDer.equals(identity.certificateDer)).toBe(true);
    expect(accepted.chainDer.map((der) => der.toString('hex'))).toEqual(
      identity.chainDer.map((der) => der.toString('hex'))
    );
    expect(accepted.rootTrusted).toBe(true);
    expect(accepted.signerName).toBe('Nguyen Van Test');
    expect(accepted.issuerCommonName).toBe('KysoQR Test Issuing CA');
  });

  it('refuses a certificate of another citizen', () => {
    expect(failureOf(() => chooseCredential([credentialOf(identity)], OTHER_PID, options))).toBe(
      'UID_MISMATCH'
    );
  });

  it('refuses when CSign would sign with another serial', () => {
    const credential = credentialOf(identity, { credentialId: 'ABCDEF' });
    expect(failureOf(() => chooseCredential([credential], CITIZEN_PID, options))).toBe(
      'SERIAL_MISMATCH'
    );
  });

  it('refuses inactive certificates and keys', () => {
    expect(
      failureOf(() =>
        chooseCredential([credentialOf(identity, { certStatus: 0 })], CITIZEN_PID, options)
      )
    ).toBe('CERT_NOT_ACTIVE');
    expect(
      failureOf(() =>
        chooseCredential([credentialOf(identity, { keyStatus: 'disabled' })], CITIZEN_PID, options)
      )
    ).toBe('CERT_NOT_ACTIVE');
  });

  it('refuses an expired certificate and a weak key', () => {
    const expired = vneidIdentity(CITIZEN_PID, {
      notBefore: new Date(Date.now() - 400 * DAY),
      notAfter: new Date(Date.now() - DAY),
    });
    expect(
      failureOf(() =>
        chooseCredential([credentialOf(expired)], CITIZEN_PID, {
          ...options,
          trustStore: expired.trustStore,
        })
      )
    ).toBe('EXPIRED');
    const weak = vneidIdentity(CITIZEN_PID, { keyBits: 1024 });
    expect(
      failureOf(() =>
        chooseCredential([credentialOf(weak)], CITIZEN_PID, {
          ...options,
          trustStore: weak.trustStore,
        })
      )
    ).toBe('KEY_UNSUPPORTED');
  });

  it('refuses an unreadable certificate', () => {
    const garbage = { ...credentialOf(identity), certificates: ['bm90IGEgY2VydA=='] };
    expect(failureOf(() => chooseCredential([garbage], CITIZEN_PID, options))).toBe(
      'CERT_MALFORMED'
    );
  });

  it('accepts a chain whose CA does not link up, says which link, and embeds nothing past it', () => {
    const credential = credentialOf(identity);
    // Leaf straight to the root, intermediate left out.
    const skipped = {
      ...credential,
      certificates: [credential.certificates[0]!, credential.certificates[2]!],
    };
    const accepted = chooseCredential([skipped], CITIZEN_PID, options);
    expect(accepted.chainVerified).toBe(false);
    expect(accepted.chainIssue).toBe('name-mismatch');
    expect(accepted.chainIssueDetail).toMatchObject({
      link: 0,
      check: 'name-mismatch',
      issuerCn: 'KysoQR Test Root CA',
      childIssuerCn: 'KysoQR Test Issuing CA',
    });
    expect(accepted.chainDer).toHaveLength(0);
    // The listed root IS in the trust store, but it is not this certificate's
    // root: it must not count as trusted.
    expect(accepted.rootDer).toBeUndefined();
    expect(accepted.rootTrusted).toBe(false);
    expect(accepted.issuerCommonName).toBe('KysoQR Test Issuing CA');
  });

  it('reports a same-name CA with another key (what the UAT gateway sends) as a signature mismatch', () => {
    // A CA certificate with the right name but another key: the certificate
    // was not signed by it.
    const other = vneidIdentity();
    const mine = credentialOf(identity);
    const theirs = credentialOf(other);
    const mixed = {
      ...mine,
      certificates: [mine.certificates[0]!, theirs.certificates[1]!, theirs.certificates[2]!],
    };
    const accepted = chooseCredential([mixed], CITIZEN_PID, {
      ...options,
      trustStore: other.trustStore,
    });
    expect(accepted.chainVerified).toBe(false);
    expect(accepted.chainIssueDetail).toMatchObject({
      link: 0,
      check: 'signature-mismatch',
      issuerCn: 'KysoQR Test Issuing CA',
      childIssuerCn: 'KysoQR Test Issuing CA',
    });
    expect(String(accepted.chainIssueDetail?.issuerValidTo)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(accepted.chainIssueDetail)).not.toContain('Nguyen Van Test');
    expect(accepted.chainDer).toHaveLength(0);
    expect(accepted.rootTrusted).toBe(false);
  });

  it('marks a chain that links up as verified', () => {
    const accepted = chooseCredential([credentialOf(identity)], CITIZEN_PID, options);
    expect(accepted.chainVerified).toBe(true);
    expect(accepted.chainIssue).toBeUndefined();
  });

  it('accepts a root outside the trust store (UAT) and says so, with CA data only', () => {
    const stranger = vneidIdentity();
    const accepted = chooseCredential([credentialOf(stranger)], CITIZEN_PID, options);
    expect(accepted.rootTrusted).toBe(false);
    expect(accepted.rootCommonName).toBe('KysoQR Test Root CA');
    expect(accepted.rootSha256).toBe(rootSha256Of(stranger));
  });

  it('accepts a chain that stops below an unknown root, without a root', () => {
    const stranger = vneidIdentity();
    const credential = credentialOf(stranger);
    const accepted = chooseCredential(
      [{ ...credential, certificates: credential.certificates.slice(0, 2) }],
      CITIZEN_PID,
      options
    );
    expect(accepted.rootDer).toBeUndefined();
    expect(accepted.rootTrusted).toBe(false);
    expect(accepted.chainDer).toHaveLength(1);
  });

  it('signs with the credential the user picked, and only if it passes', () => {
    const second = vneidIdentity();
    const credentials = [credentialOf(identity), credentialOf(second)];
    const picked = chooseCredential(
      credentials,
      CITIZEN_PID,
      options,
      credentials[1]!.credentialId
    );
    expect(picked.certificateDer.equals(second.certificateDer)).toBe(true);
    // Case and leading zeros do not matter.
    const lower = `00${credentials[1]!.credentialId.toLowerCase()}`;
    expect(chooseCredential(credentials, CITIZEN_PID, options, lower).credentialId).toBe(
      credentials[1]!.credentialId
    );
    expect(failureOf(() => chooseCredential(credentials, CITIZEN_PID, options, 'ABCDEF'))).toBe(
      'NO_CREDENTIAL'
    );
    const inactive = [credentialOf(identity), credentialOf(second, { certStatus: 0 })];
    expect(
      failureOf(() => chooseCredential(inactive, CITIZEN_PID, options, inactive[1]!.credentialId))
    ).toBe('CERT_NOT_ACTIVE');
  });

  it('evaluates every credential for the certificate list', () => {
    const results = evaluateCredentials(
      [credentialOf(identity), credentialOf(identity, { certStatus: 0 })],
      CITIZEN_PID,
      options
    );
    expect(results.map((entry) => [Boolean(entry.accepted), entry.failure?.failure])).toEqual([
      [true, undefined],
      [false, 'CERT_NOT_ACTIVE'],
    ]);
    expect(summarizeCredential(credentialOf(identity))).toMatchObject({
      issuerCn: 'KysoQR Test Issuing CA',
      keyBits: 2048,
    });
  });

  it('finds the root in the trust store when CSign leaves it out of the list', () => {
    const credential = credentialOf(identity);
    const withoutRoot = { ...credential, certificates: credential.certificates.slice(0, 2) };
    const accepted = chooseCredential([withoutRoot], CITIZEN_PID, options);
    expect(accepted.chainDer).toHaveLength(1);
  });

  it('prefers a valid credential, and the one valid longest', () => {
    const soon = vneidIdentity(CITIZEN_PID, { notAfter: new Date(Date.now() + 10 * DAY) });
    const later = vneidIdentity(CITIZEN_PID, { notAfter: new Date(Date.now() + 300 * DAY) });
    const trustBoth: TrustStore = {
      isConfigured: () => true,
      isTrustedRoot: (pem) =>
        soon.trustStore.isTrustedRoot(pem) || later.trustStore.isTrustedRoot(pem),
      getTrustedRootPems: () => [soon.rootPem, later.rootPem],
    };
    const chosen = chooseCredential(
      [credentialOf(identity, { certStatus: 0 }), credentialOf(soon), credentialOf(later)],
      CITIZEN_PID,
      { ...options, trustStore: trustBoth }
    );
    expect(chosen.certificateDer.equals(later.certificateDer)).toBe(true);
    expect(failureOf(() => chooseCredential([], CITIZEN_PID, options))).toBe('NO_CREDENTIAL');
  });
});

describe('withPinnedRoot', () => {
  it('adds one root to a trust store', () => {
    const a = vneidIdentity();
    const b = vneidIdentity();
    const rootDer = new X509Certificate(b.rootPem).raw;
    const store = withPinnedRoot(a.trustStore, rootDer);
    expect(store.isTrustedRoot(b.rootPem)).toBe(true);
    expect(store.isTrustedRoot(a.rootPem)).toBe(true);
    expect(store.getTrustedRootPems()).toHaveLength(2);
    expect(withPinnedRoot(a.trustStore, undefined)).toBe(a.trustStore);
  });
});
