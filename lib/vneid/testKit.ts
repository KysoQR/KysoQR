import { createHash, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { executePdfJob } from '../pdfSign/jobs';
import { createSoftIdentity, type SoftIdentity } from '../pdfSign/testHelpers';
import type { VneidConfig } from './config';
import { deriveKeys, hmacSha256 } from './crypto';
import type {
  CsignApi,
  CsignCredential,
  CsignProvider,
  QueryStatusResult,
  RegisterCredentialRequest,
  RegistrationStatusResult,
  SignHashRequest,
  SignHashResult,
} from './csignClient';
import type { PdfJobsApi, VneidDeps } from './service';
import { VneidStore } from './store';

/**
 * Test-only kit for lib/vneid: a VNeID-like software certificate, an
 * in-memory store, in-process PDF jobs, a controllable clock and a stand-in
 * for the CSign API that signs exactly like CSign is assumed to (RSA PKCS#1
 * v1.5 over DigestInfo(sha256, digestValue)). Never imported by app code.
 * There is no fake CSign server: real-world behaviour is checked on the
 * CSign UAT environment.
 */

export const CITIZEN_PID = '012345678901';
export const OTHER_PID = '079123456789';
export const ORGANIZATION_ID = 'org-test-0001';
export const WEBHOOK_SECRET = 'whsec_test_current_secret_value';
export const WEBHOOK_SECRET_PREVIOUS = 'whsec_test_previous_secret_value';

export const inProcessPdfJobs: PdfJobsApi = {
  analyze: (pdf) => executePdfJob('analyze', { pdf }),
  prepare: (input) => executePdfJob('prepare', input),
  finalize: (input) => executePdfJob('finalize', input),
};

const derBase64 = (der: Uint8Array) => Buffer.from(der).toString('base64');
const pemToDer = (pem: string) =>
  Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');

/** A VNeID-like identity: subject UID `CCCD:<pid>`, root -> issuing CA -> leaf. */
export function vneidIdentity(
  citizenPid = CITIZEN_PID,
  leaf?: { notBefore?: Date; notAfter?: Date; keyBits?: number }
): SoftIdentity {
  return createSoftIdentity({
    commonName: 'Nguyen Van Test',
    uid: `CCCD:${citizenPid}`,
    levels: 2,
    ...(leaf ? { leaf } : {}),
  });
}

/** credentials/list entry for an identity, as CSign lists it (leaf, CAs, root). */
export function credentialOf(
  identity: SoftIdentity,
  overrides: Partial<CsignCredential> = {}
): CsignCredential {
  const leaf = new X509Certificate(identity.certificateDer);
  return {
    credentialId: leaf.serialNumber,
    certificates: [
      derBase64(identity.certificateDer),
      ...identity.chainDer.map(derBase64),
      derBase64(pemToDer(identity.rootPem)),
    ],
    issuerDn: 'CN=KysoQR Test Issuing CA',
    serialNumber: leaf.serialNumber,
    validTo: undefined,
    certStatus: 1,
    keyStatus: 'enabled',
    keyAlgorithms: ['1.2.840.113549.1.1.11'],
    keyLength: 2048,
    ...overrides,
  };
}

export const rootSha256Of = (identity: SoftIdentity) =>
  createHash('sha256').update(pemToDer(identity.rootPem)).digest('hex');

export const forgeCertificate = (der: Uint8Array) =>
  forge.pki.certificateFromAsn1(forge.asn1.fromDer(Buffer.from(der).toString('binary')));

/**
 * Stand-in for the CSign API. Records every request; `sign()` produces the
 * signature for the last sign-hash the way CSign is expected to.
 */
export class CsignStandIn implements CsignApi {
  credentials: CsignCredential[];
  readonly signRequests: SignHashRequest[] = [];
  readonly statusQueries: string[] = [];
  signHashError: Error | undefined;
  queryError: Error | undefined;
  status: QueryStatusResult = {
    statusCode: 1,
    resultCode: undefined,
    errorCode: undefined,
    signatures: [],
  };
  providers: CsignProvider[] = [
    {
      provider: 'HUD-CMC-CA',
      name: 'CMC',
      status: 1,
      packs: [
        { code: 'VNEID-FREE-12M', name: 'Free 12 months', months: 12, unitPrice: 0, free: 0 },
        { code: 'CMC-24M', name: 'Paid 24 months', months: 24, unitPrice: 550_000, free: 0 },
      ],
    },
  ];
  readonly registerRequests: RegisterCredentialRequest[] = [];
  readonly registrationQueries: string[] = [];
  registerError: Error | undefined;
  registrationError: Error | undefined;
  registration: RegistrationStatusResult = {
    statusCode: 2,
    serialNumber: undefined,
    errorCode: undefined,
    resultCode: undefined,
  };
  private counter = 0;

  constructor(readonly identity: SoftIdentity) {
    this.credentials = [credentialOf(identity)];
  }

  async listCredentials(): Promise<CsignCredential[]> {
    return this.credentials;
  }

  async signHash(request: SignHashRequest): Promise<SignHashResult> {
    this.signRequests.push(request);
    if (this.signHashError) throw this.signHashError;
    this.counter += 1;
    return {
      transactionId: `csign-tx-${this.counter}`,
      rscaTransactionId: `29758797469712${this.counter}`,
    };
  }

  async queryStatus(transactionId: string): Promise<QueryStatusResult> {
    this.statusQueries.push(transactionId);
    if (this.queryError) throw this.queryError;
    return this.status;
  }

  async listProviders(): Promise<CsignProvider[]> {
    return this.providers;
  }

  async registerCredential(request: RegisterCredentialRequest): Promise<string> {
    this.registerRequests.push(request);
    if (this.registerError) throw this.registerError;
    return `ra-tx-${this.registerRequests.length}`;
  }

  async getRegistrationStatus(transactionCode: string): Promise<RegistrationStatusResult> {
    this.registrationQueries.push(transactionCode);
    if (this.registrationError) throw this.registrationError;
    return this.registration;
  }

  get lastRequest(): SignHashRequest {
    const request = this.signRequests[this.signRequests.length - 1];
    if (!request) throw new Error('no sign-hash request yet');
    return request;
  }

  /** Base64 signature over the last request's digest, as CSign would return it. */
  sign(digestTransform: (digest: Buffer) => Buffer = (digest) => digest): string {
    const digest = Buffer.from(this.lastRequest.digestValue, 'base64');
    return this.identity.remoteSign(digestTransform(digest)).toString('base64');
  }

  /** Makes query-status report success with a signature for the last request. */
  complete(signature = this.sign()): void {
    this.status = {
      statusCode: 4,
      resultCode: 'Ký thành công',
      errorCode: undefined,
      signatures: [{ documentId: this.lastRequest.documentId, signature }],
    };
  }
}

export interface TestContext {
  deps: VneidDeps;
  csign: CsignStandIn;
  identity: SoftIdentity;
  clock: { now: number; advance(ms: number): void };
}

export function testConfig(overrides: Partial<VneidConfig> = {}): VneidConfig {
  return {
    csign: { baseUrl: 'https://csign.example.test', username: 'org-user', password: 'org-pass' },
    webhook: {
      organizationId: ORGANIZATION_ID,
      secrets: [WEBHOOK_SECRET, WEBHOOK_SECRET_PREVIOUS],
    },

    dbPath: ':memory:',
    dailyCap: 5000,
    auditDays: 90,
    requireCode: false,
    tsaUrls: [],
    queryStatus: true,

    ...overrides,
  };
}

export function createTestContext(
  options: { identity?: SoftIdentity; config?: Partial<VneidConfig>; store?: VneidStore } = {}
): TestContext {
  const identity = options.identity ?? vneidIdentity();
  const csign = new CsignStandIn(identity);
  const config = testConfig(options.config);
  const clock = {
    now: Date.now(),
    advance(ms: number) {
      clock.now += ms;
    },
  };
  return {
    identity,
    csign,
    clock,
    deps: {
      config,
      keys: deriveKeys(Buffer.alloc(32, 7)),
      store: options.store ?? VneidStore.open(':memory:'),
      csign,
      trustStore: identity.trustStore,
      pdf: inProcessPdfJobs,
      now: () => clock.now,
    },
  };
}

/** A webhook delivery as CSign sends it: raw body + signature header. */
export function webhookDelivery(
  event: {
    id: string;
    eventName: string;
    timestamp?: string;
    organizationId?: string;
    data: unknown;
  },
  secret = WEBHOOK_SECRET,
  now = Date.now()
): { body: Buffer; header: string } {
  const body = Buffer.from(
    JSON.stringify({
      id: event.id,
      eventName: event.eventName,
      timestamp: event.timestamp ?? new Date(now).toISOString(),
      organizationId: event.organizationId ?? ORGANIZATION_ID,
      data: event.data,
    }),
    'utf8'
  );
  return {
    body,
    header: `HMAC SHA256=${hmacSha256(Buffer.from(secret, 'utf8'), body).toString('hex')}`,
  };
}
