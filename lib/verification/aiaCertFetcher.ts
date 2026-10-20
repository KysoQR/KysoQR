import forge from 'node-forge';
import * as pkijs from 'pkijs';
import { parseCertFile } from '../trustStore/certBundleLoader';
import { getCachedAiaCerts, getStaleAiaCerts, setCachedAiaCerts } from './aiaCertCache';
import { toPkijsCertificate } from './revocationChecker';
import { fetchBytesWithGuards, isAddressAllowed, type FetchGuards } from './guardedFetch';

export { fetchBytesWithGuards, isAddressAllowed, type FetchGuards };

/**
 * Dynamic discovery of a certificate's issuer via its own `authorityInfoAccess`
 * `id-ad-caIssuers` entry (RFC 5280 §4.2.2.1) -- the network+security
 * counterpart to `certChainVerifier.ts`'s chain-building, kept in its own
 * file the same way `revocationChecker.ts` owns the OCSP/CRL network
 * concern. Unlike that module, a failed/empty result here is load-bearing
 * for the trust decision (a missing intermediate legitimately fails the
 * chain) -- this module never decides trust itself, it only supplies
 * candidate certificates for `certChainVerifier.ts` to feed through the
 * real `forge.pki.verifyCertificateChain` cryptographic walk.
 *
 * The SSRF-guarded fetch itself (2 runtime paths, Node vs Cloudflare
 * Workers) lives in `./guardedFetch.ts` -- shared with `revocationChecker.ts`'s
 * OCSP/CRL fetches, which need the exact same "URL taken from an untrusted
 * certificate" protection. See that module's doc comment for why there are
 * two implementations.
 */

export interface AiaFetchOutcome {
  /** Usually 0 or 1 cert; >1 only if a `caIssuers` URL served a PKCS#7 bundle. */
  certs: forge.pki.Certificate[];
  /** The (first) caIssuers URL attempted, or null if the cert had none at all. */
  url: string | null;
  /** Set when at least one URL existed but every attempt failed -- for debug logging. */
  error?: string;
  /** Network attempts made for the URL that produced this outcome. */
  attempts?: number;
  /** True when the fresh fetch failed and an expired cache entry was used. */
  stale?: boolean;
}

interface UrlFetchResult {
  certs: forge.pki.Certificate[];
  error?: string;
  attempts: number;
}

/** Fetches in progress, by URL, shared by every signature of ONE
 * verification (several signatures from the same CA in one PDF fetch the
 * intermediate once). Deliberately scoped to a single verification, never
 * module-global: on Cloudflare Workers a promise created by one request and
 * awaited by another can hang the second one if the first is cancelled. */
export type AiaInFlight = Map<string, Promise<UrlFetchResult>>;

const AIA_FETCH_TIMEOUT_MS = 5000;
/** Waits before the 2nd and 3rd attempt (so at most 3 attempts per URL). */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [300, 1000];
let retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS;
/** Not retried: policy rejections, and timeouts -- retrying a URL that
 * already took the full timeout would multiply the worst-case wait. Only
 * fast failures (network/DNS errors, HTTP errors, unreadable bodies) are. */
const NON_RETRYABLE = /^(SSRF_BLOCKED|Unsupported protocol)|timed out$/;
const MAX_AIA_REDIRECTS = 3;
const MAX_AIA_RESPONSE_BYTES = 1_000_000;
const MAX_CAISSUERS_URLS_PER_CERT = 3;
const GENERAL_NAME_URI = 6;

/**
 * Explicit, exact-match corrections for `caIssuers` URLs that are broken in
 * already-issued certificates -- confirmed for IntrustCA: their real file
 * lives at `.../assets/cert/...`, but the AIA field baked into already-issued
 * certificates omits the `/assets/` segment, so the literal URL 404s into
 * their web app's client routing instead of hitting the real static file.
 * Since already-issued certificates can't be corrected retroactively, this
 * is the only way such a certificate's chain can ever be completed.
 *
 * Deliberately a small, exact-match table, not a guessed/generic
 * path-rewriting heuristic (e.g. "try inserting /assets/ into any failing
 * URL") -- each entry here was independently confirmed (by fetching it and
 * getting back a real, parseable certificate) to be the CA's actual file
 * location, so this never introduces a URL that hasn't been verified to
 * work. It also grants no extra trust by itself: whatever bytes come back
 * from a corrected URL still have to pass the exact same
 * `forge.pki.verifyCertificateChain` cryptographic check in
 * `certChainVerifier.ts` as any other AIA candidate.
 */
export const KNOWN_AIA_URL_CORRECTIONS: Readonly<Record<string, string>> = {
  'https://intrustca.vn/cert/IntrustCA_Remote_Signing.cer':
    'https://intrustca.vn/assets/cert/IntrustCA_Remote_Signing.cer',
};

/** Every matching `caIssuers` URI on a cert's AIA extension (RFC 5280 allows
 * more than one), bounded so a pathological cert can't make us try forever. */
export function findAllAiaUrls(cert: pkijs.Certificate, accessMethodOid: string): string[] {
  const ext = cert.extensions?.find((e) => e.extnID === pkijs.id_AuthorityInfoAccess);
  const infoAccess = ext?.parsedValue as pkijs.InfoAccess | undefined;
  return (infoAccess?.accessDescriptions ?? [])
    .filter((d) => d.accessMethod === accessMethodOid && d.accessLocation.type === GENERAL_NAME_URI)
    .map((d) => d.accessLocation.value)
    .filter((v): v is string => typeof v === 'string')
    .slice(0, MAX_CAISSUERS_URLS_PER_CERT);
}

/**
 * Try every `caIssuers` URL listed on `cert`'s AIA extension, in order,
 * stopping at the first that yields at least one parseable certificate.
 * Never throws -- any failure (no URL, SSRF-blocked, timeout, oversized,
 * unparseable) degrades to `{certs: [], ...}`, letting the caller
 * (`certChainVerifier.ts`) fail the chain closed exactly the same way a
 * missing bundled intermediate used to.
 */
export async function fetchCaIssuerCertificates(
  cert: forge.pki.Certificate,
  /** Override for tests only -- production callers always get the real
   * predicate, same convention as `FetchGuards.isAddressAllowed`. Needed
   * because a real local test server can only ever bind to a loopback
   * address, which the real predicate always (correctly) blocks. */
  isAddressAllowedOverride?: typeof isAddressAllowed,
  /** Shares in-progress fetches within one verification; omitted = no sharing. */
  inFlight?: AiaInFlight
): Promise<AiaFetchOutcome> {
  let pkijsCert: pkijs.Certificate;
  let urls: string[];
  try {
    pkijsCert = toPkijsCertificate(cert);
    urls = findAllAiaUrls(pkijsCert, pkijs.id_ad_caIssuers);
  } catch {
    return { certs: [], url: null };
  }
  if (urls.length === 0) return { certs: [], url: null };

  let lastError: string | undefined;
  let lastAttempts: number | undefined;
  for (const declaredUrl of urls) {
    // The certificate's own declared URL is always tried first -- the known
    // correction (if any) is only a fallback, never a replacement, in case
    // the CA ever fixes the declared URL to serve the real file directly.
    const correction = KNOWN_AIA_URL_CORRECTIONS[declaredUrl];
    const candidateUrls = correction ? [declaredUrl, correction] : [declaredUrl];

    for (const url of candidateUrls) {
      const cached = getCachedAiaCerts(url);
      if (cached) {
        return { certs: cached, url };
      }

      const fetched = await fetchUrlShared(url, isAddressAllowedOverride, inFlight);
      if (fetched.certs.length > 0) {
        setCachedAiaCerts(url, fetched.certs);
        return { certs: fetched.certs, url, attempts: fetched.attempts };
      }
      // The fresh fetch failed: an expired copy (still checked cryptographically
      // like any candidate) beats breaking an otherwise valid chain.
      const stale = getStaleAiaCerts(url);
      if (stale) {
        return { certs: stale, url, attempts: fetched.attempts, stale: true, error: fetched.error };
      }
      lastError = fetched.error;
      lastAttempts = fetched.attempts;
    }
  }
  return { certs: [], url: urls[0] ?? null, error: lastError, attempts: lastAttempts };
}

function fetchUrlShared(
  url: string,
  isAddressAllowedOverride: typeof isAddressAllowed | undefined,
  inFlight: AiaInFlight | undefined
): Promise<UrlFetchResult> {
  if (!inFlight) return fetchUrlWithRetry(url, isAddressAllowedOverride);
  let pending = inFlight.get(url);
  if (!pending) {
    pending = fetchUrlWithRetry(url, isAddressAllowedOverride).finally(() => inFlight.delete(url));
    inFlight.set(url, pending);
  }
  return pending;
}

async function fetchUrlWithRetry(
  url: string,
  isAddressAllowedOverride: typeof isAddressAllowed | undefined
): Promise<UrlFetchResult> {
  let error: string | undefined;
  let attempts = 0;
  for (let i = 0; i <= retryDelaysMs.length; i += 1) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[i - 1]));
    attempts += 1;
    try {
      const bytes = await fetchBytesWithGuards(url, {
        timeoutMs: AIA_FETCH_TIMEOUT_MS,
        maxRedirects: MAX_AIA_REDIRECTS,
        isAddressAllowed: isAddressAllowedOverride,
        maxBytes: MAX_AIA_RESPONSE_BYTES,
      });
      const certs = parseCertFile(Buffer.from(bytes));
      if (certs.length > 0) return { certs, attempts };
      error = 'response contained no parseable certificates';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      if (NON_RETRYABLE.test(error)) break;
    }
  }
  return { certs: [], error, attempts };
}

/** Tests only: shorten (or restore) the waits between attempts. */
export function setAiaRetryDelaysForTests(delays: readonly number[] = DEFAULT_RETRY_DELAYS_MS): void {
  retryDelaysMs = delays;
}
