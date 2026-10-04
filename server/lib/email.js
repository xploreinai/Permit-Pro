// Email sending (Resend) and the message/page templates.
// Every value that came from a vendor's form is HTML-escaped before it is put
// into an email or an approval page.

export const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const KIND_LABEL = { engineering: 'Engineering (Section 8)', hcc: 'HCC Manager (High-Risk)' };

export async function sendEmail({ apiKey, from, to, subject, html, text, replyTo, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.message || `HTTP ${res.status}` };
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function summaryRows(permit) {
  const crew = Array.isArray(permit.workers) ? permit.workers.length : 0;
  return [
    ['Permit', permit.permit_ref],
    ['Company', permit.company_name],
    ['Location', permit.work_location],
    ['Date', permit.end_date && permit.end_date !== permit.start_date ? `${permit.start_date} to ${permit.end_date}` : permit.start_date],
    ['Hours', `${permit.start_time} – ${permit.end_time}`],
    ['Crew', `${crew} worker(s)`],
    ['Risk level', permit.risk_level],
    ['Work', permit.description_of_work],
  ];
}

export function buildApprovalEmail({ permit, kind, link, replyEnabled }) {
  const isHcc = kind === 'hcc';
  const subject = `${isHcc ? '[High-Risk] ' : ''}Permit ${permit.permit_ref} needs your approval — ${permit.company_name}`;
  const rows = summaryRows(permit);

  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:16px">
  <h2 style="margin:0 0 4px">Work permit approval needed</h2>
  <p style="margin:0 0 16px;color:#555">${esc(KIND_LABEL[kind])} — The Abu Dhabi EDITION</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    ${rows.map(([k, v]) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;color:#777;width:110px;vertical-align:top">${esc(k)}</td><td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(v)}</td></tr>`).join('')}
  </table>
  ${isHcc ? '<p style="background:#fdecea;border:1px solid #f5c2c0;padding:10px;border-radius:4px;font-size:13px"><strong>High-risk work.</strong> The vendor was told to email the risk assessment and method statement to you separately. Approve only after you have reviewed them.</p>' : ''}
  <p style="margin:24px 0 8px"><a href="${esc(link)}" style="background:#1a1a1a;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block">Review &amp; decide</a></p>
  <p style="font-size:13px;color:#555;margin:0 0 16px">The link opens a page where you press <strong>Approve</strong> or <strong>Reject</strong>.</p>
  ${replyEnabled ? '<p style="font-size:13px;color:#555;border-top:1px solid #eee;padding-top:12px"><strong>Or just reply to this email</strong> with <em>Approved</em> or <em>Rejected</em> (send it from this same email address). Keep the reply short — if it is not clear, you will be asked to use the link.</p>' : ''}
  <p style="font-size:11px;color:#999">This link is personal to you and works once. Do not forward this email.</p>
</body></html>`;

  const text = [
    `Work permit approval needed — ${KIND_LABEL[kind]}`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    `Review and decide: ${link}`,
    replyEnabled ? '\nOr reply to this email with "Approved" or "Rejected" (from this same email address).' : '',
    '',
    'This link is personal to you and works once. Do not forward this email.',
  ].join('\n');

  return { subject, html, text };
}

export function buildReceiptEmail({ permit, kind, decision, via }) {
  const word = decision === 'approve' ? 'APPROVED' : 'REJECTED';
  const how = via === 'email_reply' ? 'your email reply' : 'the approval link';
  const subject = `Recorded: permit ${permit.permit_ref} ${word}`;
  const text = `Your decision was recorded via ${how}.\n\nPermit ${permit.permit_ref} (${permit.company_name}) — ${KIND_LABEL[kind]}: ${word}.\n\nIf you did not do this, tell the EHS team immediately.`;
  const html = `<p style="font-family:Arial,sans-serif">Your decision was recorded via ${esc(how)}.</p><p style="font-family:Arial,sans-serif"><strong>Permit ${esc(permit.permit_ref)}</strong> (${esc(permit.company_name)}) — ${esc(KIND_LABEL[kind])}: <strong>${word}</strong>.</p><p style="font-family:Arial,sans-serif;color:#b00020">If you did not do this, tell the EHS team immediately.</p>`;
  return { subject, html, text };
}

export function buildClarifyEmail({ permit, link }) {
  const subject = `Couldn't read your reply — permit ${permit.permit_ref}`;
  const text = `We couldn't tell from your reply whether you approve or reject permit ${permit.permit_ref} (${permit.company_name}), so nothing was changed.\n\nPlease reply with just "Approved" or "Rejected", or use your link:\n${link ? link : '(use the link in the original email)'}`;
  const html = `<p style="font-family:Arial,sans-serif">We couldn't tell from your reply whether you approve or reject permit <strong>${esc(permit.permit_ref)}</strong> (${esc(permit.company_name)}), so <strong>nothing was changed</strong>.</p><p style="font-family:Arial,sans-serif">Please reply with just <em>Approved</em> or <em>Rejected</em>, or use the link in the original email.</p>`;
  return { subject, html, text };
}

// ---- Approval page (served by /api/approve) ----

const PAGE_STYLE = `body{font-family:Arial,Helvetica,sans-serif;background:#faf8f5;color:#1a1a1a;margin:0;padding:16px}
.card{max-width:520px;margin:24px auto;background:#fff;border:1px solid #c5a880;border-radius:6px;padding:24px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#777;font-size:13px;margin:0 0 16px}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top}td:first-child{color:#777;width:110px}
.warn{background:#fdecea;border:1px solid #f5c2c0;padding:10px;border-radius:4px;font-size:13px;margin:12px 0}
.note{background:#fff8e1;border:1px solid #ffe08a;padding:10px;border-radius:4px;font-size:13px;margin:12px 0}
textarea{width:100%;box-sizing:border-box;margin:12px 0;padding:8px;border:1px solid #ccc;border-radius:4px;font:inherit}
.row{display:flex;gap:12px}button{flex:1;padding:14px;border:0;border-radius:4px;font-size:16px;font-weight:bold;color:#fff;cursor:pointer}
.ok{background:#1b7f3b}.no{background:#b3261e}`;

export function renderPage({ title, bodyHtml }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
}

export function renderDecisionPage({ permit, kind, token, hccPending }) {
  const rows = summaryRows(permit);
  return renderPage({
    title: `Permit ${permit.permit_ref}`,
    bodyHtml: `<h1>Permit ${esc(permit.permit_ref)}</h1><p class="sub">${esc(KIND_LABEL[kind])} — The Abu Dhabi EDITION</p>
<table>${rows.slice(1).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
${kind === 'hcc' ? '<div class="warn"><strong>High-risk work.</strong> Approve only after reviewing the risk assessment and method statement the vendor emailed you.</div>' : ''}
${kind === 'engineering' && hccPending ? '<div class="note">This is a high-risk permit. Your approval is recorded, but the crew cannot enter until the HCC Manager also approves.</div>' : ''}
<form method="POST" action="/api/approve">
  <input type="hidden" name="token" value="${esc(token)}">
  <label for="note" style="font-size:13px;color:#555">Note (optional — shown to the team; useful if rejecting)</label>
  <textarea id="note" name="note" rows="3" maxlength="500"></textarea>
  <div class="row"><button class="ok" type="submit" name="decision" value="approve">Approve</button><button class="no" type="submit" name="decision" value="reject">Reject</button></div>
</form>`,
  });
}

export function renderMessagePage(title, message) {
  return renderPage({ title, bodyHtml: `<h1>${esc(title)}</h1><p>${esc(message)}</p>` });
}
