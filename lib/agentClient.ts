/**
 * Browser-side client for the local KysoQR Agent (USB-token signing).
 *
 * The page talks to the agent directly at 127.0.0.1 -- the KysoQR server
 * can't reach the user's machine. Every ticket-protected call first asks
 * this site's own POST /api/agent-ticket for a fresh single-use ticket and
 * forwards it in X-KysoQR-Ticket (see lib/agentTicket.ts).
 *
 * The token PIN never passes through here: the agent asks for it in its own
 * native window and only returns the signed PDF.
 */

import type { SignatureFieldProps } from './domain/SignatureField';

/** Where the agent listens on the user's machine, e.g. http://127.0.0.1:47821
 * (must match the agent's KYSOQR_AGENT_PORT). Inlined at build time; unset =
 * USB-token signing is switched off and the option is not shown. */
const AGENT_BASE_URL = process.env.NEXT_PUBLIC_KYSOQR_AGENT_URL?.trim().replace(/\/+$/, '') ?? '';

export const isAgentSigningEnabled = AGENT_BASE_URL !== '';

/** Certificate as listed by the agent's GET /certificates (only what the
 * picker shows). */
export interface AgentCertificate {
  id: string;
  /** Opaque per-token handle (certificates are grouped by it). Missing from
   * older agents -- the page then groups by `tokenLabel`. */
  tokenId?: string;
  tokenLabel: string;
  commonName: string;
  taxOrCitizenId?: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  expired: boolean;
  notYetValid: boolean;
  /** PIN retry state of the token, read by the agent without logging in.
   * Missing from older agents. */
  pinStatus?: { countLow: boolean; finalTry: boolean; locked: boolean };
}

/** `code` is the agent's error code (PIN_CANCELLED, PIN_INCORRECT, ...) or one
 * of AGENT_UNREACHABLE / AGENT_TICKET_NOT_CONFIGURED / AGENT_TICKET_FAILED. */
export class AgentRequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AgentRequestError';
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Has this site's server sign the agent's challenge (step 2 of the
 * handshake, see lib/agentTicket.ts). */
async function requestTicket(challenge: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/api/agent-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge }),
    });
  } catch (err) {
    throw new AgentRequestError('AGENT_TICKET_FAILED', err instanceof Error ? err.message : String(err));
  }
  const data = await readJson(res);
  if (!res.ok || typeof data.ticket !== 'string') {
    console.warn('[agent] ticket request failed', res.status, data);
    const code = typeof data.error === 'string' ? data.error : 'AGENT_TICKET_FAILED';
    throw new AgentRequestError(code, typeof data.message === 'string' ? data.message : code);
  }
  return data.ticket;
}

/** One request to the agent; its JSON body, or its error as AgentRequestError. */
async function agentFetch(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${AGENT_BASE_URL}${path}`, init);
  } catch (err) {
    // Agent not running, or the browser blocked the call.
    console.warn('[agent] unreachable', err);
    throw new AgentRequestError('AGENT_UNREACHABLE', err instanceof Error ? err.message : String(err));
  }
  const data = await readJson(res);
  if (!res.ok) {
    const error = (data.error ?? {}) as { code?: string; message?: string };
    console.warn(`[agent] ${path} failed`, res.status, data);
    throw new AgentRequestError(error.code ?? `HTTP_${res.status}`, error.message ?? `HTTP ${res.status}`);
  }
  return data;
}

/**
 * Two-way handshake, then the call itself:
 * 1. the agent hands out a one-time challenge (GET /handshake);
 * 2. this site's server signs it with the handshake private key;
 * 3. the call carries that ticket -- the agent accepts it only for its own,
 *    unused challenge, issued to this very origin.
 */
async function callAgent(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  if (!isAgentSigningEnabled) {
    throw new AgentRequestError('AGENT_NOT_ENABLED', 'NEXT_PUBLIC_KYSOQR_AGENT_URL is not set');
  }
  const { challenge } = await agentFetch('/handshake');
  if (typeof challenge !== 'string') {
    throw new AgentRequestError('AGENT_BAD_RESPONSE', 'Agent returned no handshake challenge');
  }
  const ticket = await requestTicket(challenge);
  return agentFetch(path, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), 'X-KysoQR-Ticket': ticket },
  });
}

export async function listAgentCertificates(): Promise<AgentCertificate[]> {
  const data = await callAgent('/certificates');
  return (data.certificates as AgentCertificate[] | undefined) ?? [];
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Signs `file` with the chosen certificate: ONE signature shown in every
 * field box. Resolves once the user has typed the PIN in the agent's own
 * window and the token has signed. */
export async function signPdfWithAgent(
  certId: string,
  file: File,
  fields: SignatureFieldProps[]
): Promise<Blob> {
  const pdf = toBase64(new Uint8Array(await file.arrayBuffer()));
  const data = await callAgent('/sign-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      certId,
      documents: [
        {
          id: file.name,
          pdf,
          fields: fields.map(({ page, xRatio, yRatio, widthRatio, heightRatio }) => ({
            page,
            xRatio,
            yRatio,
            widthRatio,
            heightRatio,
          })),
        },
      ],
    }),
  });
  const documents = data.documents as { id: string; signedPdf: string }[] | undefined;
  const signed = documents?.[0]?.signedPdf;
  if (!signed) throw new AgentRequestError('AGENT_BAD_RESPONSE', 'Agent returned no signed PDF');
  return new Blob([fromBase64(signed)], { type: 'application/pdf' });
}
