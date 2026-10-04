import { useMock } from './supabase';

// Asks the server (/api/request-approval) to email the approvers for a permit.
// The server decides who gets emailed from its own configuration — the browser
// only says which permit. Email is an extra channel, never a requirement: if it
// isn't set up (or we're in local simulation mode, or running `vite dev`, which
// has no /api), this quietly reports { ok: false } and the app works as before.
export async function requestApprovalEmails(permitId) {
  if (useMock) return { ok: false, reason: 'simulation_mode' };
  try {
    const res = await fetch('/api/request-approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permitId }),
    });
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    if (!isJson) return { ok: false, reason: 'api_unavailable' };
    const data = await res.json();
    return res.ok ? data : { ok: false, reason: data.error || `http_${res.status}` };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

export function describeApprovalResult(result) {
  if (!result?.ok) {
    return result?.reason === 'email_not_configured' || result?.reason === 'api_unavailable' || result?.reason === 'simulation_mode'
      ? 'Email approvals are not set up yet — approvers must use the app.'
      : 'Could not send the approval email. Approvers can still use the app.';
  }
  const parts = (result.sent || []).map((s) => (s.kind === 'hcc' ? 'HCC Manager' : 'Engineering'));
  if (parts.length) return `Approval request emailed to ${parts.join(' and ')}.`;
  if ((result.skipped || []).some((s) => s.reason === 'recently_sent')) return 'An approval email was sent a moment ago — please wait a few minutes before resending.';
  if ((result.skipped || []).some((s) => s.reason === 'no_approver_configured')) return 'No approver email address is set up yet.';
  return 'No approval email was needed.';
}
