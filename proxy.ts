import { NextResponse, type NextRequest } from 'next/server';

/**
 * Pages use a trailing slash (`/verify/`, `/opensource/`, and the docs page
 * at `/api/`). Route handlers stay without one (`/api/sign/request`).
 * Next's own trailing-slash redirect is disabled so it cannot rewrite those
 * POSTs. `NextResponse.redirect` would put the slash back, so the Location
 * header is set on a plain response.
 *
 * The Location has to be ABSOLUTE: Next parses it with `new URL()` and answers
 * 500 to a relative one (tried; every redirect, `/verify` -> `/verify/`
 * included, broke). It used to be built from the `Host` and `X-Forwarded-Proto`
 * request headers, i.e. from values the caller chooses, so a forged Host header
 * was reflected into the redirect. Now:
 * - `APP_ORIGIN` (e.g. `https://kysoqr.example`), when set, is used and the
 *   request's own headers are ignored -- set it in production;
 * - otherwise (local dev) the request's Host is used only if it looks like a
 *   host name with an optional port, and the scheme only if it is http or https.
 * Leading slashes of the path are collapsed (a `//evil` path must stay a path).
 */
function redirectOrigin(request: NextRequest): string {
  const configured = process.env.APP_ORIGIN?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  const host = request.headers.get('host') ?? '';
  if (
    !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(host) &&
    !/^\[[0-9a-f:]+\](:\d{1,5})?$/i.test(host)
  ) {
    return 'http://localhost';
  }
  const proto =
    request.headers.get('x-forwarded-proto')?.trim().toLowerCase() === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}

function redirectTo(request: NextRequest, pathname: string) {
  const path = `/${pathname.replace(/^[\\/]+/, '')}`;
  return new Response(null, {
    status: 308,
    headers: { Location: `${redirectOrigin(request)}${path}${request.nextUrl.search}` },
  });
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

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

  return NextResponse.next();
}

export const config = {
  // `/api/vneid` stays out of the proxy on purpose: a request that passes
  // through it has its whole body buffered (up to proxyClientMaxBodySize)
  // before the route handler runs, and the VNeID routes want to check who is
  // asking and how large the body is BEFORE any of it is read.
  matcher: ['/((?!_next/static|_next/image|api/vneid).*)'],
};
