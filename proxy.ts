import { NextResponse, type NextRequest } from 'next/server';

/**
 * Pages use a trailing slash (`/verify/`, `/opensource/`, and the docs page
 * at `/api/`). Route handlers stay without one (`/api/sign/request`).
 * Next's own trailing-slash redirect is disabled so it cannot rewrite those
 * POSTs. `NextResponse.redirect` would put the slash back, so the Location
 * header is set on a plain response.
 */
function redirectTo(request: NextRequest, pathname: string) {
  const proto = request.headers.get('x-forwarded-proto') ?? 'http';
  const host = request.headers.get('host') ?? 'localhost';
  return new Response(null, {
    status: 308,
    headers: { Location: `${proto}://${host}${pathname}${request.nextUrl.search}` },
  });
}

/**
 * Content-Security-Policy for every page, with a fresh per-request nonce
 * (Next applies it to its own scripts while rendering -- every page is
 * dynamic already, see `connection()` in app/layout.tsx). Matters because the
 * signing flow keeps signed PDFs and the recent list in this origin's
 * storage: a script injected into the page could read all of it.
 *
 * - script-src: only nonce'd scripts (and what they load, 'strict-dynamic');
 *   'unsafe-eval' in dev only (React's dev tooling needs it).
 * - style-src 'unsafe-inline': React `style={}` attributes, pdf.js and the
 *   Scalar API reference set inline styles.
 * - connect-src: Iconify's icon API (+ its fallback hosts) and shields.io
 *   (GitHub star count).
 * - frame-src: the signed-PDF preview (blob:) and the YouTube guide video.
 * - worker-src: pdf.js's worker.
 */
function contentSecurityPolicy(nonce: string): string {
  const isDev = process.env.NODE_ENV === 'development';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.iconify.design https://api.simplesvg.com https://api.unisvg.com https://img.shields.io",
    "frame-src 'self' blob: https://www.youtube-nocookie.com https://www.youtube.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

/** Lets the page render with a CSP + nonce (request header, read by Next
 * while rendering) and sends the same CSP to the browser. */
function withCsp(request: NextRequest): NextResponse {
  // btoa + randomUUID: available in Node and in the Cloudflare Worker runtime.
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The API reference page itself (`/api/`) is a page and gets the CSP.
  if (pathname === '/api/') return withCsp(request);

  if (pathname.startsWith('/_next') || pathname.startsWith('/api/')) {
    if (pathname.startsWith('/api/') && pathname !== '/api/' && pathname.endsWith('/')) {
      return redirectTo(request, pathname.replace(/\/+$/, ''));
    }
    return NextResponse.next();
  }

  // Static files (`/why.html`, images, OpenAPI yaml) keep the URL they are served at.
  if (pathname.includes('.')) return NextResponse.next();

  if (pathname !== '/' && !pathname.endsWith('/')) {
    return redirectTo(request, `${pathname}/`);
  }

  return withCsp(request);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
