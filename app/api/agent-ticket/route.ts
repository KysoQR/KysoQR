import {
  AgentTicketNotConfiguredError,
  createAgentTicket,
  isValidChallenge,
} from '@/lib/agentTicket';
import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';

export const runtime = 'nodejs';

/**
 * POST /api/agent-ticket -- issues a short-lived signed ticket the browser
 * forwards to the local KysoQR Agent (USB-token signing), see
 * lib/agentTicket.ts. Internal UI helper, not part of the public API docs.
 *
 * Only same-origin pages get a ticket: the browser always sends `Origin` on a
 * POST, and it must match the host this request was made to. That keeps
 * other websites from reading a ticket (they also can't use one: the agent
 * checks the ticket's origin against the Origin of the request carrying it).
 */
export async function POST(request: Request): Promise<Response> {
  const rateLimit = checkRateLimit(`agent-ticket:${clientIpFromRequest(request)}`, {
    limit: 30,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    originHost = null;
  }
  if (!origin || !host || originHost !== host) {
    return Response.json(
      { error: 'ORIGIN_NOT_ALLOWED', message: 'Agent tickets are only issued to KysoQR pages.' },
      { status: 403 }
    );
  }

  // The agent's one-time challenge (two-way handshake, see lib/agentTicket.ts).
  let challenge: unknown;
  try {
    challenge = ((await request.json()) as { challenge?: unknown } | null)?.challenge;
  } catch {
    challenge = undefined;
  }
  if (!isValidChallenge(challenge)) {
    return Response.json(
      { error: 'INVALID_CHALLENGE', message: 'A challenge from the KysoQR Agent is required.' },
      { status: 400 }
    );
  }

  try {
    const { ticket, payload } = await createAgentTicket(origin, { challenge });
    return Response.json(
      { ticket, expiresAt: new Date(payload.exp * 1000).toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    if (error instanceof AgentTicketNotConfiguredError) {
      return Response.json(
        {
          error: 'AGENT_TICKET_NOT_CONFIGURED',
          message: 'USB-token signing is not enabled on this server.',
        },
        { status: 503 }
      );
    }
    console.error(
      '[agent-ticket] failed to issue ticket',
      error instanceof Error ? error.message : String(error)
    );
    return Response.json(
      { error: 'AGENT_TICKET_FAILED', message: 'Could not issue an agent ticket.' },
      { status: 500 }
    );
  }
}
