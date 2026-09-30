/**
 * In-memory per-IP token bucket (no Redis — stateless-by-design).
 * Fail-closed: once a bucket is empty, requests are rejected until it
 * refills. Scoped per Node process, so this only makes sense for the
 * single-instance Local/Server modes.
 */
type Bucket = { tokens: number; lastRefillAt: number };

const buckets = new Map<string, Bucket>();

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
  const bucket = buckets.get(key) ?? { tokens: options.limit, lastRefillAt: now };

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
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
  );
}

/**
 * Best-effort client IP for single-instance Local/Server deployments. This is
 * NOT a hard security boundary (there's no auth in front of these routes to
 * begin with) -- it just makes casual abuse/cost-runup meaningfully harder,
 * not impossible.
 *
 * `CF-Connecting-IP` is trusted first when present: Cloudflare overwrites this
 * header itself at the edge on every request that reaches a Worker, so a
 * client cannot forge it through Cloudflare's own proxy.
 *
 * Otherwise, `X-Forwarded-For` is used, but the LAST entry is taken, not the
 * first. A reverse proxy that appends (nginx's `$proxy_add_x_forwarded_for`,
 * the convention `docs/DEPLOY.md` documents) puts the real client address at
 * the END of the chain; taking the first entry instead trusts whatever the
 * client itself already put there, which is fully attacker-controlled and
 * defeats the limiter entirely (a new value each request looks like a new
 * "IP"). Taking the last entry still isn't perfect without knowing the exact
 * proxy chain depth, but it can no longer be spoofed by the client alone.
 */
export function clientIpFromRequest(request: Request): string {
  const cfConnectingIp = request.headers.get('cf-connecting-ip');
  if (cfConnectingIp) return cfConnectingIp.trim();

  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const parts = forwardedFor.split(',');
    return parts[parts.length - 1]!.trim();
  }
  return 'unknown';
}
