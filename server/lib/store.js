import { createClient } from '@supabase/supabase-js';

// Server-side data access using the service-role key (bypasses RLS). This is
// the ONLY place that touches the approval_requests table. Everything is
// behind this small interface so the handlers can be tested with an in-memory
// fake instead of a live database.

export function createAdminClient(config) {
  return createClient(config.supabaseUrl, config.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

const must = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};

export function createStore(db) {
  return {
    async getPermit(id) {
      return must(await db.from('permits').select('*').eq('id', id).maybeSingle());
    },

    async hasRecentRequest(permitId, kind, sinceIso) {
      const rows = must(await db.from('approval_requests').select('id')
        .eq('permit_id', permitId).eq('kind', kind).gte('created_at', sinceIso).limit(1));
      return rows.length > 0;
    },

    async insertRequest(row) {
      return must(await db.from('approval_requests').insert(row).select().single());
    },

    async getRequestByTokenHash(hash) {
      return must(await db.from('approval_requests').select('*').eq('token_hash', hash).maybeSingle());
    },

    async getRequestByReplyCode(code) {
      return must(await db.from('approval_requests').select('*').eq('reply_code', code).maybeSingle());
    },

    async setRequestStatus(id, status) {
      must(await db.from('approval_requests').update({ status }).eq('id', id));
    },

    // Atomically take a pending request: succeeds for exactly one caller, which
    // makes every link/reply single-use even under double clicks or retries.
    async claimRequest(id, patch) {
      return must(await db.from('approval_requests').update(patch).eq('id', id).eq('status', 'pending').select().maybeSingle());
    },

    async supersedeSiblings(permitId, kind, exceptId) {
      must(await db.from('approval_requests').update({ status: 'superseded' })
        .eq('permit_id', permitId).eq('kind', kind).eq('status', 'pending').neq('id', exceptId));
    },

    // Update the permit only if its status is still one we expect.
    async updatePermitGuarded(id, allowedStatuses, patch) {
      return must(await db.from('permits')
        .update({ ...patch, last_updated: new Date().toISOString() })
        .eq('id', id).in('status', allowedStatuses).select().maybeSingle());
    },

    async insertAudit({ permitId, eventType, message, actor }) {
      must(await db.from('audit_logs').insert({ permit_id: permitId, event_type: eventType, message, actor }));
    },
  };
}
