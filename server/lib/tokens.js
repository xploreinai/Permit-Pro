import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';

// 256-bit random token that goes in the approval link. Only its hash is stored.
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

// Random code embedded in the reply-to address (approve-<code>@domain).
export const newReplyCode = () => randomBytes(8).toString('hex');
export const REPLY_CODE_PATTERN = /approve-([a-f0-9]{16})@/i;

// Svix-style webhook signature check (what Resend uses): the signed content is
// "<svix-id>.<svix-timestamp>.<raw body>", HMAC-SHA256 with the base64-decoded
// secret (after the "whsec_" prefix). The header can hold several space-separated
// "v1,<base64 signature>" entries.
export function verifyWebhookSignature({ secret, id, timestamp, signature, rawBody, now = Date.now(), toleranceSeconds = 300 }) {
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSeconds) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();

  return String(signature)
    .split(' ')
    .map((part) => part.split(','))
    .filter(([version, value]) => version === 'v1' && value)
    .some(([, value]) => {
      const candidate = Buffer.from(value, 'base64');
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
}
