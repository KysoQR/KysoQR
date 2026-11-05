import { afterEach, describe, expect, it, vi } from 'vitest';
import { logCsignExchange, redactForLog } from './csignLog';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3NzUwMjAzNDd9.a8DnpfmIte0uuwO8qNYcytsw';
const PID = '037086000384';

describe('redactForLog', () => {
  it('hides passwords and tokens, keeps the account name', () => {
    expect(redactForLog({ username: 'org01', password: 'p@ss' })).toEqual({
      username: 'org01',
      password: '[hidden]',
    });
    expect(
      redactForLog({
        success: true,
        data: { token: JWT, refreshToken: JWT, note: `Bearer ${JWT}` },
      })
    ).toEqual({
      success: true,
      data: { token: '[hidden]', refreshToken: '[hidden]', note: 'Bearer [jwt]' },
    });
  });

  it('keeps only the end of a CCCD and hides names and certificates', () => {
    const answer = redactForLog({
      citizenPid: PID,
      data: {
        credentialInfos: [
          {
            credentialID: '2E6879BD54CA1148E4D86D05A5288DC0',
            cert: {
              certificates: ['MIIEhDCCA2yg', 'MIIDbzCC'],
              subjectDN: 'Nguyễn Văn Cường',
              issuerDN: 'CN=CMC-CA RS, O=CMC Corporation, C=VN',
            },
          },
        ],
      },
    });
    const text = JSON.stringify(answer);
    expect(text).toContain('*********384');
    expect(text).not.toContain(PID);
    expect(text).not.toContain('Nguyễn');
    expect(text).toContain('[2 certificate(s): 12 chars, 8 chars]');
    expect(text).toContain('2E6879BD54CA1148E4D86D05A5288DC0');
    expect(text).toContain('CMC-CA RS');
  });

  it('shows a signature as its size and keeps transaction ids, masks other long numbers', () => {
    const text = JSON.stringify(
      redactForLog({
        signerCCCD: PID,
        requestId: 'req-1',
        documents: [
          { documentId: 'doc-1', digestValue: 'IQ6A79LHX1ejyx8F6sRxNezHm7nApbjEAyqZQ4VUlh0=' },
        ],
        data: {
          transactionId: 'f8b6cc66-9433-4197-9173-66a17ff3677b',
          rscaTransactionId: '297587974697127937',
          // An RSA-2048 signature: 344 base64 characters, two of them padding.
          signatures: [{ documentId: 'doc-1', signature: Buffer.alloc(256, 7).toString('base64') }],
          description: `Lỗi cho CCCD ${PID}`,
        },
      })
    );
    expect(text).toContain('[signature, 256 bytes]');
    expect(text).toContain('297587974697127937');
    expect(text).toContain('f8b6cc66-9433-4197-9173-66a17ff3677b');
    expect(text).toContain('Lỗi cho CCCD [redacted-number]');
    expect(text).not.toContain(PID);
  });
});

describe('logCsignExchange', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const exchange = {
    path: '/api/credentials/list',
    httpStatus: 200,
    ms: 123,
    bytes: 4096,
    code: '01',
    request: { citizenPid: PID },
    response: { success: true, data: { status: '01', description: 'Tiếp nhận thành công' } },
  };

  it('prints the request and the answer (redacted) in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    logCsignExchange(exchange);
    const text = lines.join('\n');
    expect(text).toContain('[vneid:csign] /api/credentials/list -> HTTP 200');
    expect(text).toContain('"ms": 123');
    expect(text).toContain('Tiếp nhận thành công');
    expect(text).toContain('*********384');
    expect(text).not.toContain(PID);
  });

  it('prints a one-line summary without bodies in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const calls: unknown[][] = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    logCsignExchange(exchange);
    logCsignExchange({
      path: '/api/auth/login',
      httpStatus: undefined,
      ms: 15000,
      request: {},
      failure: 'timeout',
    });
    expect(calls[0]).toEqual([
      '[vneid:csign] /api/credentials/list -> HTTP 200',
      { ms: 123, bytes: 4096, code: '01' },
    ]);
    expect(calls[1]).toEqual([
      '[vneid:csign] /api/auth/login -> no answer',
      { ms: 15000, failure: 'timeout' },
    ]);
    expect(JSON.stringify(calls)).not.toContain('Tiếp nhận');
  });
});

describe('redactForLog: certificate registration', () => {
  it('hides the whole registration form and the issued certificate', () => {
    const redacted = redactForLog({
      userInfo: {
        citizenPid: '012345678901',
        fullName: 'Nguyễn Văn A',
        birthDate: '23/12/1990',
        livingPlaceAddress: 'Số 1 phố X',
        phone: '0912345678',
      },
      provider: 'HUD-CMC-CA',
      servicePackCode: 'VNEID-FREE-12M',
      data: { transactionCode: 'c2bac29b', certificateData: ['MIIE', 'MIIF'] },
    });
    expect(redacted).toEqual({
      userInfo: '[hidden]',
      provider: 'HUD-CMC-CA',
      servicePackCode: 'VNEID-FREE-12M',
      data: { transactionCode: 'c2bac29b', certificateData: '[2 certificate(s)]' },
    });
  });
});
