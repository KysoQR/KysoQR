import forge from 'node-forge';

/**
 * Small in-memory, TTL-bounded cache of `caIssuers` AIA responses, keyed by
 * URL. Many documents from the same CA hierarchy reference the exact same
 * intermediate-cert URL (e.g. every CMC-CA-issued leaf needs the same CMC-CA
 * cert) -- caching it avoids a redundant network round trip on every single
 * verify request for a URL we've already fetched recently.
 *
 * Deliberately NOT a security boundary: whether a candidate cert came fresh
 * off the network or out of this cache, `certChainVerifier.ts` still runs
 * the exact same real cryptographic signature check
 * (`forge.pki.verifyCertificateChain`) before trusting it -- caching only
 * saves a network round trip, it never substitutes for verification.
 *
 * In-memory only -- a plain module-level `Map`, nothing written to disk or
 * to any browser storage -- so it behaves the same way on both deployment
 * targets: on the VPS it persists for the life of the long-running Node
 * process; on Cloudflare Workers it's best-effort (survives only within a
 * warm isolate, silently resets on a cold start). Either way it disappears
 * on its own once an entry expires or the process restarts -- no background
 * cleanup job or persisted file needed.
 */

interface CacheEntry {
  certs: forge.pki.Certificate[];
  expiresAt: number;
}

/** CA intermediate certs are practically static (validity spans years) and
 * every use still goes through the real signature check -- a day keeps cold
 * misses (and the network hiccups they expose) rare, while a CA rotating or
 * fixing a broken endpoint is still picked up within a day. An expired entry
 * is kept as a stale fallback (`getStaleAiaCerts`) for when a fresh fetch
 * fails, so one transient error can't break an otherwise valid chain. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Bounds memory without needing a background sweep/timer -- oldest entry is
 * evicted once the cache is full, relying on `Map`'s insertion order. */
const MAX_CACHE_ENTRIES = 200;

const cache = new Map<string, CacheEntry>();

/** Fresh entries only. An expired entry is NOT deleted -- it stays available
 * to `getStaleAiaCerts` until it is refreshed or evicted. */
export function getCachedAiaCerts(url: string): forge.pki.Certificate[] | null {
  const entry = cache.get(url);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.certs;
}

/** Any entry, expired or not -- only for when a fresh fetch just failed. */
export function getStaleAiaCerts(url: string): forge.pki.Certificate[] | null {
  return cache.get(url)?.certs ?? null;
}

export function setCachedAiaCerts(url: string, certs: forge.pki.Certificate[]): void {
  if (certs.length === 0) return; // nothing useful to remember
  if (!cache.has(url) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.delete(url); // re-insert: a refreshed entry counts as the newest for eviction
  cache.set(url, { certs, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function resetAiaCertCacheForTests(): void {
  cache.clear();
}
