/**
 * In-memory per-IP token bucket (no Redis — stateless-by-design).
 * Fail-closed: once a bucket is empty, requests are rejected until it
 * refills. Scoped per Node process, so this only makes sense for the
 * single-instance Local/Server modes.
 */
type Bucket = { tokens: number; lastRefillAt: number; windowMs: number };

const buckets = new Map<string, Bucket>();

/** Upper bound on tracked keys. A bucket idle for a whole window has refilled
 * completely, so it is equivalent to no bucket and gets swept; if the table is
 * STILL full of active buckets, the least recently used one is dropped. Refusing
 * every new key instead would let anyone who fills the table (with many
 * addresses) lock every new client out of every route. */
const MAX_BUCKETS = 50_000;
/** Sweep idle buckets after this many new keys, so the map cannot grow without bound. */
const SWEEP_EVERY_NEW_KEYS = 1_000;
let newKeysSinceSweep = 0;

function sweepIdleBuckets(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefillAt >= bucket.windowMs) buckets.delete(key);
  }
}

export interface RateLimitOptions {
  /** Requests allowed per `windowMs`. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the next request would be allowed; 0 when `allowed`. */
  retryAfterSeconds: number;
}

export function checkRateLimit(key: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    newKeysSinceSweep += 1;
    if (newKeysSinceSweep >= SWEEP_EVERY_NEW_KEYS) {
      newKeysSinceSweep = 0;
      sweepIdleBuckets(now);
    }
    if (buckets.size >= MAX_BUCKETS) {
      sweepIdleBuckets(now);
      if (buckets.size >= MAX_BUCKETS) {
        // Every slot is active: drop the least recently used (Map order).
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
    }
    bucket = { tokens: options.limit, lastRefillAt: now, windowMs: options.windowMs };
  } else {
    // Move to the end of the Map: the order is least recently used first.
    buckets.delete(key);
  }
  bucket.windowMs = options.windowMs;

  const elapsed = now - bucket.lastRefillAt;
  const refill = (elapsed / options.windowMs) * options.limit;
  bucket.tokens = Math.min(options.limit, bucket.tokens + refill);
  bucket.lastRefillAt = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    const msUntilOneToken = ((1 - bucket.tokens) / options.limit) * options.windowMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(msUntilOneToken / 1000)) };
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return { allowed: true, retryAfterSeconds: 0 };
}

/** The 429 every route returns once `checkRateLimit` says no -- one shape,
 * with `Retry-After` so callers know how long to back off. */
export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { error: 'RATE_LIMITED', message: 'Too many requests' },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}

function parseIpv4(text: string): [number, number, number, number] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] as [
    number,
    number,
    number,
    number,
  ];
  return parts.every((part) => part <= 255) ? parts : undefined;
}

/** Eight 16-bit groups, or undefined if `text` is not an IPv6 address. */
function parseIpv6(text: string): number[] | undefined {
  let rest = text.toLowerCase();
  const zone = rest.indexOf('%');
  if (zone >= 0) rest = rest.slice(0, zone);
  // "::ffff:1.2.3.4": the last 32 bits written as an IPv4 address.
  let embedded: [number, number] | undefined;
  if (rest.includes('.')) {
    const cut = rest.lastIndexOf(':');
    const v4 = parseIpv4(rest.slice(cut + 1));
    if (cut < 0 || !v4) return undefined;
    embedded = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    rest = `${rest.slice(0, cut + 1)}0:0`;
  }
  const halves = rest.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string) =>
    part === ''
      ? []
      : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const given = [...head, ...tail];
  if (given.some(Number.isNaN)) return undefined;
  const missing = 8 - given.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const all = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  if (embedded) {
    all[6] = embedded[0];
    all[7] = embedded[1];
  }
  return all.length === 8 ? all : undefined;
}

/**
 * The key a client is limited under: an IPv4 address as is, an IPv6 address as
 * its /64 (a subscriber is usually handed a whole /64 and can rotate through
 * it freely, so per-address limits would be no limits), an IPv4-mapped IPv6
 * address as the IPv4 it wraps. Anything that is not an IP address is rejected
 * (undefined) instead of becoming a key an attacker can vary at will.
 */
export function normalizeClientIp(raw: string | null | undefined): string | undefined {
  let text = (raw ?? '').trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed) text = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(':'));

  const v4 = parseIpv4(text);
  if (v4) return v4.join('.');
  const v6 = parseIpv6(text);
  if (!v6) return undefined;
  if (v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff) {
    return [v6[6]! >> 8, v6[6]! & 255, v6[7]! >> 8, v6[7]! & 255].join('.');
  }
  return `${v6
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/**
 * Best-effort client IP for single-instance Local/Server deployments. This is
 * NOT a hard security boundary (there's no auth in front of these routes to
 * begin with) -- it just makes casual abuse/cost-runup meaningfully harder,
 * not impossible. Which header to believe depends on what sits in front of
 * the app:
 *
 * - `TRUSTED_IP_HEADER` set (VPS: `x-real-ip`): ONLY that header is read. Set
 *   it to the header your own reverse proxy overwrites on every request (the
 *   `deploy/nginx.conf.example` sets `X-Real-IP $remote_addr`, after its
 *   real_ip handling of Cloudflare), so a client cannot choose it. Reading
 *   `CF-Connecting-IP` instead is NOT safe off Cloudflare: anyone who can reach
 *   the app directly can send that header with any value they like.
 *
 * - unset (the Cloudflare Worker, and older setups): `CF-Connecting-IP` is
 *   trusted first, because Cloudflare overwrites it itself at the edge on every
 *   request that reaches a Worker. Otherwise `X-Forwarded-For` is used, but the
 *   LAST entry is taken, not the first: a proxy that appends (nginx's
 *   `$proxy_add_x_forwarded_for`) puts the real client address at the END of
 *   the chain, while the first entry is whatever the client put there itself.
 *
 * Whatever is read is normalized (see `normalizeClientIp`); a missing or
 * malformed value falls into the shared `unknown` bucket.
 */
export function clientIpFromRequest(request: Request): string {
  return normalizeClientIp(clientIpHeaderValue(request.headers)) ?? 'unknown';
}

/** The header value the client IP is read from, by the rules above. */
function clientIpHeaderValue(headers: Pick<Headers, 'get'>): string | undefined {
  const trustedHeader = process.env.TRUSTED_IP_HEADER?.trim().toLowerCase();
  if (trustedHeader) return headers.get(trustedHeader)?.split(',').at(-1);

  const cfConnectingIp = headers.get('cf-connecting-ip');
  if (cfConnectingIp) return cfConnectingIp;

  const forwardedFor = headers.get('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',').at(-1);
  return undefined;
}
