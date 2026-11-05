import { fetchWithTimeout } from '../fetchWithTimeout';
import { VneidError } from './errors';

/**
 * Cloudflare Turnstile check for POST /api/vneid/sign: every accepted request
 * sends a real notification to a citizen's phone, so a public deployment
 * should make bots solve a challenge first. Off while TURNSTILE_SECRET is
 * unset (local development); fails closed once it is set.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5_000;
export const TURNSTILE_ACTION = 'vneid_sign';

interface SiteverifyAnswer {
  success?: boolean;
  action?: string;
  hostname?: string;
}

export async function verifyTurnstile(request: Request, clientIp: string): Promise<void> {
  const secret = process.env.TURNSTILE_SECRET?.trim();
  if (!secret) return;
  const refuse = (reason: string) => new VneidError('VNEID_CHALLENGE_FAILED', reason);

  const token = request.headers.get('x-turnstile-token') ?? '';
  if (token.length === 0 || token.length > 2048) throw refuse('token missing');

  const form = new URLSearchParams({ secret, response: token });
  if (clientIp !== 'unknown') form.set('remoteip', clientIp);
  let answer: SiteverifyAnswer;
  try {
    const response = await fetchWithTimeout(
      SITEVERIFY_URL,
      { method: 'POST', body: form, redirect: 'error' },
      TIMEOUT_MS
    );
    answer = (await response.json()) as SiteverifyAnswer;
  } catch {
    throw refuse('siteverify unreachable');
  }
  if (answer.success !== true) throw refuse('token refused');
  if (answer.action !== TURNSTILE_ACTION) throw refuse('wrong action');
  const appOrigin = process.env.APP_ORIGIN?.trim();
  if (appOrigin && answer.hostname !== new URL(appOrigin).hostname) throw refuse('wrong hostname');
}
