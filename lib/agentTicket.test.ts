import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AGENT_TICKET_AUDIENCE,
  AGENT_TICKET_TTL_SECONDS,
  AgentTicketNotConfiguredError,
  base64UrlDecode,
  createAgentTicket,
  InvalidChallengeError,
  isValidChallenge,
} from './agentTicket';
import { POST } from '../app/api/agent-ticket/route';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeySpki = publicKey.export({ type: 'spki', format: 'der' });
/** What the agent's GET /handshake hands out: 32 random bytes, base64url. */
const newChallenge = () => randomBytes(32).toString('base64url');

async function verify(ticket: string): Promise<boolean> {
  const [body, signature] = ticket.split('.') as [string, string];
  const key = await crypto.subtle.importKey('spki', publicKeySpki, { name: 'Ed25519' }, false, [
    'verify',
  ]);
  return crypto.subtle.verify('Ed25519', key, base64UrlDecode(signature), new TextEncoder().encode(body));
}

describe('createAgentTicket', () => {
  it('signs the agent challenge in a payload the matching public key verifies', async () => {
    const now = Date.UTC(2026, 9, 8, 10, 0, 0);
    const challenge = newChallenge();
    const { ticket, payload } = await createAgentTicket('https://kysoqr.com', { challenge, privateKeyPem, now });

    expect(await verify(ticket)).toBe(true);
    expect(payload).toMatchObject({ v: 2, aud: AGENT_TICKET_AUDIENCE, origin: 'https://kysoqr.com', challenge });
    expect(payload.exp - payload.iat).toBe(AGENT_TICKET_TTL_SECONDS);
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(ticket.split('.')[0]!)));
    expect(decoded).toEqual(payload);
  });

  it('refuses anything that is not a 32-byte base64url challenge', async () => {
    for (const challenge of ['', 'short', `${newChallenge()}=`, 'a'.repeat(44), `${'a'.repeat(42)}+`]) {
      expect(isValidChallenge(challenge)).toBe(false);
      await expect(createAgentTicket('https://kysoqr.com', { challenge, privateKeyPem })).rejects.toBeInstanceOf(
        InvalidChallengeError
      );
    }
    expect(isValidChallenge(newChallenge())).toBe(true);
  });

  it('a tampered payload no longer verifies', async () => {
    const { ticket } = await createAgentTicket('https://kysoqr.com', { challenge: newChallenge(), privateKeyPem });
    const [, signature] = ticket.split('.');
    const forged = Buffer.from(JSON.stringify({ origin: 'https://evil.example' })).toString('base64url');
    expect(await verify(`${forged}.${signature}`)).toBe(false);
  });

  it('accepts a PEM pasted into .env with literal \\n', async () => {
    const oneLine = privateKeyPem.trim().replace(/\n/g, '\\n');
    const { ticket } = await createAgentTicket('https://kysoqr.com', {
      challenge: newChallenge(),
      privateKeyPem: oneLine,
    });
    expect(await verify(ticket)).toBe(true);
  });

  it('reports a missing key as not configured', async () => {
    await expect(
      createAgentTicket('https://kysoqr.com', { challenge: newChallenge(), privateKeyPem: '' })
    ).rejects.toBeInstanceOf(AgentTicketNotConfiguredError);
  });
});

describe('POST /api/agent-ticket', () => {
  const request = (headers: Record<string, string>, body: unknown = { challenge: newChallenge() }) =>
    new Request('http://127.0.0.1:3000/api/agent-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('rejects a request from another origin', async () => {
    const res = await POST(request({ origin: 'https://evil.example', host: 'kysoqr.com' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('rejects a request without an Origin header', async () => {
    const res = await POST(request({ host: 'kysoqr.com' }));
    expect(res.status).toBe(403);
  });

  it('requires the agent challenge', async () => {
    for (const body of [{}, { challenge: 'not-a-challenge' }, null]) {
      const res = await POST(
        request({ origin: 'https://kysoqr.com', host: 'kysoqr.com', 'x-forwarded-for': '10.0.0.3' }, body)
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('INVALID_CHALLENGE');
    }
  });

  it('reports 503 when the server has no key configured', async () => {
    const previous = process.env.PRIVATE_KEY_HAND_SHAKE_AGENT;
    delete process.env.PRIVATE_KEY_HAND_SHAKE_AGENT;
    try {
      const res = await POST(request({ origin: 'https://kysoqr.com', host: 'kysoqr.com', 'x-forwarded-for': '10.0.0.1' }));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('AGENT_TICKET_NOT_CONFIGURED');
    } finally {
      if (previous !== undefined) process.env.PRIVATE_KEY_HAND_SHAKE_AGENT = previous;
    }
  });

  it('issues a verifiable ticket over the challenge to a same-origin page (behind a proxy)', async () => {
    process.env.PRIVATE_KEY_HAND_SHAKE_AGENT = privateKeyPem;
    try {
      const challenge = newChallenge();
      const res = await POST(
        request(
          { origin: 'https://kysoqr.com', host: '127.0.0.1:3000', 'x-forwarded-host': 'kysoqr.com', 'x-forwarded-for': '10.0.0.2' },
          { challenge }
        )
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(await verify(body.ticket)).toBe(true);
      const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body.ticket.split('.')[0])));
      expect(payload.challenge).toBe(challenge);
      expect(res.headers.get('cache-control')).toBe('no-store');
    } finally {
      delete process.env.PRIVATE_KEY_HAND_SHAKE_AGENT;
    }
  });
});
