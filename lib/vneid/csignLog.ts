import { sanitizeLogText } from '../cas/casPayload';

/**
 * Log of every exchange with the CSign gateway, so what CSign really answers
 * can be read in the server terminal.
 *
 * Development (`npm run dev`): one block per call with the request and the
 * answer as JSON. Production: one summary line per call (path, HTTP status,
 * duration, size, CSign code) -- no bodies.
 *
 * Bodies are redacted before they are printed:
 *   - password, tokens and keys          -> "[hidden]" (any JWT anywhere -> "[jwt]");
 *   - CCCD numbers (citizenPid, signerCCCD) -> only the last 3 digits;
 *   - subjectDN, the registration form (userInfo) and other personal fields -> "[hidden]";
 *   - certificates                        -> their count / length;
 *   - signatures                          -> their size in bytes;
 *   - any other long digit run            -> "[redacted-number]".
 * Identifiers (transaction, request, document, credential ids, serials) are
 * kept: they are what CSign support asks for.
 */

const SECRET_KEYS = new Set([
  'password',
  'token',
  'refreshtoken',
  'accesstoken',
  'secret',
  'secretkey',
  'key',
]);
const CITIZEN_KEYS = new Set(['citizenpid', 'signercccd', 'cccd']);
const PERSONAL_KEYS = new Set([
  // The whole registration form: name, birth date, addresses, phone, email.
  'userinfo',
  'subjectdn',
  'fullname',
  'name',
  'birthdate',
  'phone',
  'email',
  'address',
]);
const ID_KEYS = new Set([
  'transactionid',
  'rscatransactionid',
  'providertransactionid',
  'providerinternalid',
  'requestid',
  'documentid',
  'documentnumber',
  'credentialid',
  'credentialids',
  'serialnumber',
  'certificateid',
  'transactioncode',
  'id',
]);
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const MAX_DEPTH = 8;
const MAX_ITEMS = 20;

const maskCitizen = (value: string) =>
  value.length > 3 ? `${'*'.repeat(value.length - 3)}${value.slice(-3)}` : '***';

function redactString(value: string, key: string): string {
  if (ID_KEYS.has(key)) return value;
  return sanitizeLogText(value.replace(JWT_PATTERN, '[jwt]'), 300);
}

/** A copy of `value` that is safe to print (see the module comment). */
export function redactForLog(value: unknown, key = '', depth = 0): unknown {
  const name = key.toLowerCase();
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[...]';
  if (SECRET_KEYS.has(name)) return '[hidden]';
  if (CITIZEN_KEYS.has(name)) return typeof value === 'string' ? maskCitizen(value) : '[hidden]';
  if (PERSONAL_KEYS.has(name)) return '[hidden]';
  if (name === 'certificates' && Array.isArray(value)) {
    return `[${value.length} certificate(s): ${value
      .map((item) => (typeof item === 'string' ? `${item.length} chars` : '?'))
      .join(', ')}]`;
  }
  if (name === 'certificatedata' && typeof value === 'string') {
    return `[certificate, ${value.length} chars]`;
  }
  if (name === 'certificatedata' && Array.isArray(value)) {
    return `[${value.length} certificate(s)]`;
  }
  if (name === 'signature' && typeof value === 'string') {
    const compact = value.replace(/\s+/g, '');
    const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
    return `[signature, ${Math.floor((compact.length * 3) / 4) - padding} bytes]`;
  }
  if (typeof value === 'string') return redactString(value, name);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => redactForLog(item, key, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `...(+${value.length - MAX_ITEMS})`] : items;
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactForLog(entryValue, entryKey, depth + 1),
      ])
    );
  }
  return `[${typeof value}]`;
}

export interface CsignExchangeLog {
  path: string;
  /** Undefined when no answer came back (network, timeout). */
  httpStatus: number | undefined;
  ms: number;
  bytes?: number | undefined;
  /** RAR-HUB / CSign status code read from the answer. */
  code?: string | undefined;
  request: unknown;
  response?: unknown;
  /** Why there is no usable answer. */
  failure?: string | undefined;
}

const verbose = () => process.env.NODE_ENV !== 'production';

export function logCsignExchange(entry: CsignExchangeLog): void {
  const outcome = entry.httpStatus === undefined ? 'no answer' : `HTTP ${entry.httpStatus}`;
  const summary = {
    ms: entry.ms,
    ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
    ...(entry.code === undefined ? {} : { code: entry.code }),
    ...(entry.failure === undefined ? {} : { failure: entry.failure }),
  };
  const line = `[vneid:csign] ${entry.path} -> ${outcome}`;
  if (!verbose()) {
    console.info(line, summary);
    return;
  }
  // JSON, so nested answers print in full instead of as "[Object]".
  console.info(
    `${line}\n${JSON.stringify(
      {
        ...summary,
        request: redactForLog(entry.request),
        ...(entry.response === undefined ? {} : { response: redactForLog(entry.response) }),
      },
      null,
      2
    )}`
  );
}
