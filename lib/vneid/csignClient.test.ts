import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsignClient, CsignError } from './csignClient';

const BASE = 'https://csign.example.test';
const PASSWORD = 'pw-must-never-leak';
const PID = '012345678901';

const jwt = (expSeconds: number, tag: string) =>
  [
    Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from(JSON.stringify({ exp: expSeconds, tag })).toString('base64url'),
    'sig',
  ].join('.');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  path: string;
  body: Record<string, unknown>;
  authorization: string | undefined;
}

type Handler = (call: Call) => Response | Promise<Response>;

function installFetch(handlers: Record<string, Handler[] | Handler>) {
  const calls: Call[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      path: url.pathname,
      body: JSON.parse(String(init?.body ?? '{}')),
      authorization: headers.get('authorization') ?? undefined,
    };
    calls.push(call);
    expect(init?.redirect).toBe('error');
    const handler = handlers[url.pathname];
    const next = Array.isArray(handler) ? handler.shift() : handler;
    if (!next) throw new Error(`unexpected call to ${url.pathname}`);
    return next(call);
  });
  return { calls, spy };
}

const login =
  (tag = 'a', expSeconds = Math.floor(Date.now() / 1000) + 3600) =>
  () =>
    json({
      success: true,
      data: { token: jwt(expSeconds, tag), refreshToken: jwt(expSeconds + 7200, `r${tag}`) },
    });

const credentialsAnswer = () =>
  json({
    success: true,
    data: {
      status: '01',
      description: 'Tiếp nhận thành công',
      data: {
        credentialIDs: ['2E68'],
        credentialInfos: [
          {
            credentialID: '2E68',
            cert: {
              status: 1,
              certificates: ['AAAA', 'BBBB'],
              issuerDN: 'CN=CMC-CA RS',
              serialNumber: '2E68',
              subjectDN: 'Personal Name',
              validTo: '31/07/2026 18:35:06',
            },
            key: { status: 'enabled', algo: ['1.2.840.113549.1.1.11'], len: 2048, curve: null },
          },
        ],
      },
    },
  });

describe('CsignClient', () => {
  let client: CsignClient;
  beforeEach(() => {
    client = new CsignClient(`${BASE}/`, 'org01', PASSWORD);
  });
  afterEach(() => vi.restoreAllMocks());

  it('logs in once for concurrent calls and sends the bearer token', async () => {
    const { calls } = installFetch({
      '/api/auth/login': [login()],
      '/api/credentials/list': credentialsAnswer,
    });
    const results = await Promise.all([1, 2, 3].map(() => client.listCredentials(PID)));
    expect(calls.filter((call) => call.path === '/api/auth/login')).toHaveLength(1);
    expect(calls.find((call) => call.path === '/api/auth/login')?.body).toEqual({
      username: 'org01',
      password: PASSWORD,
    });
    expect(
      calls
        .filter((call) => call.path === '/api/credentials/list')
        .every((call) => call.authorization?.startsWith('Bearer '))
    ).toBe(true);
    expect(results[0]).toEqual([
      {
        credentialId: '2E68',
        certificates: ['AAAA', 'BBBB'],
        issuerDn: 'CN=CMC-CA RS',
        serialNumber: '2E68',
        validTo: '31/07/2026 18:35:06',
        certStatus: 1,
        keyStatus: 'enabled',
        keyAlgorithms: ['1.2.840.113549.1.1.11'],
        keyLength: 2048,
      },
    ]);
    // The subject DN (a person's name) is not carried over.
    expect(JSON.stringify(results[0])).not.toContain('Personal Name');
  });

  it('renews with the refresh token when CSign refuses the token, then retries once', async () => {
    const { calls } = installFetch({
      '/api/auth/login': [login('first')],
      '/api/auth/refresh-token': [login('second')],
      '/api/credentials/list': [
        () => json({ success: false, data: { status: '0' } }),
        credentialsAnswer,
      ],
    });
    await expect(client.listCredentials(PID)).resolves.toHaveLength(1);
    expect(calls.map((call) => call.path)).toEqual([
      '/api/auth/login',
      '/api/credentials/list',
      '/api/auth/refresh-token',
      '/api/credentials/list',
    ]);
    // The refresh token handed out at login is the one sent back.
    const refreshToken = String(calls[2]!.body.refreshToken);
    expect(
      JSON.parse(Buffer.from(refreshToken.split('.')[1]!, 'base64url').toString())
    ).toMatchObject({
      tag: 'rfirst',
    });
  });

  it('logs in again when the refresh fails, and gives up after one retry', async () => {
    const { calls } = installFetch({
      '/api/auth/login': [login('a'), login('b')],
      '/api/auth/refresh-token': [() => json({ error: 'expired' }, 401)],
      '/api/credentials/list': [() => json({}, 401), () => json({}, 401)],
    });
    const error = await client.listCredentials(PID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CsignError);
    expect((error as CsignError).kind).toBe('AUTH');
    expect(calls.map((call) => call.path)).toEqual([
      '/api/auth/login',
      '/api/credentials/list',
      '/api/auth/refresh-token',
      '/api/auth/login',
      '/api/credentials/list',
    ]);
  });

  it('renews ahead of the token expiry', async () => {
    let clock = Date.now();
    client = new CsignClient(BASE, 'org01', PASSWORD, () => clock);
    const { calls } = installFetch({
      '/api/auth/login': [login('a', Math.floor(clock / 1000) + 120)],
      '/api/auth/refresh-token': [login('b')],
      '/api/credentials/list': [credentialsAnswer, credentialsAnswer],
    });
    await client.listCredentials(PID);
    clock += 61_000; // within a minute of exp
    await client.listCredentials(PID);
    expect(calls.map((call) => call.path)).toContain('/api/auth/refresh-token');
  });

  it('maps RAR-HUB codes to error kinds', async () => {
    const cases: [string, string][] = [
      ['-01', 'PENDING_OTHER'],
      ['04', 'NO_CERTIFICATE'],
      ['4031', 'NO_CERTIFICATE'],
      ['4030', 'CERT_INVALID'],
      ['21', 'CERT_INVALID'],
      ['4025', 'DUPLICATE_REQUEST'],
      ['03', 'BAD_REQUEST'],
      ['4036', 'UPSTREAM'],
    ];
    for (const [code, kind] of cases) {
      vi.restoreAllMocks();
      client = new CsignClient(BASE, 'org01', PASSWORD);
      installFetch({
        '/api/auth/login': [login()],
        '/api/signing/sign-hash': () =>
          json({ success: false, data: { status: code, description: `Lỗi ${PID}` } }),
      });
      const error = (await client
        .signHash({
          credentialId: 'c',
          citizenPid: PID,
          requestId: 'r',
          documentId: 'd',
          documentName: 'n',
          digestValue: 'AAAA',
        })
        .catch((caught: unknown) => caught)) as CsignError;
      expect(error.kind).toBe(kind);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain(PID);
    }
  });

  it('sends sign-hash exactly as the spec describes', async () => {
    const { calls } = installFetch({
      '/api/auth/login': [login()],
      '/api/signing/sign-hash': () =>
        json({
          success: true,
          data: { transactionId: 'tx-1', rscaTransactionId: '297587974697127937', message: 'ok' },
        }),
    });
    const result = await client.signHash({
      credentialId: 'SERIAL',
      citizenPid: PID,
      requestId: 'req-1',
      documentId: 'doc-1',
      documentName: 'KysoQR - Ký tài liệu 0A1B2C3D',
      digestValue: 'IQ6A79LHX1ejyx8F6sRxNezHm7nApbjEAyqZQ4VUlh0=',
    });
    expect(result).toEqual({ transactionId: 'tx-1', rscaTransactionId: '297587974697127937' });
    expect(calls[1]!.body).toEqual({
      credentialID: 'SERIAL',
      signerCCCD: PID,
      requestId: 'req-1',
      documents: [
        {
          documentId: 'doc-1',
          documentName: 'KysoQR - Ký tài liệu 0A1B2C3D',
          digestValue: 'IQ6A79LHX1ejyx8F6sRxNezHm7nApbjEAyqZQ4VUlh0=',
        },
      ],
      serviceType: 'vneid',
    });
  });

  it('reads query-status answers in both documented signature shapes', async () => {
    installFetch({
      '/api/auth/login': [login()],
      '/api/signing/query-status': [
        () =>
          json({
            success: true,
            data: {
              description: 'Tiếp nhận thành công',
              data: {
                statusCode: 4,
                resultCode: 'Ký thành công',
                signatures: [{ documentId: 'doc-1', signature: 'c2ln' }],
                errorCode: null,
              },
            },
          }),
        () =>
          json({
            success: true,
            data: {
              data: {
                statusCode: '0',
                resultCode: null,
                signatures: ['c2ln'],
                errorCode: 'errorcode4005',
              },
            },
          }),
      ],
    });
    await expect(client.queryStatus('tx-1')).resolves.toEqual({
      statusCode: 4,
      resultCode: 'Ký thành công',
      errorCode: undefined,
      signatures: [{ documentId: 'doc-1', signature: 'c2ln' }],
    });
    await expect(client.queryStatus('tx-1')).resolves.toEqual({
      statusCode: 0,
      resultCode: undefined,
      errorCode: 'errorcode4005',
      signatures: [{ documentId: undefined, signature: 'c2ln' }],
    });
  });

  it('fails closed on network errors, redirects, timeouts, oversized and odd answers', async () => {
    const expectKind = async (handler: Handler, kind: string) => {
      vi.restoreAllMocks();
      client = new CsignClient(BASE, 'org01', PASSWORD);
      installFetch({ '/api/auth/login': [login()], '/api/signing/query-status': handler });
      const error = (await client
        .queryStatus('tx')
        .catch((caught: unknown) => caught)) as CsignError;
      expect(error).toBeInstanceOf(CsignError);
      expect(error.kind).toBe(kind);
      expect(error.message).not.toContain(PASSWORD);
    };
    await expectKind(() => {
      throw new TypeError('fetch failed: redirect mode is set to error');
    }, 'UPSTREAM');
    await expectKind(() => {
      throw new DOMException('aborted', 'AbortError');
    }, 'TIMEOUT');
    await expectKind(() => json({ junk: 'x'.repeat(1100 * 1024) }), 'UPSTREAM');
    await expectKind(() => new Response('<html>gateway</html>', { status: 502 }), 'UPSTREAM');
    await expectKind(() => json({ success: true, data: { unexpected: true } }), 'UPSTREAM');
    await expectKind(() => json({ message: 'bad' }, 400), 'BAD_REQUEST');
  });

  it('does not treat a top-level status of a successful answer as an error code', async () => {
    installFetch({
      '/api/auth/login': [login()],
      '/api/signing/query-status': () =>
        json({ success: true, status: 0, data: { data: { statusCode: 3, signatures: [] } } }),
    });
    await expect(client.queryStatus('tx')).resolves.toMatchObject({ statusCode: 3 });
  });
});

describe('CsignClient against the UAT gateway answers', () => {
  afterEach(() => vi.restoreAllMocks());

  const uatError = (errorCode: string, message: string, status: number) => () =>
    json({ success: false, result: { errorCode, message } }, status);

  it('reads the { success:false, result:{ errorCode, message } } failure shape', async () => {
    const client = new CsignClient(BASE, 'org01', PASSWORD);
    installFetch({
      '/api/auth/login': [login()],
      '/api/signing/query-status': uatError(
        'INTERNAL_SERVER_ERROR',
        'An unexpected internal server error occurred.',
        500
      ),
    });
    const error = (await client.queryStatus('tx').catch((caught: unknown) => caught)) as CsignError;
    expect(error.kind).toBe('UPSTREAM');
    expect(error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(error.message).toContain('An unexpected internal server error occurred.');
    expect(error.message).not.toContain(PASSWORD);
  });

  it('treats a token error code as an expired token: refresh, then retry once', async () => {
    const client = new CsignClient(BASE, 'org01', PASSWORD);
    const { calls } = installFetch({
      '/api/auth/login': [login('first')],
      '/api/auth/refresh-token': [login('second')],
      '/api/credentials/list': [uatError('UNAUTHORIZED', 'Token expired', 403), credentialsAnswer],
    });
    await expect(client.listCredentials(PID)).resolves.toHaveLength(1);
    expect(calls.map((call) => call.path)).toEqual([
      '/api/auth/login',
      '/api/credentials/list',
      '/api/auth/refresh-token',
      '/api/credentials/list',
    ]);
  });

  it('logs the token lifecycle with lifetimes only, never a token', async () => {
    const lines: string[] = [];
    for (const level of ['info', 'warn'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(
          args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
        );
      });
    }
    const client = new CsignClient(BASE, 'org01', PASSWORD);
    const { calls } = installFetch({
      '/api/auth/login': [login('a'), login('c')],
      '/api/auth/refresh-token': [login('b'), () => json({}, 401)],
      '/api/credentials/list': [
        () => json({}, 401),
        credentialsAnswer,
        () => json({}, 401),
        credentialsAnswer,
      ],
    });
    await client.listCredentials(PID);
    await client.listCredentials(PID);

    const log = lines.join('\n');
    expect(log).toContain('[vneid:csign] logged in');
    expect(log).toContain('[vneid:csign] token refreshed');
    expect(log).toContain('CSign refused the token');
    expect(log).toContain('token refresh failed, logging in again');
    expect(log).toMatch(/"tokenMinutes":\d+/);
    // No token, password or CCCD in any line.
    const tokens = calls.flatMap((call) =>
      call.authorization ? [call.authorization.replace('Bearer ', '')] : []
    );
    for (const secret of [...tokens, PASSWORD, PID]) expect(log).not.toContain(secret);
  });
});

describe('CsignClient answer size limits', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads a large credentials/list answer (many certificates) and names the size when over the cap', async () => {
    const big = (bytes: number) => () => {
      const answer = credentialsAnswer();
      return answer.json().then((body: { data: { description: string } }) => {
        body.data.description = 'x'.repeat(bytes);
        return json(body);
      });
    };
    let client = new CsignClient(BASE, 'org01', PASSWORD);
    installFetch({ '/api/auth/login': [login()], '/api/credentials/list': big(3 * 1024 * 1024) });
    await expect(client.listCredentials(PID)).resolves.toHaveLength(1);

    vi.restoreAllMocks();
    client = new CsignClient(BASE, 'org01', PASSWORD);
    installFetch({ '/api/auth/login': [login()], '/api/credentials/list': big(9 * 1024 * 1024) });
    const error = (await client
      .listCredentials(PID)
      .catch((caught: unknown) => caught)) as CsignError;
    expect(error.kind).toBe('UPSTREAM');
    expect(error.message).toMatch(/answer too large \(.*limit 8388608 bytes\)/);
  });
});

describe('CsignClient certificate registration', () => {
  let client: CsignClient;
  beforeEach(() => {
    client = new CsignClient(BASE, 'org01', PASSWORD);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('reads the provider list with a GET, prices and all', async () => {
    const { spy } = installFetch({
      '/api/auth/login': [login()],
      '/api/provider/list': () =>
        json({
          success: true,
          data: {
            providers: [
              {
                providerName: 'CÔNG TY CỔ PHẦN TẬP ĐOÀN CÔNG NGHỆ CMC',
                provider: 'HUD-CMC-CA',
                status: 1,
                servicePackList: [
                  {
                    servicePackCode: 'VNEID-FREE-12M',
                    servicePackName: 'Gói miễn phí',
                    servicePackMonth: 12,
                    unitPrice: 0,
                    free: 0,
                  },
                  { servicePackCode: 'CMC-24M', servicePackMonth: '24', unitPrice: '550000.0' },
                ],
              },
            ],
          },
        }),
    });
    expect(await client.listProviders()).toEqual([
      {
        provider: 'HUD-CMC-CA',
        name: 'CÔNG TY CỔ PHẦN TẬP ĐOÀN CÔNG NGHỆ CMC',
        status: 1,
        packs: [
          { code: 'VNEID-FREE-12M', name: 'Gói miễn phí', months: 12, unitPrice: 0, free: 0 },
          { code: 'CMC-24M', name: undefined, months: 24, unitPrice: 550000, free: undefined },
        ],
      },
    ]);
    const init = spy.mock.calls[1]![1]!;
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get('content-type')).toBeNull();
  });

  it('registers and reads the outcome back', async () => {
    const { calls } = installFetch({
      '/api/auth/login': [login()],
      '/api/credentials/register': () =>
        json({
          success: true,
          data: { status: '01', description: 'Tiếp nhận thành công', transactionCode: 'c2bac29b' },
        }),
      '/api/credentials/get-status': () =>
        json({
          success: true,
          data: {
            status: '01',
            description: 'Thành công',
            data: {
              transactionCode: 'c2bac29b',
              statusCode: 0,
              requestType: 1,
              citizenPid: PID,
              serialNumber: '54011D98',
              certificateId: '54011D98',
              certificateData: 'MIIE',
              errorCode: null,
              resultCode: null,
            },
          },
        }),
    });
    const transactionCode = await client.registerCredential({
      userInfo: { citizenPid: PID, fullName: 'Nguyễn Văn A' },
      provider: 'HUD-CMC-CA',
      servicePackCode: 'VNEID-FREE-12M',
      requestId: 'request-1',
    });
    expect(transactionCode).toBe('c2bac29b');
    expect(calls[1]!.body).toEqual({
      userInfo: { citizenPid: PID, fullName: 'Nguyễn Văn A' },
      provider: 'HUD-CMC-CA',
      servicePackCode: 'VNEID-FREE-12M',
      requestId: 'request-1',
    });
    expect(await client.getRegistrationStatus('c2bac29b')).toEqual({
      statusCode: 0,
      serialNumber: '54011D98',
      errorCode: undefined,
      resultCode: undefined,
    });
    expect(calls[2]!.body).toEqual({ transactionCode: 'c2bac29b' });
  });

  it('reads registration codes with their own meaning', async () => {
    const refusal = (code: string) => () => json({ success: false, data: { status: code } });
    installFetch({
      '/api/auth/login': [login()],
      '/api/credentials/register': [refusal('19'), refusal('22'), refusal('-01'), refusal('04')],
      '/api/credentials/get-status': refusal('08'),
    });
    const request = {
      userInfo: { citizenPid: PID },
      provider: 'HUD-CMC-CA',
      servicePackCode: 'VNEID-FREE-12M',
      requestId: 'r',
    };
    const kindOf = (promise: Promise<unknown>) =>
      promise.then(
        () => 'resolved',
        (error: unknown) => (error instanceof CsignError ? error.kind : 'other')
      );
    expect(await kindOf(client.registerCredential(request))).toBe('ALREADY_REGISTERED');
    expect(await kindOf(client.registerCredential(request))).toBe('PROVIDER_UNAVAILABLE');
    expect(await kindOf(client.registerCredential(request))).toBe('PENDING_OTHER');
    // `04` means "no certificate" when signing, a refused request here.
    expect(await kindOf(client.registerCredential(request))).toBe('BAD_REQUEST');
    expect(await kindOf(client.getRegistrationStatus('x'))).toBe('NOT_FOUND');
  });
});
