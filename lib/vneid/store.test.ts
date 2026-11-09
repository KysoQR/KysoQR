import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type NewRegistration, type NewTransaction, VneidStore } from './store';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const TTL = 2 * MIN;
let sequence = 0;

function newRow(overrides: Partial<NewTransaction> = {}): NewTransaction {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    requestId: `request-${sequence}`,
    documentId: `document-${sequence}`,
    documentName: 'KysoQR - test',
    citizenKey: 'citizen-a',
    clientSecretHash: Buffer.alloc(32, 1),
    codeHash: null,
    originalSha256: Buffer.alloc(32, 2),
    originalLength: 1234,
    prevSignatureCount: 0,
    xrefKind: 'table',
    createdAt: T0,
    confirmDeadline: T0 + 5 * MIN,
    expiresAt: T0 + 30 * MIN,
    ...overrides,
  };
}

const AUDIT = { documentSha256: 'ab'.repeat(32), ipKey: 'ip' };

function submit(store: VneidStore, row: NewTransaction, csignId = `csign-${row.id}`) {
  expect(store.reserve(row, AUDIT, TTL)).toBe('reserved');
  expect(
    store.markSubmitted(
      row.id,
      { transactionId: csignId, rscaTransactionId: 'rsca-1' },
      { now: row.createdAt, confirmDeadline: row.confirmDeadline, expiresAt: row.expiresAt }
    )
  ).toBe(true);
}

const signed = (signature = Buffer.alloc(256, 3)) => ({
  signature,
  source: 'webhook' as const,
  signedAt: T0,
  csignStatus: 4,
});

describe('VneidStore', () => {
  let store: VneidStore;
  beforeEach(() => {
    store = VneidStore.open(':memory:');
  });
  afterEach(() => store.close());

  it('keeps one open request per citizen', () => {
    const first = newRow();
    expect(store.reserve(first, AUDIT, TTL)).toBe('reserved');
    expect(store.reserve(newRow(), AUDIT, TTL)).toBe('citizen-busy');
    expect(store.reserve(newRow({ citizenKey: 'citizen-b' }), AUDIT, TTL)).toBe('reserved');

    store.markEnded(first.id, 'REJECTED', { errorCode: 'errorcode4004' }, T0 + MIN);
    expect(store.reserve(newRow({ createdAt: T0 + MIN }), AUDIT, TTL)).toBe('reserved');
  });

  it('frees a citizen whose request is overdue when they ask again', () => {
    const row = newRow();
    submit(store, row);
    const later = T0 + 31 * MIN;
    expect(store.reserve(newRow({ createdAt: later }), AUDIT, TTL)).toBe('reserved');
    expect(store.get(row.id)).toMatchObject({ status: 'EXPIRED', errorCode: 'LOCAL_TIMEOUT' });
  });

  it('expires overdue requests and abandons stuck submissions, keeping the audit in step', () => {
    const pending = newRow();
    submit(store, pending);
    const stuck = newRow({ citizenKey: 'citizen-b' });
    store.reserve(stuck, AUDIT, TTL);

    expect(store.expireOverdue(T0 + MIN, TTL)).toBe(0);
    expect(store.expireOverdue(T0 + 3 * MIN, TTL)).toBe(1);
    expect(store.get(stuck.id)).toMatchObject({ status: 'FAILED', errorCode: 'SUBMIT_ABANDONED' });
    expect(store.expireOverdue(T0 + 30 * MIN, TTL)).toBe(1);
    expect(store.get(pending.id)?.status).toBe('EXPIRED');
    expect(store.citizenMisses('citizen-a', T0 - 1)).toEqual({ count: 1, lastAt: T0 + 30 * MIN });
  });

  it('only advances open requests, and only once', () => {
    const row = newRow();
    submit(store, row);
    expect(store.markProgress(row.id, 3, T0 + 1)).toBe(true);
    expect(store.get(row.id)?.status).toBe('WAITING_USER');

    expect(store.markSigned(row.id, signed(), T0 + 2, 5 * MIN)).toBe(true);
    expect(store.markSigned(row.id, signed(Buffer.alloc(256, 9)), T0 + 3, 5 * MIN)).toBe(false);
    expect(store.get(row.id)?.signature?.equals(Buffer.alloc(256, 3))).toBe(true);
    expect(store.markEnded(row.id, 'FAILED', { errorCode: 'x' }, T0 + 4)).toBe(false);
    expect(store.markProgress(row.id, 2, T0 + 5)).toBe(false);
  });

  it('accepts a late signature for a request it expired itself, within the grace period', () => {
    const late = newRow();
    submit(store, late);
    store.expireOverdue(late.expiresAt, TTL);
    expect(store.markSigned(late.id, signed(), late.expiresAt + 4 * MIN, 5 * MIN)).toBe(true);

    const tooLate = newRow({ citizenKey: 'citizen-b' });
    submit(store, tooLate);
    store.expireOverdue(tooLate.expiresAt, TTL);
    expect(store.markSigned(tooLate.id, signed(), tooLate.expiresAt + 6 * MIN, 5 * MIN)).toBe(
      false
    );
  });

  it('throttles status checks per transaction', () => {
    const row = newRow();
    submit(store, row);
    expect(store.claimStatusCheck(row.id, T0, 15_000)).toBe(true);
    expect(store.claimStatusCheck(row.id, T0 + 10_000, 15_000)).toBe(false);
    expect(store.claimStatusCheck(row.id, T0 + 15_000, 15_000)).toBe(true);
  });

  it('caps finalize attempts and burns after too many wrong codes', () => {
    const row = newRow();
    submit(store, row);
    store.markSigned(row.id, signed(), T0, 0);
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(store.claimFinalize(row.id, 5)).toBe(true);
    expect(store.claimFinalize(row.id, 5)).toBe(false);

    const other = newRow({ citizenKey: 'citizen-b' });
    submit(store, other);
    store.markSigned(other.id, signed(), T0, 0);
    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(store.recordCodeFailure(other.id, 5, T0)).toBe('retry');
    }
    expect(store.recordCodeFailure(other.id, 5, T0)).toBe('burned');
    expect(store.get(other.id)?.status).toBe('BURNED');
    expect(store.claimFinalize(other.id, 5)).toBe(false);
  });

  it('records each webhook event once', () => {
    const event = {
      id: 'evt-1',
      csignTransactionId: 'csign-1',
      name: 'signing.completed',
      outcome: 'signed',
    };
    expect(store.recordWebhookEvent(event, T0)).toBe(true);
    expect(store.recordWebhookEvent(event, T0 + 1)).toBe(false);
    expect(store.hasWebhookEvent('evt-1')).toBe(true);
    expect(store.hasWebhookEvent('evt-2')).toBe(false);
  });

  it('rolls a transaction back on error and refuses async work', () => {
    const row = newRow();
    expect(() =>
      store.transaction(() => {
        store.reserve(row, AUDIT, TTL);
        throw new Error('boom');
      })
    ).toThrow();
    expect(() =>
      store.transaction(() => {
        store.recordWebhookEvent(
          { id: 'e', csignTransactionId: undefined, name: 'n', outcome: 'o' },
          T0
        );
        return Promise.resolve();
      })
    ).toThrow(/promise/);
    expect(store.hasWebhookEvent('e')).toBe(false);
  });

  it('sweeps finished requests after a day, keeps open ones, and keeps the audit longer', () => {
    const done = newRow();
    submit(store, done);
    store.markEnded(done.id, 'REJECTED', { errorCode: 'errorcode4004' }, T0);
    const open = newRow({ citizenKey: 'citizen-b' });
    submit(store, open);
    store.sweep(T0 + 25 * 60 * MIN, 24 * 60 * MIN, 90 * 24 * 60 * MIN);
    expect(store.get(done.id)).toBeUndefined();
    expect(store.get(open.id)).toBeDefined();
    expect(store.countRequestsSince(T0 - 1)).toBe(2);
    store.sweep(T0 + 91 * 24 * 60 * MIN, 24 * 60 * MIN, 90 * 24 * 60 * MIN);
    expect(store.countRequestsSince(T0 - 1)).toBe(0);
  });

  it('leaves requests that failed before sign-hash out of the daily count', () => {
    const sent = newRow();
    submit(store, sent);
    store.markEnded(sent.id, 'FAILED', { errorCode: 'errorcode4007' }, T0);
    const notSent = newRow({ citizenKey: 'citizen-b' });
    expect(store.reserve(notSent, AUDIT, TTL)).toBe('reserved');
    expect(store.countRequestsSince(T0 - 1)).toBe(2);
    store.markEnded(notSent.id, 'FAILED', { errorCode: 'NO_CERT' }, T0);
    expect(store.countRequestsSince(T0 - 1)).toBe(1);
  });

  it('counts refused and ignored requests per citizen, not successful ones', () => {
    const refused = newRow();
    submit(store, refused);
    store.markEnded(refused.id, 'REJECTED', { errorCode: 'errorcode4004' }, T0 + 1);
    const ok = newRow({ createdAt: T0 + 2 });
    submit(store, ok);
    store.markSigned(ok.id, signed(), T0 + 3, 0);
    store.markFinalized(ok.id, T0 + 4);
    const failed = newRow({ createdAt: T0 + 5 });
    submit(store, failed);
    store.markEnded(failed.id, 'FAILED', { errorCode: 'CSIGN_UPSTREAM' }, T0 + 6);
    expect(store.citizenMisses('citizen-a', T0 - 1)).toEqual({ count: 1, lastAt: T0 + 1 });
    expect(store.get(ok.id)?.status).toBe('FINALIZED');
  });
});

describe('VneidStore on disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kysoqr-vneid-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates its folder, migrates once, and enforces the citizen lock across connections', () => {
    const file = path.join(dir, 'nested', 'vneid.sqlite');
    const a = VneidStore.open(file);
    const b = VneidStore.open(file);
    try {
      expect(a.reserve(newRow(), AUDIT, TTL)).toBe('reserved');
      expect(b.reserve(newRow(), AUDIT, TTL)).toBe('citizen-busy');
    } finally {
      a.close();
      b.close();
    }
    const reopened = VneidStore.open(file);
    expect(reopened.countRequestsSince(0)).toBe(1);
    reopened.close();
  });

  it('upgrades a version 1 database (no timestamp column, no registrations), keeping its rows', () => {
    const file = path.join(dir, 'vneid.sqlite');
    const store = VneidStore.open(file);
    const row = newRow();
    expect(store.reserve(row, AUDIT, TTL)).toBe('reserved');
    store.close();

    // Turn it back into what the first release wrote.
    const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const raw = new sqlite.DatabaseSync(file);
    raw.exec(
      'ALTER TABLE vneid_transactions DROP COLUMN timestamp_token; ' +
        'DROP TABLE vneid_registrations; PRAGMA user_version = 1;'
    );
    raw.close();

    const upgraded = VneidStore.open(file);
    try {
      expect(upgraded.get(row.id)?.timestampToken).toBeNull();
      expect(upgraded.countRequestsSince(0)).toBe(1);
      expect(upgraded.latestRegistration('citizen', 0, 0, 0)).toBeUndefined();
    } finally {
      upgraded.close();
    }
    const check = new sqlite.DatabaseSync(file, { readOnly: true });
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    check.close();
  });
});

describe('VneidStore registrations', () => {
  const DAY = 24 * 60 * MIN;
  let store: VneidStore;
  beforeEach(() => {
    store = VneidStore.open(':memory:');
  });
  afterEach(() => store.close());

  function registration(overrides: Partial<NewRegistration> = {}): NewRegistration {
    sequence += 1;
    return {
      id: `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      requestId: `registration-request-${sequence}`,
      citizenKey: 'citizen-a',
      provider: 'HUD-CMC-CA',
      providerName: 'CMC',
      servicePackCode: 'VNEID-FREE-12M',
      servicePackName: 'Free 12 months',
      servicePackMonths: 12,
      unitPrice: 0,
      createdAt: T0,
      expiresAt: T0 + DAY,
      ...overrides,
    };
  }

  it('keeps one open registration per citizen, apart from signing requests', () => {
    const first = registration();
    expect(store.reserveRegistration(first, TTL)).toBe('reserved');
    expect(store.reserveRegistration(registration(), TTL)).toBe('citizen-busy');
    expect(store.reserveRegistration(registration({ citizenKey: 'citizen-b' }), TTL)).toBe(
      'reserved'
    );
    expect(store.reserve(newRow(), AUDIT, TTL)).toBe('reserved');

    expect(store.markRegistrationSubmitted(first.id, 'ra-1', T0)).toBe(true);
    expect(store.finishRegistration(first.id, 'FAILED', { errorCode: 'errorcode05' }, T0)).toBe(
      true
    );
    expect(store.reserveRegistration(registration({ createdAt: T0 + MIN }), TTL)).toBe('reserved');
  });

  it('only moves forward, and is found again by citizen after a reload', () => {
    const row = registration();
    store.reserveRegistration(row, TTL);
    // No transactionCode yet: nothing to ask CSign about.
    expect(store.claimRegistrationCheck(row.id, T0, 5000)).toBe(false);
    expect(store.markRegistrationSubmitted(row.id, 'ra-1', T0)).toBe(true);
    expect(store.markRegistrationSubmitted(row.id, 'ra-2', T0)).toBe(false);
    expect(store.claimRegistrationCheck(row.id, T0 + 1000, 5000)).toBe(true);
    expect(store.claimRegistrationCheck(row.id, T0 + 2000, 5000)).toBe(false);
    expect(store.markRegistrationProgress(row.id, 'ISSUED', 3, T0 + 3000)).toBe(true);
    expect(store.latestRegistration('citizen-a', T0 + 4000, DAY, TTL)).toMatchObject({
      id: row.id,
      status: 'ISSUED',
      transactionCode: 'ra-1',
      csignStatus: 3,
    });

    const done = T0 + 5000;
    expect(store.finishRegistration(row.id, 'COMPLETED', { serialNumber: 'AB12' }, done)).toBe(
      true
    );
    expect(store.finishRegistration(row.id, 'FAILED', {}, done + 1)).toBe(false);
    expect(store.markRegistrationProgress(row.id, 'PENDING', 2, done + 2)).toBe(false);
    expect(store.latestRegistration('citizen-a', done + 3, DAY, TTL)).toMatchObject({
      status: 'COMPLETED',
      serialNumber: 'AB12',
      finishedAt: done,
    });
    // A finished one stays visible for a day, then is swept.
    expect(store.latestRegistration('citizen-a', done + DAY + 1, DAY, TTL)).toBeUndefined();
    store.sweep(done + DAY, DAY, 90 * DAY);
    expect(store.getRegistration(row.id)).toBeUndefined();
  });

  it('expires overdue registrations; an abandoned submission fails', () => {
    const abandoned = registration();
    store.reserveRegistration(abandoned, TTL);
    const open = registration({ citizenKey: 'citizen-b' });
    store.reserveRegistration(open, TTL);
    store.markRegistrationSubmitted(open.id, 'ra-b', T0);

    store.expireOverdue(T0 + 3 * MIN, TTL);
    expect(store.getRegistration(abandoned.id)).toMatchObject({
      status: 'FAILED',
      errorCode: 'SUBMIT_ABANDONED',
    });
    expect(store.getRegistration(open.id)?.status).toBe('PENDING');
    expect(store.latestRegistration('citizen-b', T0 + DAY, DAY, TTL)).toMatchObject({
      status: 'EXPIRED',
      errorCode: 'LOCAL_TIMEOUT',
    });
  });
});
