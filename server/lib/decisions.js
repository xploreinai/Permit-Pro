import { KIND_LABEL } from './email.js';

const stamp = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 16);

// Whether a request can still be acted on for this permit right now. Checked
// both when the page is shown and again when the decision is applied, so an
// approval already made in the app (or by another approver) is respected.
export function describeActionable(request, permit, now = new Date()) {
  if (!permit) return { actionable: false, reason: 'This permit no longer exists.' };
  if (request.status !== 'pending') {
    return { actionable: false, reason: request.status === 'superseded'
      ? 'Another approver has already decided this permit.'
      : 'This link has already been used.' };
  }
  if (new Date(request.expires_at) < now) return { actionable: false, reason: 'This link has expired.' };

  if (request.kind === 'engineering') {
    if (permit.status !== 'pending_receipt') return { actionable: false, reason: 'This permit has already been handled.' };
  } else if (request.kind === 'hcc') {
    const hcc = permit.hcc_approval || {};
    if (!hcc.required) return { actionable: false, reason: 'This permit does not need HCC approval.' };
    if (hcc.approved) return { actionable: false, reason: 'HCC approval was already recorded.' };
    if (['rejected', 'cancelled', 'completed'].includes(permit.status)) return { actionable: false, reason: 'This permit has already been handled.' };
  }
  return { actionable: true };
}

function buildPatch({ request, permit, decision, note, now }) {
  const approver = request.recipient_email;
  const at = stamp(now);
  const approved = decision === 'approve';

  if (request.kind === 'engineering') {
    return {
      allowedStatuses: ['pending_receipt'],
      patch: {
        department_receipt: {
          authorized: approved,
          ...(approved ? {} : { rejected: true }),
          supervisorName: approver,
          authorizedAt: at,
          notes: note || (approved ? 'Approved by email.' : 'Rejected by email.'),
          signatureDataUrl: '',
        },
        status: approved ? 'pending_checkin' : 'rejected',
      },
    };
  }

  // HCC: approval only flips the HCC flag (Security's gate already blocks entry
  // until it is set); rejection stops the whole permit.
  return {
    allowedStatuses: ['pending_receipt', 'pending_checkin'],
    patch: {
      hcc_approval: {
        required: true,
        approved,
        ...(approved ? {} : { rejected: true }),
        approvedBy: approver,
        approvedAt: at,
        notes: note || (approved ? 'Approved by email.' : 'Rejected by email.'),
      },
      ...(approved ? {} : { status: 'rejected' }),
    },
  };
}

// Applies an approve/reject decision. `via` is 'link' or 'email_reply'.
export async function applyDecision({ store, request, decision, via, note = '', now = new Date() }) {
  const permit = await store.getPermit(request.permit_id);
  const check = describeActionable(request, permit, now);
  if (!check.actionable) return { result: 'not_actionable', reason: check.reason, permit };

  const cleanNote = String(note || '').trim().slice(0, 500);

  // Claim first: only one caller can ever turn a pending request into a decision.
  const claimed = await store.claimRequest(request.id, {
    status: decision === 'approve' ? 'approved' : 'rejected',
    decided_via: via,
    decided_at: now.toISOString(),
    decision_note: cleanNote || null,
  });
  if (!claimed) return { result: 'not_actionable', reason: 'This link has already been used.', permit };

  const { allowedStatuses, patch } = buildPatch({ request, permit, decision, note: cleanNote, now });
  const updated = await store.updatePermitGuarded(permit.id, allowedStatuses, patch);
  if (!updated) return { result: 'not_actionable', reason: 'This permit was changed by someone else a moment ago.', permit };

  await store.supersedeSiblings(permit.id, request.kind, request.id);
  await store.insertAudit({
    permitId: permit.id,
    eventType: `email_${request.kind}_${decision === 'approve' ? 'approved' : 'rejected'}`,
    message: `${KIND_LABEL[request.kind]} ${decision === 'approve' ? 'approval' : 'rejection'} recorded for ${permit.permit_ref} via ${via === 'link' ? 'email link' : 'email reply'} by ${request.recipient_email}.${cleanNote ? ` Note: ${cleanNote}` : ''}`,
    actor: request.recipient_email,
  });

  return { result: 'applied', decision, permit: updated };
}
