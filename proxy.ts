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
  matcher: ['/((?!_next/static|_next/image).*)'],
};
