/**
 * Short-lived "tickets" that let the local KysoQR Agent (USB-token signing,
 * running on the user's machine at 127.0.0.1) trust that a request really
 * comes from a KysoQR page.
 *
 * Two-way handshake: the browser first gets a one-time challenge from the
 * agent (GET /handshake), has this server sign it (POST /api/agent-ticket
 * { challenge }), then forwards the ticket to the agent, which verifies it
 * with the matching public key and accepts only a challenge it issued
 * itself. The private key only ever lives in this server's environment
 * (PRIVATE_KEY_HAND_SHAKE_AGENT, a PKCS#8 PEM Ed25519 key) -- never in client
 * code. The feature is optional: without the key the rest of the app runs
 * exactly the same, only the ticket endpoint reports it isn't configured.
 *
 * Format: `<base64url(JSON payload)>.<base64url(Ed25519 signature)>`, the
 * signature covering the ASCII bytes of the first part.
 */

export const AGENT_TICKET_AUDIENCE = 'kysoqr-agent';
export const AGENT_TICKET_TTL_SECONDS = 60;

export interface AgentTicketPayload {
  v: 2;
  aud: typeof AGENT_TICKET_AUDIENCE;
  /** The page origin the ticket was issued to; the agent compares it with
   * the Origin header of the request that carries the ticket. */
  origin: string;
  /** The agent's own one-time challenge (GET /handshake on the agent): the
   * agent only accepts a ticket over a challenge it issued itself, unused
   * and unexpired -- proof that whoever calls it holds the private key NOW
   * (two-way handshake; no pre-minted tickets). */
  challenge: string;
  iat: number;
  exp: number;
}

export class AgentTicketNotConfiguredError extends Error {}
export class InvalidChallengeError extends Error {}

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A challenge is 32 random bytes in base64url (43 characters, no padding). */
export function isValidChallenge(value: unknown): value is string {
  return typeof value === 'string' && CHALLENGE_PATTERN.test(value);
}

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function pemBody(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\\n/g, '') // tolerate a PEM pasted into .env with literal "\n"
    .replace(/\s+/g, '');
  return base64UrlDecode(body.replace(/\+/g, '-').replace(/\//g, '_'));
}

let cachedKey: { pem: string; key: CryptoKey } | undefined;

async function signingKey(pem: string | undefined): Promise<CryptoKey> {
  if (!pem?.trim()) {
    throw new AgentTicketNotConfiguredError('PRIVATE_KEY_HAND_SHAKE_AGENT is not set');
  }
  if (cachedKey?.pem === pem) return cachedKey.key;
  const key = await crypto.subtle.importKey('pkcs8', pemBody(pem), { name: 'Ed25519' }, false, [
    'sign',
  ]);
  cachedKey = { pem, key };
  return key;
}

export async function createAgentTicket(
  origin: string,
  {
    challenge,
    privateKeyPem = process.env.PRIVATE_KEY_HAND_SHAKE_AGENT,
    now = Date.now(),
  }: { challenge: string; privateKeyPem?: string; now?: number }
): Promise<{ ticket: string; payload: AgentTicketPayload }> {
  if (!isValidChallenge(challenge)) throw new InvalidChallengeError('challenge must be 32 bytes, base64url');
  const key = await signingKey(privateKeyPem);
  const iat = Math.floor(now / 1000);
  const payload: AgentTicketPayload = {
    v: 2,
    aud: AGENT_TICKET_AUDIENCE,
    origin,
    challenge,
    iat,
    exp: iat + AGENT_TICKET_TTL_SECONDS,
  };
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, encoder.encode(body)));
  return { ticket: `${body}.${base64UrlEncode(signature)}`, payload };
}
