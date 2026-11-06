import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoftIdentity } from '../pdfSign/testHelpers';
import { CsignError } from './csignClient';
import { getRegistration, listProviders, startRegistration } from './registration';
import {
  CITIZEN_PID,
  createTestContext,
  OTHER_PID,
  type TestContext,
  vneidIdentity,
} from './testKit';

const FORM = {
  fullName: 'Nguyễn Văn A',
  birthDate: '1990-12-23',
  gender: 'Nam',
  phone: '0912 345 678',
  email: 'a@example.test',
  nationalityCode: 'vn',
  permanentCityText: 'Hà Nội',
};
const CHOICE = { provider: 'HUD-CMC-CA', servicePackCode: 'VNEID-FREE-12M' };

describe('certificate registration', () => {
  let identity: SoftIdentity;
  let ctx: TestContext;
  beforeAll(() => {
    identity = vneidIdentity();
  });
  beforeEach(() => {
    ctx = createTestContext({ identity });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    ctx.deps.store.close();
    vi.restoreAllMocks();
  });

  const start = (overrides: Record<string, unknown> = {}, citizenPid = CITIZEN_PID) =>
    startRegistration(ctx.deps, { citizenPid, ...CHOICE, userInfo: FORM, ...overrides });
  const reject = (promise: Promise<unknown>, code: string) =>
    expect(promise).rejects.toMatchObject({ code });

  it('lists every provider and pack, paid ones included, and caches the list', async () => {
    const list = vi.spyOn(ctx.csign, 'listProviders');
    const providers = await listProviders(ctx.deps);
    expect(providers).toEqual([
      {
        provider: 'HUD-CMC-CA',
        name: 'CMC',
        packs: [
          { code: 'VNEID-FREE-12M', name: 'Free 12 months', months: 12, unitPrice: 0, free: true },
          { code: 'CMC-24M', name: 'Paid 24 months', months: 24, unitPrice: 550_000, free: false },
        ],
      },
    ]);
    await listProviders(ctx.deps);
    expect(list).toHaveBeenCalledTimes(1);
    ctx.clock.advance(11 * 60_000);
    await listProviders(ctx.deps);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('sends the checked form to CSign and keeps only what the page shows', async () => {
    const view = await start();
    expect(view).toMatchObject({
      status: 'PENDING',
      provider: 'HUD-CMC-CA',
      providerName: 'CMC',
      servicePackName: 'Free 12 months',
      months: 12,
      unitPrice: 0,
    });
    expect(JSON.stringify(view)).not.toMatch(/Nguy|0912|example|CITIZEN|012345678901/);
    const [request] = ctx.csign.registerRequests;
    expect(request).toMatchObject({ ...CHOICE, userInfo: { citizenPid: CITIZEN_PID } });
    expect(request!.userInfo).toMatchObject({
      fullName: 'Nguyễn Văn A',
      birthDate: '23/12/1990',
      phone: '0912345678',
      nationalityCode: 'VN',
    });
    expect(request!.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a bad form, an unknown pack, and a second registration while one is open', async () => {
    await reject(
      start({ userInfo: { ...FORM, email: 'not-an-email' } }),
      'VNEID_REGISTRATION_INVALID'
    );
    await reject(start({ userInfo: { ...FORM, fullName: '' } }), 'VNEID_REGISTRATION_INVALID');
    await reject(start({ servicePackCode: 'NOPE' }), 'VNEID_PROVIDER_UNAVAILABLE');
    expect(ctx.csign.registerRequests).toHaveLength(0);

    await start();
    await reject(start(), 'VNEID_REGISTRATION_PENDING');
    // Another citizen is not affected.
    await expect(start({}, OTHER_PID)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('tells apart packs CSign lists under the same code, by a listed name only', async () => {
    ctx.csign.providers = [
      {
        provider: 'VNPT',
        name: 'VNPT',
        status: 0,
        packs: [
          { code: '18130', name: 'Theo lượt 1 năm', months: 12, unitPrice: 0, free: 1 },
          { code: '18130', name: 'Miễn phí VNeID 6 tháng', months: 6, unitPrice: 0, free: 1 },
        ],
      },
    ];
    const chosen = { provider: 'VNPT', servicePackCode: '18130' };
    await expect(
      start({ ...chosen, servicePackName: 'Miễn phí VNeID 6 tháng' })
    ).resolves.toMatchObject({ servicePackName: 'Miễn phí VNeID 6 tháng', months: 6 });
    expect(ctx.csign.registerRequests[0]).toMatchObject({ servicePackCode: '18130' });
    // A name that is not listed for that code changes nothing: the first pack.
    await expect(
      start({ ...chosen, servicePackName: 'Gói tự đặt' }, OTHER_PID)
    ).resolves.toMatchObject({ servicePackName: 'Theo lượt 1 năm', months: 12 });
  });

  it('maps a CSign refusal and frees the citizen for another try', async () => {
    ctx.csign.registerError = new CsignError(
      'ALREADY_REGISTERED',
      '/api/credentials/register',
      'x',
      {
        code: '19',
      }
    );
    await reject(start(), 'VNEID_ALREADY_REGISTERED');
    ctx.csign.registerError = undefined;
    await expect(start({ servicePackCode: 'CMC-24M' })).resolves.toMatchObject({
      status: 'PENDING',
    });
  });

  it('expires 30 minutes after it is sent', async () => {
    const view = await start();
    expect(Date.parse(view.expiresAt) - Date.parse(view.createdAt)).toBe(30 * 60_000);
  });
});

describe('registration status, found again by CCCD', () => {
  let identity: SoftIdentity;
  let ctx: TestContext;
  beforeAll(() => {
    identity = vneidIdentity();
  });
  beforeEach(async () => {
    ctx = createTestContext({ identity });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await startRegistration(ctx.deps, { citizenPid: CITIZEN_PID, ...CHOICE, userInfo: FORM });
  });
  afterEach(() => {
    ctx.deps.store.close();
    vi.restoreAllMocks();
  });

  const status = () => getRegistration(ctx.deps, CITIZEN_PID);
  const csignSays = (
    statusCode: number,
    extra: { serialNumber?: string; errorCode?: string } = {}
  ) => {
    ctx.csign.registration = {
      statusCode,
      serialNumber: extra.serialNumber,
      errorCode: extra.errorCode,
      resultCode: undefined,
    };
    ctx.clock.advance(6_000);
  };

  it('is null for a citizen without one', async () => {
    expect(await getRegistration(ctx.deps, OTHER_PID)).toBeNull();
  });

  it('follows CSign through issuing and activation', async () => {
    expect(await status()).toMatchObject({ status: 'PENDING' });
    csignSays(3);
    expect(await status()).toMatchObject({ status: 'ISSUED' });
    csignSays(0, { serialNumber: '54011D98F5344A6939E0E19199053623' });
    expect(await status()).toEqual(
      expect.objectContaining({
        status: 'COMPLETED',
        serialNumber: '54011D98F5344A6939E0E19199053623',
      })
    );
    // Finished: CSign is not asked again, the outcome stays visible.
    const asked = ctx.csign.registrationQueries.length;
    csignSays(1, { errorCode: 'errorcode05' });
    expect(await status()).toMatchObject({ status: 'COMPLETED' });
    expect(ctx.csign.registrationQueries).toHaveLength(asked);
  });

  it('reports why it ended', async () => {
    const outcomes: [string, object][] = [
      ['errorcode06', { status: 'REJECTED', reason: 'REFUSED' }],
      ['errorcode07', { status: 'EXPIRED', reason: 'TIMEOUT' }],
      ['errorcode02', { status: 'FAILED', reason: 'CITIZEN_INFO' }],
      ['errorcode05', { status: 'FAILED', reason: 'PROVIDER' }],
    ];
    for (const [errorCode, expected] of outcomes) {
      csignSays(1, { errorCode });
      expect(await status()).toMatchObject(expected);
      // Start the next one (each ended registration frees the citizen).
      ctx.clock.advance(24 * 60 * 60_000 + 1);
      ctx.csign.registration = {
        statusCode: 2,
        serialNumber: undefined,
        errorCode: undefined,
        resultCode: undefined,
      };
      await startRegistration(ctx.deps, { citizenPid: CITIZEN_PID, ...CHOICE, userInfo: FORM });
    }
  });

  it('asks CSign at most every few seconds', async () => {
    await status();
    await status();
    await status();
    expect(ctx.csign.registrationQueries).toHaveLength(1);
    ctx.clock.advance(5_000);
    await status();
    expect(ctx.csign.registrationQueries).toHaveLength(2);
  });

  it('waits for CSign to know a fresh registration, then gives up on an unknown one', async () => {
    ctx.csign.registrationError = new CsignError('NOT_FOUND', '/api/credentials/get-status', 'x', {
      code: '08',
    });
    expect(await status()).toMatchObject({ status: 'PENDING' });
    ctx.clock.advance(3 * 60_000);
    expect(await status()).toMatchObject({ status: 'FAILED', reason: 'PROVIDER' });
  });

  it('is gone after 30 minutes, open or finished, and the citizen can register again', async () => {
    ctx.clock.advance(29 * 60_000);
    expect(await status()).toMatchObject({ status: 'PENDING' });
    const asked = ctx.csign.registrationQueries.length;
    ctx.clock.advance(60_000);
    expect(await status()).toBeNull();
    expect(ctx.csign.registrationQueries).toHaveLength(asked);
    await expect(
      startRegistration(ctx.deps, { citizenPid: CITIZEN_PID, ...CHOICE, userInfo: FORM })
    ).resolves.toMatchObject({ status: 'PENDING' });

    // A finished one too.
    csignSays(1, { errorCode: 'errorcode05' });
    expect(await status()).toMatchObject({ status: 'FAILED' });
    ctx.clock.advance(30 * 60_000);
    expect(await status()).toBeNull();
  });
});
