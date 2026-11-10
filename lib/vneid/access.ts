import { clientAddressFromHeaders, parseIpAddress } from '../rateLimit';
import { VneidError, type VneidErrorCode } from './errors';
import { errorResponse, languageOf } from './http';

/**
 * Who may use VNeID at all (signing, certificate lookup, registration, the
 * /vneid page): the addresses in VNEID_TRUSTED_IPS, a comma-separated list of
 * IPv4/IPv6 addresses and CIDR ranges. Empty: everyone (local development).
 *
 * The list is only as good as the client IP it is checked against, so it
 * needs TRUSTED_IP_HEADER (the header the reverse proxy sets from the real
 * connection, e.g. x-real-ip). Without it the IP would come from headers any
 * client can write, and VNeID is closed to everyone instead. So is it when an
 * entry of the list cannot be read: a typo must not open the feature.
 *
 * The CSign webhook is not behind this list: it is authenticated by its HMAC.
 */

interface Range {
  bytes: Uint8Array;
  prefix: number;
}

type TrustedList =
  { kind: 'open' } | { kind: 'list'; ranges: Range[] } | { kind: 'closed'; reason: string };

let cached: { source: string; header: string; list: TrustedList } | undefined;

function parseRange(entry: string): Range | undefined {
  const [address, bits, extra] = entry.split('/');
  if (extra !== undefined) return undefined;
  const bytes = parseIpAddress(address);
  if (!bytes) return undefined;
  const max = bytes.length * 8;
  const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : Number.NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return undefined;
  return { bytes, prefix };
}

function trustedList(): TrustedList {
  const source = process.env.VNEID_TRUSTED_IPS?.trim() ?? '';
  const header = process.env.TRUSTED_IP_HEADER?.trim() ?? '';
  if (cached && cached.source === source && cached.header === header) return cached.list;

  let list: TrustedList;
  if (!source) {
    list = { kind: 'open' };
  } else if (!header) {
    list = {
      kind: 'closed',
      reason:
        'VNEID_TRUSTED_IPS is set but TRUSTED_IP_HEADER is not: the client IP could be faked, ' +
        'so VNeID is closed to everyone',
    };
  } else {
    const ranges = source
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(parseRange);
    list = ranges.every((range): range is Range => range !== undefined)
      ? { kind: 'list', ranges }
      : {
          kind: 'closed',
          reason:
            'VNEID_TRUSTED_IPS has an entry that is not an IP address or CIDR range: ' +
            'VNeID is closed to everyone',
        };
  }
  if (list.kind === 'closed') console.error(`[vneid:access] ${list.reason}`);
  cached = { source, header, list };
  return list;
}

function inRange(address: Uint8Array, range: Range): boolean {
  if (address.length !== range.bytes.length) return false;
  for (let index = 0, bits = range.prefix; bits > 0; index += 1, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((address[index]! & mask) !== (range.bytes[index]! & mask)) return false;
  }
  return true;
}

/** Whether the client behind these request headers may use VNeID. */
export function isVneidClientAllowed(headers: Pick<Headers, 'get'>): boolean {
  const list = trustedList();
  if (list.kind === 'open') return true;
  if (list.kind === 'closed') return false;
  const address = clientAddressFromHeaders(headers);
  return address !== undefined && list.ranges.some((range) => inRange(address, range));
}

const DENIED: ReadonlySet<VneidErrorCode> = new Set(['VNEID_ACCESS_DENIED']);

/** The 403 a VNeID route answers a client outside the list with, else null. */
export function vneidAccessDenied(request: Request): Response | null {
  if (isVneidClientAllowed(request.headers)) return null;
  return errorResponse(new VneidError('VNEID_ACCESS_DENIED', 'client IP is not trusted'), {
    route: 'access',
    allowed: DENIED,
    language: languageOf(request),
  });
}
