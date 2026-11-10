import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

/**
 * SQLite state of VNeID signing (node:sqlite, VPS only).
 *
 * Holds what has to survive between the three calls of a signing (sign ->
 * status / webhook -> finalize) and the audit trail -- never a CCCD (only a
 * keyed HMAC of it), never a client secret (only its hash), and anything that
 * names the signer (certificate chain) or is large (prepared PDF data) sealed
 * with AES-GCM by the caller.
 *
 * Every method is synchronous. A transaction never spans an `await`: SQLite
 * would hold the write lock across network calls. State changes are
 * conditional UPDATEs (`WHERE status IN (...)`), so two racing callers -- a
 * webhook and a status poll, two finalize clicks -- cannot both win.
 *
 * node:sqlite is fetched at runtime through process.getBuiltinModule so no
 * bundler ever tries to resolve it; on Cloudflare Workers opening the
 * database throws, and the feature reports itself as not configured.
 */

export type TransactionStatus =
  | 'SUBMITTING'
  | 'PENDING'
  | 'WAITING_USER'
  | 'SIGNED'
  | 'FINALIZED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'FAILED'
  | 'BURNED';

export type EndStatus = 'REJECTED' | 'EXPIRED' | 'FAILED';

export const OPEN_STATUSES: readonly TransactionStatus[] = [
  'SUBMITTING',
  'PENDING',
  'WAITING_USER',
];

/**
 * A certificate registration (credentials/register) until its outcome is
 * known -- kept per citizen so a reload of the page finds it again. ISSUED:
 * the certificate exists but the citizen has not activated it on VNeID yet.
 */
export type RegistrationStatus =
  'SUBMITTING' | 'PENDING' | 'ISSUED' | 'COMPLETED' | 'FAILED' | 'REJECTED' | 'EXPIRED';

export const OPEN_REGISTRATION_STATUSES: readonly RegistrationStatus[] = [
  'SUBMITTING',
  'PENDING',
  'ISSUED',
];

/** No form data is kept: only what the page shows again and CSign's codes. */
export interface RegistrationRow {
  id: string;
  requestId: string;
  citizenKey: string;
  provider: string;
  providerName: string;
  servicePackCode: string;
  servicePackName: string;
  servicePackMonths: number | null;
  unitPrice: number | null;
  transactionCode: string | null;
  status: RegistrationStatus;
  csignStatus: number | null;
  errorCode: string | null;
  serialNumber: string | null;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number | null;
  expiresAt: number;
  finishedAt: number | null;
}

export type NewRegistration = Pick<
  RegistrationRow,
  | 'id'
  | 'requestId'
  | 'citizenKey'
  | 'provider'
  | 'providerName'
  | 'servicePackCode'
  | 'servicePackName'
  | 'servicePackMonths'
  | 'unitPrice'
  | 'createdAt'
  | 'expiresAt'
>;

export interface TransactionRow {
  id: string;
  requestId: string;
  documentId: string;
  documentName: string;
  digestValue: string | null;
  credentialId: string | null;
  certIssuerCn: string | null;
  certValidTo: number | null;
  certChainEnc: Buffer | null;
  preparedEnc: Buffer | null;
  csignTransactionId: string | null;
  rscaTransactionId: string | null;
  providerInternalId: string | null;
  documentNumber: string | null;
  csignStatus: number | null;
  errorCode: string | null;
  signature: Buffer | null;
  signatureSource: string | null;
  timestampToken: Buffer | null;
  signedAt: number | null;
  status: TransactionStatus;
  citizenKey: string;
  clientSecretHash: Buffer;
  codeHash: Buffer | null;
  codeAttempts: number;
  originalSha256: Buffer;
  originalLength: number;
  prevSignatureCount: number;
  xrefKind: string;
  createdAt: number;
  confirmDeadline: number;
  expiresAt: number;
  updatedAt: number;
  lastCheckedAt: number | null;
  finalizedAt: number | null;
  finalizeCount: number;
}

export interface NewTransaction {
  id: string;
  requestId: string;
  documentId: string;
  documentName: string;
  citizenKey: string;
  clientSecretHash: Buffer;
  codeHash: Buffer | null;
  originalSha256: Buffer;
  originalLength: number;
  prevSignatureCount: number;
  xrefKind: string;
  createdAt: number;
  confirmDeadline: number;
  expiresAt: number;
}

export interface PreparedData {
  digestValue: string;
  credentialId: string;
  certIssuerCn: string;
  certValidTo: number;
  certChainEnc: Buffer;
  preparedEnc: Buffer;
}

export interface SignedData {
  signature: Buffer;
  source: 'webhook' | 'query-status';
  signedAt: number;
  csignStatus: number;
  providerInternalId?: string | undefined;
  documentNumber?: string | undefined;
}

const SCHEMA_VERSION = 3;

const SCHEMA_V1 = `
CREATE TABLE vneid_transactions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL,
  document_name TEXT NOT NULL,
  digest_value TEXT,
  credential_id TEXT,
  cert_issuer_cn TEXT,
  cert_valid_to INTEGER,
  cert_chain_enc BLOB,
  prepared_enc BLOB,
  csign_transaction_id TEXT UNIQUE,
  rsca_transaction_id TEXT,
  provider_internal_id TEXT,
  document_number TEXT,
  csign_status INTEGER,
  error_code TEXT,
  signature BLOB,
  signature_source TEXT,
  signed_at INTEGER,
  status TEXT NOT NULL,
  citizen_key TEXT NOT NULL,
  client_secret_hash BLOB NOT NULL,
  code_hash BLOB,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  original_sha256 BLOB NOT NULL,
  original_length INTEGER NOT NULL,
  prev_signature_count INTEGER NOT NULL,
  xref_kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  confirm_deadline INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  finalized_at INTEGER,
  finalize_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX vneid_one_open_request_per_citizen
  ON vneid_transactions (citizen_key)
  WHERE status IN ('SUBMITTING', 'PENDING', 'WAITING_USER');
CREATE INDEX vneid_transactions_by_expiry ON vneid_transactions (status, expires_at);
CREATE INDEX vneid_transactions_by_creation ON vneid_transactions (created_at);

CREATE TABLE vneid_webhook_events (
  event_id TEXT PRIMARY KEY,
  csign_transaction_id TEXT,
  event_name TEXT NOT NULL,
  outcome TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX vneid_webhook_events_by_time ON vneid_webhook_events (received_at);

CREATE TABLE vneid_audit (
  id TEXT PRIMARY KEY,
  citizen_key TEXT NOT NULL,
  document_sha256 TEXT NOT NULL,
  ip_key TEXT,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX vneid_audit_by_citizen ON vneid_audit (citizen_key, created_at);
CREATE INDEX vneid_audit_by_time ON vneid_audit (created_at);
`;

/** v2: the RFC 3161 token over the signature, taken at the first finalize. */
const SCHEMA_V2 = `
ALTER TABLE vneid_transactions ADD COLUMN timestamp_token BLOB;
`;

/** v3: certificate registrations, one open per citizen. */
const SCHEMA_V3 = `
CREATE TABLE vneid_registrations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  citizen_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  service_pack_code TEXT NOT NULL,
  service_pack_name TEXT NOT NULL,
  service_pack_months INTEGER,
  unit_price REAL,
  transaction_code TEXT UNIQUE,
  status TEXT NOT NULL,
  csign_status INTEGER,
  error_code TEXT,
  serial_number TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  expires_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE UNIQUE INDEX vneid_one_open_registration_per_citizen
  ON vneid_registrations (citizen_key)
  WHERE status IN ('SUBMITTING', 'PENDING', 'ISSUED');
CREATE INDEX vneid_registrations_by_citizen ON vneid_registrations (citizen_key, created_at);
`;

const SELECT_REGISTRATION = `SELECT
  id, request_id AS requestId, citizen_key AS citizenKey, provider, provider_name AS providerName,
  service_pack_code AS servicePackCode, service_pack_name AS servicePackName,
  service_pack_months AS servicePackMonths, unit_price AS unitPrice,
  transaction_code AS transactionCode, status, csign_status AS csignStatus,
  error_code AS errorCode, serial_number AS serialNumber, created_at AS createdAt,
  updated_at AS updatedAt, last_checked_at AS lastCheckedAt, expires_at AS expiresAt,
  finished_at AS finishedAt
  FROM vneid_registrations`;

const OPEN_REGISTRATION_LIST = OPEN_REGISTRATION_STATUSES.map((status) => `'${status}'`).join(', ');

const COLUMNS: Record<keyof TransactionRow, string> = {
  id: 'id',
  requestId: 'request_id',
  documentId: 'document_id',
  documentName: 'document_name',
  digestValue: 'digest_value',
  credentialId: 'credential_id',
  certIssuerCn: 'cert_issuer_cn',
  certValidTo: 'cert_valid_to',
  certChainEnc: 'cert_chain_enc',
  preparedEnc: 'prepared_enc',
  csignTransactionId: 'csign_transaction_id',
  rscaTransactionId: 'rsca_transaction_id',
  providerInternalId: 'provider_internal_id',
  documentNumber: 'document_number',
  csignStatus: 'csign_status',
  errorCode: 'error_code',
  signature: 'signature',
  signatureSource: 'signature_source',
  timestampToken: 'timestamp_token',
  signedAt: 'signed_at',
  status: 'status',
  citizenKey: 'citizen_key',
  clientSecretHash: 'client_secret_hash',
  codeHash: 'code_hash',
  codeAttempts: 'code_attempts',
  originalSha256: 'original_sha256',
  originalLength: 'original_length',
  prevSignatureCount: 'prev_signature_count',
  xrefKind: 'xref_kind',
  createdAt: 'created_at',
  confirmDeadline: 'confirm_deadline',
  expiresAt: 'expires_at',
  updatedAt: 'updated_at',
  lastCheckedAt: 'last_checked_at',
  finalizedAt: 'finalized_at',
  finalizeCount: 'finalize_count',
};

const BLOB_FIELDS = new Set<keyof TransactionRow>([
  'certChainEnc',
  'preparedEnc',
  'signature',
  'timestampToken',
  'clientSecretHash',
  'codeHash',
  'originalSha256',
]);

const SELECT_ROW = `SELECT ${Object.entries(COLUMNS)
  .map(([field, column]) => `${column} AS ${field}`)
  .join(', ')} FROM vneid_transactions`;

const OPEN_LIST = OPEN_STATUSES.map((status) => `'${status}'`).join(', ');

function toRow(raw: Record<string, unknown> | undefined): TransactionRow | undefined {
  if (!raw) return undefined;
  const row: Record<string, unknown> = { ...raw };
  for (const field of BLOB_FIELDS) {
    const value = row[field];
    if (value instanceof Uint8Array) row[field] = Buffer.from(value);
  }
  return row as unknown as TransactionRow;
}

function isUniqueViolation(error: unknown, index: string): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed/i.test(error.message) &&
    error.message.includes(index)
  );
}

export class VneidStore {
  private readonly statements = new Map<string, StatementSync>();

  private constructor(private readonly db: DatabaseSync) {}

  /** Opens (creating it and its folder if needed) and migrates the database.
   * `:memory:` gives a throwaway database for tests. */
  static open(file: string): VneidStore {
    const sqlite = process.getBuiltinModule('node:sqlite');
    if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
      throw new Error('node:sqlite is not available in this runtime');
    }
    if (file !== ':memory:')
      mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
    const db = new sqlite.DatabaseSync(file);
    try {
      if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA secure_delete = ON');
      db.exec('PRAGMA synchronous = NORMAL');
      const store = new VneidStore(db);
      store.migrate();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  private statement(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.statement(sql).run(...params).changes);
  }

  private migrate(): void {
    const version = Number(
      (this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)
        ?.user_version ?? 0
    );
    if (version > SCHEMA_VERSION) {
      throw new Error(`VNeID database is newer (v${version}) than this code (v${SCHEMA_VERSION})`);
    }
    if (version < SCHEMA_VERSION) {
      this.transaction(() => {
        if (version < 1) this.db.exec(SCHEMA_V1);
        if (version < 2) this.db.exec(SCHEMA_V2);
        if (version < 3) this.db.exec(SCHEMA_V3);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
  }

  /** BEGIN IMMEDIATE ... COMMIT around synchronous work only. */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      if (result instanceof Promise)
        throw new Error('a store transaction cannot wait on a promise');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---- reading ---------------------------------------------------------------------

  get(id: string): TransactionRow | undefined {
    return toRow(this.statement(`${SELECT_ROW} WHERE id = ?`).get(id));
  }

  getByCsignTransactionId(csignTransactionId: string): TransactionRow | undefined {
    return toRow(
      this.statement(`${SELECT_ROW} WHERE csign_transaction_id = ?`).get(csignTransactionId)
    );
  }

  // ---- creating a request ---------------------------------------------------------------

  /**
   * Reserves the citizen's single open request and opens its audit entry.
   * 'citizen-busy' when another one is still open (after first expiring this
   * citizen's overdue ones).
   */
  reserve(
    row: NewTransaction,
    audit: { documentSha256: string; ipKey: string | undefined },
    submittingTtlMs: number
  ): 'reserved' | 'citizen-busy' {
    return this.transaction(() => {
      this.expireOverdueWhere('citizen_key = ?', [row.citizenKey], row.createdAt, submittingTtlMs);
      try {
        this.run(
          `INSERT INTO vneid_transactions (
             id, request_id, document_id, document_name, status, citizen_key,
             client_secret_hash, code_hash, original_sha256, original_length,
             prev_signature_count, xref_kind, created_at, confirm_deadline, expires_at, updated_at
           ) VALUES (?, ?, ?, ?, 'SUBMITTING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.id,
          row.requestId,
          row.documentId,
          row.documentName,
          row.citizenKey,
          row.clientSecretHash,
          row.codeHash,
          row.originalSha256,
          row.originalLength,
          row.prevSignatureCount,
          row.xrefKind,
          row.createdAt,
          row.confirmDeadline,
          row.expiresAt,
          row.createdAt
        );
      } catch (error) {
        if (isUniqueViolation(error, 'citizen_key')) return 'citizen-busy';
        throw error;
      }
      this.run(
        `INSERT INTO vneid_audit
           (id, citizen_key, document_sha256, ip_key, outcome, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'SUBMITTING', ?, ?)`,
        row.id,
        row.citizenKey,
        audit.documentSha256,
        audit.ipKey ?? null,
        row.createdAt,
        row.createdAt
      );
      return 'reserved';
    });
  }

  /** The audit outcome mirrors the transaction status (the audit row outlives it). */
  private syncAudit(condition: string, ...params: SQLInputValue[]): void {
    this.run(
      `UPDATE vneid_audit
         SET outcome = (SELECT status FROM vneid_transactions t WHERE t.id = vneid_audit.id),
             updated_at = (SELECT updated_at FROM vneid_transactions t WHERE t.id = vneid_audit.id)
       WHERE id IN (SELECT id FROM vneid_transactions WHERE ${condition})`,
      ...params
    );
  }

  /** Runs a single-row state change and keeps the audit in step. */
  private change(id: string, sql: string, ...params: SQLInputValue[]): boolean {
    const changed = this.run(sql, ...params) === 1;
    if (changed) this.syncAudit('id = ?', id);
    return changed;
  }

  attachPrepared(id: string, data: PreparedData, now: number): boolean {
    return (
      this.run(
        `UPDATE vneid_transactions
           SET digest_value = ?, credential_id = ?, cert_issuer_cn = ?, cert_valid_to = ?,
               cert_chain_enc = ?, prepared_enc = ?, updated_at = ?
         WHERE id = ? AND status = 'SUBMITTING'`,
        data.digestValue,
        data.credentialId,
        data.certIssuerCn,
        data.certValidTo,
        data.certChainEnc,
        data.preparedEnc,
        now,
        id
      ) === 1
    );
  }

  /** sign-hash accepted: the clocks start now. */
  markSubmitted(
    id: string,
    csign: { transactionId: string; rscaTransactionId: string | undefined },
    times: { now: number; confirmDeadline: number; expiresAt: number }
  ): boolean {
    return this.change(
      id,
      `UPDATE vneid_transactions
         SET status = 'PENDING', csign_transaction_id = ?, rsca_transaction_id = ?,
             confirm_deadline = ?, expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'SUBMITTING'`,
      csign.transactionId,
      csign.rscaTransactionId ?? null,
      times.confirmDeadline,
      times.expiresAt,
      times.now,
      id
    );
  }

  // ---- progress ---------------------------------------------------------------------------

  /** At most one CSign status check per transaction per interval. */
  claimStatusCheck(id: string, now: number, minIntervalMs: number): boolean {
    return (
      this.run(
        `UPDATE vneid_transactions SET last_checked_at = ?
         WHERE id = ? AND status IN ('PENDING', 'WAITING_USER')
           AND (last_checked_at IS NULL OR last_checked_at <= ?)`,
        now,
        id,
        now - minIntervalMs
      ) === 1
    );
  }

  /** CSign status 1-3 seen: 3 means the push reached the citizen. */
  markProgress(id: string, csignStatus: number, now: number): boolean {
    return this.change(
      id,
      `UPDATE vneid_transactions
         SET csign_status = ?, updated_at = ?,
             status = CASE WHEN ? = 3 THEN 'WAITING_USER' ELSE status END
       WHERE id = ? AND status IN ('PENDING', 'WAITING_USER')`,
      csignStatus,
      now,
      csignStatus,
      id
    );
  }

  /**
   * The signature is in (already verified by the caller). Accepted from an
   * open request, and from one we expired ourselves up to `lateGraceMs` after
   * its deadline: CSign may finish just after our clock ran out.
   */
  markSigned(id: string, data: SignedData, now: number, lateGraceMs: number): boolean {
    return this.change(
      id,
      `UPDATE vneid_transactions
         SET status = 'SIGNED', signature = ?, signature_source = ?, signed_at = ?,
             csign_status = ?, provider_internal_id = COALESCE(?, provider_internal_id),
             document_number = COALESCE(?, document_number), error_code = NULL, updated_at = ?
       WHERE id = ? AND signature IS NULL
         AND (status IN ('PENDING', 'WAITING_USER')
              OR (status = 'EXPIRED' AND ? <= expires_at + ?))`,
      data.signature,
      data.source,
      data.signedAt,
      data.csignStatus,
      data.providerInternalId ?? null,
      data.documentNumber ?? null,
      now,
      id,
      now,
      lateGraceMs
    );
  }

  /** Ends an open request (refused, expired, failed); frees the citizen. */
  markEnded(
    id: string,
    status: EndStatus,
    detail: { errorCode: string; csignStatus?: number | undefined },
    now: number
  ): boolean {
    return this.change(
      id,
      `UPDATE vneid_transactions
         SET status = ?, error_code = ?, csign_status = COALESCE(?, csign_status), updated_at = ?
       WHERE id = ? AND status IN (${OPEN_LIST})`,
      status,
      detail.errorCode,
      detail.csignStatus ?? null,
      now,
      id
    );
  }

  // ---- finalize ---------------------------------------------------------------------------

  /** Counts a wrong confirmation code; at `maxAttempts` the transaction is burned. */
  recordCodeFailure(id: string, maxAttempts: number, now: number): 'retry' | 'burned' {
    return this.transaction(() => {
      this.run(
        `UPDATE vneid_transactions SET code_attempts = code_attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'SIGNED'`,
        now,
        id
      );
      const burned = this.change(
        id,
        `UPDATE vneid_transactions SET status = 'BURNED', updated_at = ?
         WHERE id = ? AND status = 'SIGNED' AND code_attempts >= ?`,
        now,
        id,
        maxAttempts
      );
      return burned ? 'burned' : 'retry';
    });
  }

  claimFinalize(id: string, maxCount: number): boolean {
    return (
      this.run(
        `UPDATE vneid_transactions SET finalize_count = finalize_count + 1
         WHERE id = ? AND status IN ('SIGNED', 'FINALIZED') AND finalize_count < ?`,
        id,
        maxCount
      ) === 1
    );
  }

  /** Keeps the first token only: every later download embeds the same one. */
  saveTimestamp(id: string, token: Buffer, now: number): boolean {
    return (
      this.run(
        `UPDATE vneid_transactions SET timestamp_token = ?, updated_at = ?
         WHERE id = ? AND status IN ('SIGNED', 'FINALIZED') AND timestamp_token IS NULL`,
        token,
        now,
        id
      ) === 1
    );
  }

  markFinalized(id: string, now: number): void {
    this.change(
      id,
      `UPDATE vneid_transactions
         SET status = 'FINALIZED', finalized_at = COALESCE(finalized_at, ?), updated_at = ?
       WHERE id = ? AND status IN ('SIGNED', 'FINALIZED')`,
      now,
      now,
      id
    );
  }

  // ---- webhook events ---------------------------------------------------------------------

  hasWebhookEvent(eventId: string): boolean {
    return (
      this.statement('SELECT 1 FROM vneid_webhook_events WHERE event_id = ?').get(eventId) !==
      undefined
    );
  }

  /** false when the event was already recorded (a redelivery). */
  recordWebhookEvent(
    event: { id: string; csignTransactionId: string | undefined; name: string; outcome: string },
    now: number
  ): boolean {
    return (
      this.run(
        `INSERT OR IGNORE INTO vneid_webhook_events
           (event_id, csign_transaction_id, event_name, outcome, received_at)
         VALUES (?, ?, ?, ?, ?)`,
        event.id,
        event.csignTransactionId ?? null,
        event.name,
        event.outcome,
        now
      ) === 1
    );
  }

  // ---- housekeeping -----------------------------------------------------------------------

  private expireOverdueWhere(
    condition: string,
    params: SQLInputValue[],
    now: number,
    submittingTtlMs: number
  ): number {
    const changed = this.run(
      `UPDATE vneid_transactions
         SET status = CASE WHEN status = 'SUBMITTING' THEN 'FAILED' ELSE 'EXPIRED' END,
             error_code = COALESCE(error_code,
               CASE WHEN status = 'SUBMITTING' THEN 'SUBMIT_ABANDONED' ELSE 'LOCAL_TIMEOUT' END),
             updated_at = ?
       WHERE ${condition}
         AND ((status IN ('PENDING', 'WAITING_USER') AND expires_at <= ?)
              OR (status = 'SUBMITTING' AND created_at <= ?))`,
      now,
      ...params,
      now,
      now - submittingTtlMs
    );
    if (changed > 0) this.syncAudit(`updated_at = ? AND status IN ('EXPIRED', 'FAILED')`, now);
    return changed;
  }

  /** Requests past their deadline become EXPIRED (SUBMITTING ones FAILED);
   * registrations past theirs are deleted. Returns the number of signing
   * requests changed. */
  expireOverdue(now: number, submittingTtlMs: number): number {
    const changed = this.expireOverdueWhere('1 = 1', [], now, submittingTtlMs);
    this.retireRegistrationsWhere('1 = 1', [], now, submittingTtlMs);
    return changed;
  }

  /** Drops finished requests and old webhook events after `keepMs`, audit rows after `auditKeepMs`. */
  sweep(now: number, keepMs: number, auditKeepMs: number): void {
    this.transaction(() => {
      this.run(
        `DELETE FROM vneid_transactions WHERE created_at <= ? AND status NOT IN (${OPEN_LIST})`,
        now - keepMs
      );
      this.run('DELETE FROM vneid_webhook_events WHERE received_at <= ?', now - keepMs);
      this.run('DELETE FROM vneid_audit WHERE created_at <= ?', now - auditKeepMs);
    });
  }

  // ---- certificate registrations ----------------------------------------------------------

  /** Reserves the citizen's single open registration ('citizen-busy' when one
   * is open, after first removing this citizen's overdue ones). */
  reserveRegistration(row: NewRegistration, submittingTtlMs: number): 'reserved' | 'citizen-busy' {
    return this.transaction(() => {
      this.retireRegistrationsWhere(
        'citizen_key = ?',
        [row.citizenKey],
        row.createdAt,
        submittingTtlMs
      );
      try {
        this.run(
          `INSERT INTO vneid_registrations (
             id, request_id, citizen_key, provider, provider_name, service_pack_code,
             service_pack_name, service_pack_months, unit_price, status, created_at,
             updated_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTING', ?, ?, ?)`,
          row.id,
          row.requestId,
          row.citizenKey,
          row.provider,
          row.providerName,
          row.servicePackCode,
          row.servicePackName,
          row.servicePackMonths,
          row.unitPrice,
          row.createdAt,
          row.createdAt,
          row.expiresAt
        );
      } catch (error) {
        if (isUniqueViolation(error, 'citizen_key')) return 'citizen-busy';
        throw error;
      }
      return 'reserved';
    });
  }

  getRegistration(id: string): RegistrationRow | undefined {
    return this.statement(`${SELECT_REGISTRATION} WHERE id = ?`).get(id) as
      RegistrationRow | undefined;
  }

  /** The citizen's newest registration still within its lifetime, open or
   * finished (overdue ones are deleted first). */
  latestRegistration(
    citizenKey: string,
    now: number,
    submittingTtlMs: number
  ): RegistrationRow | undefined {
    this.retireRegistrationsWhere('citizen_key = ?', [citizenKey], now, submittingTtlMs);
    return this.statement(
      `${SELECT_REGISTRATION} WHERE citizen_key = ? ORDER BY created_at DESC LIMIT 1`
    ).get(citizenKey) as RegistrationRow | undefined;
  }

  /** CSign accepted the registration and named its transactionCode. */
  markRegistrationSubmitted(id: string, transactionCode: string, now: number): boolean {
    return (
      this.run(
        `UPDATE vneid_registrations SET status = 'PENDING', transaction_code = ?, updated_at = ?
         WHERE id = ? AND status = 'SUBMITTING'`,
        transactionCode,
        now,
        id
      ) === 1
    );
  }

  /** At most one CSign status check per registration per interval. */
  claimRegistrationCheck(id: string, now: number, minIntervalMs: number): boolean {
    return (
      this.run(
        `UPDATE vneid_registrations SET last_checked_at = ?
         WHERE id = ? AND status IN ('PENDING', 'ISSUED') AND transaction_code IS NOT NULL
           AND (last_checked_at IS NULL OR last_checked_at <= ?)`,
        now,
        id,
        now - minIntervalMs
      ) === 1
    );
  }

  /** Still open, as CSign last reported it. */
  markRegistrationProgress(
    id: string,
    status: 'PENDING' | 'ISSUED',
    csignStatus: number,
    now: number
  ): boolean {
    return (
      this.run(
        `UPDATE vneid_registrations SET status = ?, csign_status = ?, updated_at = ?
         WHERE id = ? AND status IN ('PENDING', 'ISSUED')`,
        status,
        csignStatus,
        now,
        id
      ) === 1
    );
  }

  /** The outcome. Only an open registration can end, and only once. */
  finishRegistration(
    id: string,
    status: 'COMPLETED' | 'FAILED' | 'REJECTED' | 'EXPIRED',
    details: { csignStatus?: number; errorCode?: string; serialNumber?: string },
    now: number
  ): boolean {
    return (
      this.run(
        `UPDATE vneid_registrations
           SET status = ?, csign_status = COALESCE(?, csign_status),
               error_code = COALESCE(?, error_code), serial_number = COALESCE(?, serial_number),
               updated_at = ?, finished_at = ?
         WHERE id = ? AND status IN (${OPEN_REGISTRATION_LIST})`,
        status,
        details.csignStatus ?? null,
        details.errorCode ?? null,
        details.serialNumber ?? null,
        now,
        now,
        id
      ) === 1
    );
  }

  /**
   * A registration lives until its `expires_at` -- the 30 minutes a CSign
   * transaction lasts -- and is then deleted, whatever came of it. Before
   * that, a submission CSign never answered fails after `submittingTtlMs`.
   */
  private retireRegistrationsWhere(
    condition: string,
    params: SQLInputValue[],
    now: number,
    submittingTtlMs: number
  ): void {
    this.run(
      `DELETE FROM vneid_registrations WHERE ${condition} AND expires_at <= ?`,
      ...params,
      now
    );
    this.run(
      `UPDATE vneid_registrations
         SET status = 'FAILED', error_code = COALESCE(error_code, 'SUBMIT_ABANDONED'),
             updated_at = ?, finished_at = ?
       WHERE ${condition} AND status = 'SUBMITTING' AND created_at <= ?`,
      now,
      now,
      ...params,
      now - submittingTtlMs
    );
  }

  // ---- audit and limits -------------------------------------------------------------------

  /** Signing requests (service-wide) since `since`; audit rows outlive transactions.
   * A request that failed before sign-hash (no certificate, bad PDF...) sent
   * nothing to anyone's phone and is left out: made-up CCCDs cannot use up the
   * daily cap. One whose row is already swept still counts. */
  countRequestsSince(since: number): number {
    const row = this.statement(
      `SELECT COUNT(*) AS count FROM vneid_audit a
         LEFT JOIN vneid_transactions t ON t.id = a.id
       WHERE a.created_at > ?
         AND (t.id IS NULL OR t.csign_transaction_id IS NOT NULL OR t.status <> 'FAILED')`
    ).get(since) as { count: number };
    return Number(row.count);
  }

  /** Refused or ignored requests of one citizen since `since` (successes do not count). */
  citizenMisses(citizenKey: string, since: number): { count: number; lastAt: number | undefined } {
    const row = this.statement(
      `SELECT COUNT(*) AS count, MAX(updated_at) AS lastAt FROM vneid_audit
       WHERE citizen_key = ? AND created_at > ? AND outcome IN ('REJECTED', 'EXPIRED')`
    ).get(citizenKey, since) as { count: number; lastAt: number | null };
    return { count: Number(row.count), lastAt: row.lastAt ?? undefined };
  }
}
