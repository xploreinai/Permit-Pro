import {
  sendEmail as defaultSendEmail,
  buildApprovalEmail, buildReceiptEmail, buildClarifyEmail,
  renderDecisionPage, renderMessagePage,
} from './email.js';
import { newToken, hashToken, newReplyCode, REPLY_CODE_PATTERN, verifyWebhookSignature } from './tokens.js';
import { parseReplyDecision } from './replyParser.js';
import { applyDecision, describeActionable } from './decisions.js';
import { missingSettings } from './config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// Pages carry a secret token in the URL/form: never cache, never index, never
// leak it through the Referer header, and only allow the form to post to us.
function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'");
  res.end(html);
}

function bodyObject(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  const raw = Buffer.isBuffer(b) ? b.toString('utf8') : String(b);
  try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); }
}

export async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

const emailOf = (from) => (String(from || '').match(/<([^>]+)>/)?.[1] || String(from || '')).trim().toLowerCase();

// ---------------------------------------------------------------------------
// POST /api/request-approval  { permitId }
// Recipients come from server config, never from the caller, so this public
// endpoint can't be used to email arbitrary addresses.
// ---------------------------------------------------------------------------
export function createRequestApprovalHandler({ config, store, sendEmail = defaultSendEmail, now = () => new Date() }) {
  return async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    if (missingSettings(config, 'send').length) return sendJson(res, 503, { error: 'email_not_configured' });

    const permitId = bodyObject(req).permitId;
    if (!UUID.test(String(permitId || ''))) return sendJson(res, 400, { error: 'invalid_permit_id' });

    try {
      const permit = await store.getPermit(permitId);
      if (!permit) return sendJson(res, 404, { error: 'permit_not_found' });

      const hcc = permit.hcc_approval || {};
      const kinds = [];
      if (permit.status === 'pending_receipt') kinds.push('engineering');
      if (hcc.required && !hcc.approved && ['pending_receipt', 'pending_checkin'].includes(permit.status)) kinds.push('hcc');

      const sent = [];
      const skipped = [];
      const current = now();

      for (const kind of kinds) {
        const recipients = config.approvers[kind];
        if (!recipients.length) { skipped.push({ kind, reason: 'no_approver_configured' }); continue; }

        const since = new Date(current.getTime() - config.resendCooldownMinutes * 60000).toISOString();
        if (await store.hasRecentRequest(permit.id, kind, since)) { skipped.push({ kind, reason: 'recently_sent' }); continue; }

        let count = 0;
        for (const recipient of recipients) {
          const token = newToken();
          const replyCode = newReplyCode();
          const request = await store.insertRequest({
            permit_id: permit.id,
            kind,
            recipient_email: recipient.toLowerCase(),
            token_hash: hashToken(token),
            reply_code: replyCode,
            expires_at: new Date(current.getTime() + config.requestTtlHours * 3600000).toISOString(),
          });

          const message = buildApprovalEmail({
            permit, kind,
            link: `${config.appBaseUrl}/api/approve?token=${token}`,
            replyEnabled: Boolean(config.inboundDomain),
          });
          const result = await sendEmail({
            apiKey: config.resendApiKey,
            from: config.emailFrom,
            to: recipient,
            replyTo: config.inboundDomain ? `approve-${replyCode}@${config.inboundDomain}` : undefined,
            ...message,
          });

          if (result.ok) count += 1;
          else {
            await store.setRequestStatus(request.id, 'failed');
            console.error(`[approvals] send failed for ${kind}:`, result.error);
          }
        }
        if (count) sent.push({ kind, count });
        else skipped.push({ kind, reason: 'send_failed' });
      }

      return sendJson(res, 200, { ok: true, sent, skipped });
    } catch (err) {
      console.error('[approvals] request-approval error:', err);
      return sendJson(res, 500, { error: 'server_error' });
    }
  };
}

// ---------------------------------------------------------------------------
// GET  /api/approve?token=...   -> shows a confirmation page. NEVER changes
//                                  anything: mail scanners and link previews
//                                  open links automatically.
// POST /api/approve             -> records the decision.
// ---------------------------------------------------------------------------
export function createApproveHandler({ config, store, sendEmail = defaultSendEmail, now = () => new Date() }) {
  return async (req, res) => {
    if (missingSettings(config, 'approve').length) {
      return sendHtml(res, 503, renderMessagePage('Not available', 'Approvals are not set up yet.'));
    }

    try {
      if (req.method === 'GET') {
        const token = String(req.query?.token || new URL(req.url, 'http://x').searchParams.get('token') || '');
        const request = token ? await store.getRequestByTokenHash(hashToken(token)) : null;
        if (!request) return sendHtml(res, 404, renderMessagePage('Link not valid', 'This approval link is not valid.'));

        const permit = await store.getPermit(request.permit_id);
        const check = describeActionable(request, permit, now());
        if (!check.actionable) return sendHtml(res, 200, renderMessagePage('Nothing to do', check.reason));

        const hccPending = permit.hcc_approval?.required && !permit.hcc_approval?.approved;
        return sendHtml(res, 200, renderDecisionPage({ permit, kind: request.kind, token, hccPending }));
      }

      if (req.method === 'POST') {
        const body = bodyObject(req);
        const token = String(body.token || '');
        const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null;
        const request = token ? await store.getRequestByTokenHash(hashToken(token)) : null;
        if (!request || !decision) return sendHtml(res, 400, renderMessagePage('Link not valid', 'This approval link is not valid.'));

        const outcome = await applyDecision({ store, request, decision, via: 'link', note: body.note, now: now() });
        if (outcome.result !== 'applied') return sendHtml(res, 200, renderMessagePage('Nothing to do', outcome.reason));

        if (config.resendApiKey && config.emailFrom) {
          await sendEmail({
            apiKey: config.resendApiKey, from: config.emailFrom, to: request.recipient_email,
            ...buildReceiptEmail({ permit: outcome.permit, kind: request.kind, decision, via: 'link' }),
          });
        }
        return sendHtml(res, 200, renderMessagePage(decision === 'approve' ? 'Approved' : 'Rejected',
          `Permit ${outcome.permit.permit_ref} has been ${decision === 'approve' ? 'approved' : 'rejected'}. You can close this page.`));
      }

      res.setHeader('Allow', 'GET, POST');
      return sendHtml(res, 405, renderMessagePage('Not allowed', 'Method not allowed.'));
    } catch (err) {
      console.error('[approvals] approve error:', err);
      return sendHtml(res, 500, renderMessagePage('Something went wrong', 'Please try the link again in a minute.'));
    }
  };
}

// ---------------------------------------------------------------------------
// POST /api/inbound-email   (Resend "email.received" webhook)
// A reply only counts if ALL of these hold:
//   - the webhook signature is valid
//   - the secret code in the reply address matches a pending request
//   - the sender is exactly the approver the request was sent to
//   - SPF or DKIM passed (so the From address wasn't forged) and none failed
//   - the wording is an unambiguous approve/reject
// Any notice goes to the approver on file, never to the From address.
// ---------------------------------------------------------------------------
export function createInboundHandler({ config, store, sendEmail = defaultSendEmail, fetchImpl = fetch, now = () => new Date() }) {
  const notify = (to, message) => sendEmail({ apiKey: config.resendApiKey, from: config.emailFrom, to, ...message });

  return async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    if (missingSettings(config, 'inbound').length) return sendJson(res, 503, { error: 'inbound_not_configured' });

    const rawBody = await readRawBody(req);
    const valid = verifyWebhookSignature({
      secret: config.webhookSecret,
      id: req.headers['svix-id'],
      timestamp: req.headers['svix-timestamp'],
      signature: req.headers['svix-signature'],
      rawBody,
      now: now().getTime(),
    });
    if (!valid) return sendJson(res, 401, { error: 'invalid_signature' });

    try {
      const event = JSON.parse(rawBody);
      if (event.type !== 'email.received' || !event.data?.email_id) return sendJson(res, 200, { ignored: 'not_an_inbound_email' });

      // The webhook only carries metadata; fetch the body and the SPF/DKIM results.
      const fetched = await fetchImpl(`https://api.resend.com/emails/receiving/${encodeURIComponent(event.data.email_id)}`, {
        headers: { Authorization: `Bearer ${config.resendApiKey}` },
      });
      if (!fetched.ok) {
        console.error('[approvals] could not fetch inbound email:', fetched.status);
        return sendJson(res, 502, { error: 'fetch_failed' }); // non-2xx makes Resend retry
      }
      const mail = await fetched.json();

      const auto = String(mail.headers?.['auto-submitted'] || '').toLowerCase();
      if (auto && auto !== 'no') return sendJson(res, 200, { ignored: 'auto_reply' });

      const code = (mail.to || event.data.to || []).map((a) => String(a).match(REPLY_CODE_PATTERN)?.[1]).find(Boolean);
      const request = code ? await store.getRequestByReplyCode(code.toLowerCase()) : null;
      if (!request) return sendJson(res, 200, { ignored: 'unknown_code' });

      if (emailOf(mail.from) !== request.recipient_email.toLowerCase()) {
        console.warn('[approvals] reply from a different sender than the approver; ignored');
        return sendJson(res, 200, { ignored: 'sender_mismatch' });
      }

      const auth = mail.authentication || {};
      const authenticated = (auth.dkim === 'pass' || auth.spf === 'pass') && auth.dkim !== 'fail' && auth.spf !== 'fail';
      if (!authenticated) {
        console.warn('[approvals] reply failed sender authentication; ignored');
        await notify(request.recipient_email, {
          subject: 'Please use the approval link',
          text: 'We received an email reply for a work permit but could not verify it came from you, so nothing was changed. Please use the link in the original email instead.',
          html: '<p style="font-family:Arial,sans-serif">We received an email reply for a work permit but could not verify it came from you, so <strong>nothing was changed</strong>. Please use the link in the original email instead.</p>',
        });
        return sendJson(res, 200, { ignored: 'unauthenticated' });
      }

      const permit = await store.getPermit(request.permit_id);
      const check = describeActionable(request, permit, now());
      if (!check.actionable) return sendJson(res, 200, { ignored: 'not_actionable' });

      const decision = parseReplyDecision(mail.text || String(mail.html || '').replace(/<[^>]+>/g, ' '));
      if (decision === 'unclear') {
        await notify(request.recipient_email, buildClarifyEmail({ permit }));
        return sendJson(res, 200, { ignored: 'unclear_reply' });
      }

      const outcome = await applyDecision({ store, request, decision, via: 'email_reply', now: now() });
      if (outcome.result === 'applied') {
        await notify(request.recipient_email, buildReceiptEmail({ permit: outcome.permit, kind: request.kind, decision, via: 'email_reply' }));
      }
      return sendJson(res, 200, { ok: true, result: outcome.result });
    } catch (err) {
      console.error('[approvals] inbound error:', err);
      return sendJson(res, 500, { error: 'server_error' });
    }
  };
}
