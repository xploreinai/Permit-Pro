import { createClient } from '@supabase/supabase-js';
import { INITIAL_PERMITS, INITIAL_AUDIT_LOGS } from './sampleData';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// A key copied from the Supabase dashboard while still masked contains bullet
// characters, which can't go into an HTTP header — every query then dies with
// an opaque "String contains non ISO-8859-1 code point". Guard against it here.
const isPlainAscii = (v) => /^[\x20-\x7E]+$/.test(v);

const useMock = !supabaseUrl || !supabaseAnonKey || !isPlainAscii(supabaseUrl) || !isPlainAscii(supabaseAnonKey);

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[supabase] VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is missing — falling back to local simulation mode.');
} else if (!isPlainAscii(supabaseAnonKey) || !isPlainAscii(supabaseUrl)) {
  console.warn('[supabase] The Supabase URL or anon key contains non-ASCII characters (often a masked key copied by mistake) — falling back to local simulation mode.');
}

const supabase = useMock ? null : createClient(supabaseUrl, supabaseAnonKey);

// camelCase (used throughout the app) <-> snake_case (DB columns). Values are
// jsonb for the nested objects/arrays, so only the column name needs mapping —
// their internal keys stay camelCase untouched.
const CAMEL_TO_SNAKE = {
  permitSeq: 'permit_seq',
  permitRef: 'permit_ref',
  formRef: 'form_ref',
  releaseDate: 'release_date',
  revisionNo: 'revision_no',
  permitTimeType: 'permit_time_type',
  startDate: 'start_date',
  endDate: 'end_date',
  durationDays: 'duration_days',
  startTime: 'start_time',
  endTime: 'end_time',
  dailySchedule: 'daily_schedule',
  companyName: 'company_name',
  mobileNo: 'mobile_no',
  workLocation: 'work_location',
  descriptionOfWork: 'description_of_work',
  riskLevel: 'risk_level',
  vehiclePlate: 'vehicle_plate',
  permitToWork: 'permit_to_work',
  safetyPrecautions: 'safety_precautions',
  contractorConfirmation: 'contractor_confirmation',
  departmentReceipt: 'department_receipt',
  cessationOfWork: 'cessation_of_work',
  idPhotoUrl: 'id_photo_url',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  lastUpdated: 'last_updated',
};
const SNAKE_TO_CAMEL = Object.fromEntries(Object.entries(CAMEL_TO_SNAKE).map(([c, s]) => [s, c]));

function toRow(data) {
  const row = {};
  for (const [key, value] of Object.entries(data)) {
    row[CAMEL_TO_SNAKE[key] ?? key] = value;
  }
  return row;
}

function fromRow(row) {
  if (!row) return row;
  const permit = {};
  for (const [key, value] of Object.entries(row)) {
    permit[SNAKE_TO_CAMEL[key] ?? key] = value;
  }
  return permit;
}

function nowStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 16);
}

function formatPermitRef(seq) {
  return `PP-${String(seq).padStart(6, '0')}`;
}

// Mock-mode equivalent of the DB's `permit_seq generated always as identity`:
// a counter that only ever advances, seeded once from the highest number in
// the sample data. Never reused, even if a permit is later deleted — that's
// what makes gaps in the sequence visible instead of silently backfilled.
function nextMockSeq() {
  const key = 'permit_pro_seq_counter';
  const seeded = Math.max(0, ...INITIAL_PERMITS.map((p) => p.permitSeq || 0));
  const current = parseInt(localStorage.getItem(key), 10);
  const next = (Number.isNaN(current) ? seeded : current) + 1;
  localStorage.setItem(key, String(next));
  return next;
}

// ----------------------------------------------------
// Mock store — localStorage + BroadcastChannel, used when no Supabase
// project is configured yet. Seeded with sample data so the app is
// demoable out of the box.
// ----------------------------------------------------
class MockStore {
  constructor() {
    this.permitListeners = new Map();
    this.auditListeners = new Map();
    this.channel = new BroadcastChannel('permit-pro-sync');
    this.channel.onmessage = (event) => {
      if (event.data === 'permits') this.triggerPermitListeners();
      if (event.data === 'audit') this.triggerAuditListeners();
    };

    if (!localStorage.getItem('permit_pro_permits')) {
      localStorage.setItem('permit_pro_permits', JSON.stringify(INITIAL_PERMITS));
    }
    if (!localStorage.getItem('permit_pro_audit_logs')) {
      localStorage.setItem('permit_pro_audit_logs', JSON.stringify(INITIAL_AUDIT_LOGS));
    }
  }

  getPermits() {
    try {
      return JSON.parse(localStorage.getItem('permit_pro_permits')) || [];
    } catch {
      return [];
    }
  }

  savePermits(permits) {
    localStorage.setItem('permit_pro_permits', JSON.stringify(permits));
    this.triggerPermitListeners();
    this.channel.postMessage('permits');
  }

  getAuditLogs() {
    try {
      return JSON.parse(localStorage.getItem('permit_pro_audit_logs')) || [];
    } catch {
      return [];
    }
  }

  saveAuditLogs(logs) {
    localStorage.setItem('permit_pro_audit_logs', JSON.stringify(logs));
    this.triggerAuditListeners();
    this.channel.postMessage('audit');
  }

  triggerPermitListeners() {
    const permits = this.getPermits();
    this.permitListeners.forEach((cb) => cb(permits));
  }

  triggerAuditListeners() {
    const logs = this.getAuditLogs();
    this.auditListeners.forEach((cb) => cb(logs));
  }

  addPermit(data) {
    const permits = this.getPermits();
    const seq = nextMockSeq();
    const newPermit = {
      ...data,
      id: crypto.randomUUID(),
      permitSeq: seq,
      permitRef: formatPermitRef(seq),
      createdAt: nowStamp(),
      lastUpdated: nowStamp(),
    };
    permits.unshift(newPermit);
    this.savePermits(permits);
    return newPermit;
  }

  patchPermit(id, patch) {
    const permits = this.getPermits();
    const index = permits.findIndex((p) => p.id === id);
    if (index === -1) return null;
    permits[index] = { ...permits[index], ...patch, lastUpdated: nowStamp() };
    this.savePermits(permits);
    return permits[index];
  }

  getPermit(id) {
    return this.getPermits().find((p) => p.id === id) ?? null;
  }

  addAuditLog(entry) {
    const logs = this.getAuditLogs();
    logs.unshift({ id: crypto.randomUUID(), createdAt: nowStamp(), ...entry });
    this.saveAuditLogs(logs);
  }

  listenPermits(callback) {
    const id = crypto.randomUUID();
    this.permitListeners.set(id, callback);
    callback(this.getPermits());
    return () => this.permitListeners.delete(id);
  }

  listenAudit(callback) {
    const id = crypto.randomUUID();
    this.auditListeners.set(id, callback);
    callback(this.getAuditLogs());
    return () => this.auditListeners.delete(id);
  }
}

const mockStore = useMock ? new MockStore() : null;

// ----------------------------------------------------
// Shared helpers
// ----------------------------------------------------
async function fetchPermit(id) {
  const { data, error } = await supabase.from('permits').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? fromRow(data) : null;
}

async function patchPermitRow(id, patch) {
  const { data, error } = await supabase
    .from('permits')
    .update(toRow({ ...patch, lastUpdated: new Date().toISOString() }))
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return fromRow(data);
}

// ----------------------------------------------------
// Public data-access API
// ----------------------------------------------------
export async function createPermit(data) {
  if (useMock) return mockStore.addPermit(data);

  // permit_seq and permit_ref are assigned by the DB (identity column +
  // trigger) — never computed client-side, so concurrent submissions can't
  // collide or skip a number.
  const { data: row, error } = await supabase
    .from('permits')
    .insert(toRow(data))
    .select()
    .single();
  if (error) throw error;
  return fromRow(row);
}

export async function updatePermit(id, patch) {
  if (useMock) return mockStore.patchPermit(id, patch);
  return patchPermitRow(id, patch);
}

export async function updatePermitStatus(id, status, extra = {}) {
  return updatePermit(id, { status, ...extra });
}

export async function submitWorkCessation(id, cessationData) {
  return updatePermit(id, {
    cessationOfWork: { isCompleted: true, time: nowStamp(), ...cessationData },
    status: 'pending_checkout',
  });
}

export async function finalizePermitCancellation(id, cancellationData) {
  return updatePermit(id, {
    cancellation: { isCancelled: true, date: new Date().toISOString().split('T')[0], time: nowStamp(), ...cancellationData },
    status: 'cancelled',
  });
}

export async function toggleWorkerCheckIn(permitId, workerId) {
  const permit = useMock ? mockStore.getPermit(permitId) : await fetchPermit(permitId);
  if (!permit) return null;
  const workers = permit.workers.map((w) => {
    if (w.id !== workerId) return w;
    const checkingIn = !w.isCheckedIn;
    return {
      ...w,
      isCheckedIn: checkingIn,
      checkInTime: checkingIn ? nowStamp() : w.checkInTime,
      checkOutTime: checkingIn ? null : nowStamp(),
    };
  });
  return updatePermit(permitId, { workers });
}

export async function batchCheckInPermit(permitId) {
  const permit = useMock ? mockStore.getPermit(permitId) : await fetchPermit(permitId);
  if (!permit) return null;
  const time = nowStamp();
  const workers = permit.workers.map((w) => ({ ...w, isCheckedIn: true, checkInTime: time, checkOutTime: null }));
  return updatePermit(permitId, { workers, status: 'active' });
}

export async function batchCheckOutPermit(permitId) {
  const permit = useMock ? mockStore.getPermit(permitId) : await fetchPermit(permitId);
  if (!permit) return null;
  const time = nowStamp();
  const workers = permit.workers.map((w) => ({ ...w, isCheckedIn: false, checkOutTime: time }));
  return updatePermit(permitId, { workers, status: 'completed' });
}

export async function logAuditEvent(entry) {
  if (useMock) {
    mockStore.addAuditLog(entry);
    return;
  }
  const { error } = await supabase.from('audit_logs').insert({
    permit_id: entry.permitId ?? null,
    event_type: entry.eventType,
    message: entry.message,
    actor: entry.actor ?? null,
  });
  if (error) throw error;
}

export function subscribePermits(callback) {
  if (useMock) return mockStore.listenPermits(callback);

  const emit = async () => {
    const { data, error } = await supabase.from('permits').select('*').order('created_at', { ascending: false });
    if (error) {
      console.error('[supabase] subscribePermits fetch failed:', error);
      return;
    }
    callback(data.map(fromRow));
  };

  emit();
  const channel = supabase
    .channel('permits-collection')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'permits' }, emit)
    .subscribe();

  return () => supabase.removeChannel(channel);
}

export function subscribeAuditLogs(callback) {
  if (useMock) return mockStore.listenAudit(callback);

  const emit = async () => {
    const { data, error } = await supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) {
      console.error('[supabase] subscribeAuditLogs fetch failed:', error);
      return;
    }
    callback(
      data.map((row) => ({
        id: row.id,
        permitId: row.permit_id,
        eventType: row.event_type,
        message: row.message,
        actor: row.actor,
        createdAt: row.created_at,
      }))
    );
  };

  emit();
  const channel = supabase
    .channel('audit-logs-collection')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_logs' }, emit)
    .subscribe();

  return () => supabase.removeChannel(channel);
}

export { supabase, useMock };
