import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseReplyDecision, extractReplyBody } from '../lib/replyParser.js';
import { verifyWebhookSignature, hashToken } from '../lib/tokens.js';
import { createRequestApprovalHandler, createApproveHandler, createInboundHandler } from '../lib/handlers.js';

// ---------- fakes ----------
const PERMIT_ID = '11111111-2222-4333-8444-555555555555';

function makeStore(permitOverrides = {}) {
  const state = {
    permits: new Map([[PERMIT_ID, {
      id: PERMIT_ID, permit_ref: 'PP-000042', company_name: 'Acme <b>Welding</b>', work_location: 'Rooftop',
      start_date: '2026-10-05', end_date: '2026-10-06', start_time: '10:00', end_time: '17:00',
      risk_level: 'High', description_of_work: 'Hot work', workers: [{}, {}, {}],
      status: 'pending_receipt', department_receipt: {}, hcc_approval: { required: true, approved: false },
      ...permitOverrides,
    }]]),
    requests: [], audit: [],
  };
  return {
    state,
    async getPermit(id) { return state.permits.get(id) || null; },
    async hasRecentRequest(permitId, kind, sinceIso) {
      return state.requests.some((r) => r.permit_id === permitId && r.kind === kind && r.created_at >= sinceIso);
    },
    async insertRequest(row) { const r = { id: `req-${state.requests.length + 1}`, status: 'pending', created_at: new Date().toISOString(), ...row }; state.requests.push(r); return r; },
    async getRequestByTokenHash(h) { return state.requests.find((r) => r.token_hash === h) || null; },
    async getRequestByReplyCode(c) { return state.requests.find((r) => r.reply_code === c) || null; },
    async setRequestStatus(id, status) { state.requests.find((r) => r.id === id).status = status; },
    async claimRequest(id, patch) { const r = state.requests.find((x) => x.id === id); if (!r || r.status !== 'pending') return null; Object.assign(r, patch); return r; },
    async supersedeSiblings(pid, kind, except) { state.requests.filter((r) => r.permit_id === pid && r.kind === kind && r.status === 'pending' && r.id !== except).forEach((r) => { r.status = 'superseded'; }); },
    async updatePermitGuarded(id, allowed, patch) { const p = state.permits.get(id); if (!allowed.includes(p.status)) return null; Object.assign(p, patch); return p; },
    async insertAudit(e) { state.audit.push(e); },
  };
}

function makeRes() {
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b || ''; } };
  return res;
}

const baseConfig = {
  supabaseUrl: 'https://x.supabase.co', serviceRoleKey: 'srk', resendApiKey: 're_test', emailFrom: 'Permits <p@example.com>',
  appBaseUrl: 'https://app.example.com', approvers: { engineering: ['eng@hotel.com'], hcc: ['hcc@hotel.com', 'hcc2@hotel.com'] },
  inboundDomain: 'abc.resend.app', webhookSecret: 'whsec_' + Buffer.from('super-secret-key').toString('base64'),
  requestTtlHours: 168, resendCooldownMinutes: 5,
};

function emailCapture() {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); return { ok: true, id: 'e1' }; } };
}

async function seedRequests(store, config = baseConfig) {
  const cap = emailCapture();
  const res = makeRes();
  await createRequestApprovalHandler({ config, store, sendEmail: cap.send })({ method: 'POST', body: { permitId: PERMIT_ID } }, res);
  return { cap, res };
}

const tokenFrom = (msg) => new URL(msg.text.match(/https:\/\/\S+/)[0]).searchParams.get('token');
const codeFrom = (msg) => msg.replyTo.match(/approve-([a-f0-9]{16})@/)[1];

// ---------- reply parser ----------
test('reply parser: clear approvals', () => {
  for (const t of ['Approved', 'approved.', 'Just approve it. It is approved.', 'Yes', 'OK', 'Okay, go ahead', 'APPROVE', 'No problem, approved']) {
    assert.equal(parseReplyDecision(t), 'approve', t);
  }
});
test('reply parser: clear rejections', () => {
  for (const t of ['Rejected', 'No', 'Not approved', 'I do not approve', "don't approve this", 'Denied', 'Declined — missing method statement']) {
    assert.equal(parseReplyDecision(t), 'reject', t);
  }
});
test('reply parser: hedged, conditional or questions are unclear (never approve)', () => {
  for (const t of ['Approved but only for Monday', 'Can you approve it?', 'Approved unless the rooftop is wet', 'Hold on, checking', 'Let me think', '', 'Approved\n'.repeat(1) + 'x'.repeat(400)]) {
    assert.equal(parseReplyDecision(t), 'unclear', t.slice(0, 40));
  }
});
test('reply parser: ignores quoted original text', () => {
  const reply = 'Approved\n\nOn Mon, 5 Oct 2026 at 10:00, Permits <p@example.com> wrote:\n> Reply with Rejected to reject this permit';
  assert.equal(extractReplyBody(reply), 'Approved');
  assert.equal(parseReplyDecision(reply), 'approve');
  assert.equal(parseReplyDecision('> Approved\nsome text'), 'unclear');
});

// ---------- webhook signature ----------
function sign(secret, id, ts, body) {
  return 'v1,' + createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
}
test('webhook signature: valid, tampered, stale, missing', () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"a":1}';
  const signature = sign(baseConfig.webhookSecret, 'msg_1', ts, body);
  const args = { secret: baseConfig.webhookSecret, id: 'msg_1', timestamp: ts, signature, rawBody: body };
  assert.equal(verifyWebhookSignature(args), true);
  assert.equal(verifyWebhookSignature({ ...args, rawBody: '{"a":2}' }), false);
  assert.equal(verifyWebhookSignature({ ...args, secret: 'whsec_' + Buffer.from('other').toString('base64') }), false);
  assert.equal(verifyWebhookSignature({ ...args, timestamp: String(Number(ts) - 3600), signature: sign(baseConfig.webhookSecret, 'msg_1', String(Number(ts) - 3600), body) }), false);
  assert.equal(verifyWebhookSignature({ ...args, signature: '' }), false);
  assert.equal(verifyWebhookSignature({ ...args, signature: `v1,AAAA ${signature}` }), true, 'multiple signatures allowed');
});

// ---------- request-approval ----------
test('request-approval: emails fixed approvers only, one request per recipient, raw token never stored', async () => {
  const store = makeStore();
  const { cap, res } = await seedRequests(store);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(cap.sent.map((m) => m.to).sort(), ['eng@hotel.com', 'hcc2@hotel.com', 'hcc@hotel.com']);
  assert.equal(store.state.requests.length, 3);
  for (const msg of cap.sent) {
    assert.ok(msg.replyTo.endsWith('@abc.resend.app'));
    assert.ok(!store.state.requests.some((r) => JSON.stringify(r).includes(tokenFrom(msg))), 'raw token must not be stored');
    assert.ok(store.state.requests.some((r) => r.token_hash === hashToken(tokenFrom(msg))));
  }
  assert.ok(!res.body.includes('hotel.com'), 'response must not leak approver addresses');
  assert.ok(cap.sent[0].html.includes('Acme &lt;b&gt;Welding&lt;/b&gt;'), 'vendor-supplied text is escaped');
});

test('request-approval: cooldown, bad id, unknown permit, unconfigured', async () => {
  const store = makeStore();
  await seedRequests(store);
  const second = await seedRequests(store);
  assert.equal(JSON.parse(second.res.body).sent.length, 0);
  assert.equal(second.cap.sent.length, 0, 'second call within cooldown sends nothing');

  const r1 = makeRes(); await createRequestApprovalHandler({ config: baseConfig, store })({ method: 'POST', body: { permitId: 'nope' } }, r1);
  assert.equal(r1.statusCode, 400);
  const r2 = makeRes(); await createRequestApprovalHandler({ config: baseConfig, store })({ method: 'POST', body: { permitId: '99999999-2222-4333-8444-555555555555' } }, r2);
  assert.equal(r2.statusCode, 404);
  const r3 = makeRes(); await createRequestApprovalHandler({ config: { ...baseConfig, resendApiKey: '' }, store })({ method: 'POST', body: { permitId: PERMIT_ID } }, r3);
  assert.equal(r3.statusCode, 503);
  const r4 = makeRes(); await createRequestApprovalHandler({ config: baseConfig, store })({ method: 'GET' }, r4);
  assert.equal(r4.statusCode, 405);
});

test('request-approval: link-only mode when no inbound domain is set', async () => {
  const store = makeStore();
  const { cap } = await seedRequests(store, { ...baseConfig, inboundDomain: '' });
  assert.equal(cap.sent[0].replyTo, undefined);
  assert.ok(!cap.sent[0].text.includes('reply to this email'));
});

// ---------- approve link ----------
test('approve link: GET only shows a page and never changes anything', async () => {
  const store = makeStore();
  const { cap } = await seedRequests(store);
  const token = tokenFrom(cap.sent.find((m) => m.to === 'eng@hotel.com'));
  const res = makeRes();
  await createApproveHandler({ config: baseConfig, store })({ method: 'GET', query: { token } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('name="decision"'));
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(store.state.permits.get(PERMIT_ID).status, 'pending_receipt');
  assert.ok(store.state.requests.every((r) => r.status === 'pending'));
});

test('approve link: engineering approval moves permit to pending_checkin, single-use, audited', async () => {
  const store = makeStore();
  const { cap } = await seedRequests(store);
  const token = tokenFrom(cap.sent.find((m) => m.to === 'eng@hotel.com'));
  const receipts = emailCapture();
  const handler = createApproveHandler({ config: baseConfig, store, sendEmail: receipts.send });

  const res = makeRes();
  await handler({ method: 'POST', body: { token, decision: 'approve', note: 'ok with fire watch' } }, res);
  const permit = store.state.permits.get(PERMIT_ID);
  assert.equal(permit.status, 'pending_checkin');
  assert.equal(permit.department_receipt.authorized, true);
  assert.equal(permit.department_receipt.supervisorName, 'eng@hotel.com');
  assert.equal(permit.department_receipt.notes, 'ok with fire watch');
  assert.equal(store.state.audit.length, 1);
  assert.equal(receipts.sent.length, 1, 'approver gets a receipt');
  assert.equal(permit.hcc_approval.approved, false, 'engineering approval does not satisfy HCC');

  const again = makeRes();
  await handler({ method: 'POST', body: { token, decision: 'approve' } }, again);
  assert.ok(again.body.includes('already been used'));
  assert.equal(store.state.audit.length, 1, 'no second audit entry');
});

test('approve link: rejection stops the permit; HCC approval only flips the HCC flag', async () => {
  const store = makeStore();
  const { cap } = await seedRequests(store);
  const hccToken = tokenFrom(cap.sent.find((m) => m.to === 'hcc@hotel.com'));
  const handler = createApproveHandler({ config: baseConfig, store, sendEmail: async () => ({ ok: true }) });

  await handler({ method: 'POST', body: { token: hccToken, decision: 'approve' } }, makeRes());
  let permit = store.state.permits.get(PERMIT_ID);
  assert.equal(permit.hcc_approval.approved, true);
  assert.equal(permit.status, 'pending_receipt', 'status unchanged by HCC approval');
  const sibling = store.state.requests.find((r) => r.recipient_email === 'hcc2@hotel.com');
  assert.equal(sibling.status, 'superseded', 'other HCC approver link is retired');

  const engToken = tokenFrom(cap.sent.find((m) => m.to === 'eng@hotel.com'));
  await handler({ method: 'POST', body: { token: engToken, decision: 'reject', note: 'No method statement' } }, makeRes());
  permit = store.state.permits.get(PERMIT_ID);
  assert.equal(permit.status, 'rejected');
  assert.equal(permit.department_receipt.rejected, true);
});

test('approve link: respects a permit already approved in the app, expired and bogus tokens', async () => {
  const store = makeStore();
  const { cap } = await seedRequests(store);
  const token = tokenFrom(cap.sent.find((m) => m.to === 'eng@hotel.com'));
  store.state.permits.get(PERMIT_ID).status = 'pending_checkin'; // approved in-app meanwhile
  const handler = createApproveHandler({ config: baseConfig, store });

  const get = makeRes(); await handler({ method: 'GET', query: { token } }, get);
  assert.ok(get.body.includes('already been handled'));
  const post = makeRes(); await handler({ method: 'POST', body: { token, decision: 'approve' } }, post);
  assert.ok(post.body.includes('already been handled'));
  assert.equal(store.state.audit.length, 0);

  const bogus = makeRes(); await handler({ method: 'GET', query: { token: 'not-a-real-token' } }, bogus);
  assert.equal(bogus.statusCode, 404);

  const store2 = makeStore();
  const seeded = await seedRequests(store2);
  const tok2 = tokenFrom(seeded.cap.sent.find((m) => m.to === 'eng@hotel.com'));
  const late = makeRes();
  await createApproveHandler({ config: baseConfig, store: store2, now: () => new Date(Date.now() + 8 * 24 * 3600 * 1000) })({ method: 'GET', query: { token: tok2 } }, late);
  assert.ok(late.body.includes('expired'));
});

// ---------- inbound email replies ----------
function inboundHarness({ store, mail }) {
  const notices = emailCapture();
  const handler = createInboundHandler({
    config: baseConfig, store, sendEmail: notices.send,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => mail }),
  });
  const send = async ({ tamper = false, signature } = {}) => {
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1', to: mail.to } });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = makeRes();
    await handler({
      method: 'POST', body,
      headers: { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': signature ?? sign(baseConfig.webhookSecret, 'msg_1', ts, tamper ? body + ' ' : body) },
    }, res);
    return res;
  };
  return { send, notices };
}

async function engineeringReplySetup(overrides = {}) {
  const store = makeStore();
  const { cap } = await seedRequests(store);
  const msg = cap.sent.find((m) => m.to === 'eng@hotel.com');
  const mail = {
    from: 'Eng Manager <ENG@hotel.com>', to: [msg.replyTo], text: 'Just approve it. It is approved.\n\nOn Mon wrote:\n> quoted',
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, headers: {}, ...overrides,
  };
  return { store, ...inboundHarness({ store, mail }) };
}

test('inbound: valid, authenticated "approved" reply is applied and confirmed to the approver', async () => {
  const { store, send, notices } = await engineeringReplySetup();
  const res = await send();
  assert.equal(JSON.parse(res.body).result, 'applied');
  assert.equal(store.state.permits.get(PERMIT_ID).status, 'pending_checkin');
  assert.equal(store.state.requests.find((r) => r.recipient_email === 'eng@hotel.com').decided_via, 'email_reply');
  assert.equal(notices.sent.length, 1);
  assert.equal(notices.sent[0].to, 'eng@hotel.com');
});

test('inbound: rejects bad signatures, wrong sender, failed/missing authentication, auto-replies', async () => {
  let h = await engineeringReplySetup();
  assert.equal((await h.send({ tamper: true })).statusCode, 401);
  assert.equal((await h.send({ signature: 'v1,bogus' })).statusCode, 401);
  assert.equal(h.store.state.permits.get(PERMIT_ID).status, 'pending_receipt');

  h = await engineeringReplySetup({ from: 'attacker@evil.com' });
  assert.equal(JSON.parse((await h.send()).body).ignored, 'sender_mismatch');
  assert.equal(h.store.state.permits.get(PERMIT_ID).status, 'pending_receipt');
  assert.equal(h.notices.sent.length, 0, 'no email sent back to a possibly-forged sender');

  h = await engineeringReplySetup({ authentication: { spf: 'fail', dkim: 'fail' } });
  assert.equal(JSON.parse((await h.send()).body).ignored, 'unauthenticated');
  assert.equal(h.store.state.permits.get(PERMIT_ID).status, 'pending_receipt');
  assert.equal(h.notices.sent[0].to, 'eng@hotel.com', 'real approver is warned instead');

  h = await engineeringReplySetup({ authentication: null });
  assert.equal(JSON.parse((await h.send()).body).ignored, 'unauthenticated');

  h = await engineeringReplySetup({ headers: { 'auto-submitted': 'auto-replied' } });
  assert.equal(JSON.parse((await h.send()).body).ignored, 'auto_reply');
});

test('inbound: unclear, rejecting, unknown-code replies', async () => {
  let h = await engineeringReplySetup({ text: 'Approved but only for Monday' });
  assert.equal(JSON.parse((await h.send()).body).ignored, 'unclear_reply');
  assert.equal(h.store.state.permits.get(PERMIT_ID).status, 'pending_receipt');
  assert.ok(h.notices.sent[0].subject.includes("Couldn't read your reply"));

  h = await engineeringReplySetup({ text: 'Rejected - missing documents' });
  assert.equal(JSON.parse((await h.send()).body).result, 'applied');
  assert.equal(h.store.state.permits.get(PERMIT_ID).status, 'rejected');

  h = await engineeringReplySetup({ to: ['approve-0000000000000000@abc.resend.app'] });
  assert.equal(JSON.parse((await h.send()).body).ignored, 'unknown_code');
});

test('inbound: a second reply cannot re-apply a decision', async () => {
  const { store, send } = await engineeringReplySetup();
  await send();
  const auditAfterFirst = store.state.audit.length;
  const second = await send();
  assert.equal(JSON.parse(second.body).ignored, 'not_actionable');
  assert.equal(store.state.audit.length, auditAfterFirst);
});
