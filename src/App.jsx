import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  createPermit,
  updatePermit,
  updatePermitStatus,
  submitWorkCessation,
  finalizePermitCancellation,
  toggleWorkerCheckIn,
  batchCheckInPermit,
  batchCheckOutPermit,
  vendorMarkCompleted,
  acknowledgeCompletion,
  logAuditEvent,
  subscribePermits,
  subscribeAuditLogs,
  useMock,
} from './supabase';
import {
  HOTEL_LOCATIONS,
  PERMIT_TIME_TYPES,
  TYPE_LOCATION_VALUE,
  DURATION_PRESETS,
  MAX_PERMIT_DAYS,
  CREW_PRESETS,
  HCC_MANAGER_EMAIL,
  generateDailySchedule,
  diffDaysInclusive,
  validateWorkerId,
} from './sampleData';
import {
  FileText, ShieldCheck, Wrench, Clock, Camera, CheckCircle, AlertTriangle, User, Building,
  MapPin, Calendar, Layers, Search, Bell, Check, X, LogIn, RefreshCw, QrCode, Users,
  MessageSquare, Flame, Mountain, Zap, Wind, Phone, Trash2, PenTool, Printer, Mail,
  Siren, BarChart3, Award, ClipboardList, ChevronRight, Plus, UserCheck, UserX, Contrast,
  Share2, UserPlus, ThumbsUp, Copy, ShieldAlert,
} from 'lucide-react';
import Tesseract from 'tesseract.js';
import { QRCodeCanvas } from 'qrcode.react';
import { jsPDF } from 'jspdf';
import confetti from 'canvas-confetti';
import { savePhoto } from './localPhotos';

// ----------------------------------------------------
// Shared helpers
// ----------------------------------------------------
function hoursBetween(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60; // overnight shift
  return mins / 60;
}

function isWithinWindow(startTime, endTime, now = new Date()) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  if (startMins <= endMins) return nowMins >= startMins && nowMins <= endMins;
  return nowMins >= startMins || nowMins <= endMins; // overnight
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

function crewSizeOf(permit) {
  return permit.workers?.length || 0;
}

function statusLabel(status) {
  const map = {
    pending_receipt: 'Pending Supervisor Receipt (Sec. 8)',
    pending_checkin: 'Authorized — Awaiting Gate 3 Check-In',
    active: 'Active On Site',
    pending_completion_ack: 'Work Completed — Awaiting Engineering Acknowledgment',
    pending_checkout: 'Acknowledged — Awaiting Gate 3 Check-Out',
    completed: 'Checked Out (Pending Closure)',
    cancelled: 'Cancelled / Closed (Sec. 10)',
  };
  return map[status] || status;
}

function statusBadgeClass(status) {
  const map = {
    pending_receipt: 'bg-blue-50 text-blue-700 border-blue-200',
    pending_checkin: 'bg-amber-50 text-amber-700 border-amber-200',
    active: 'bg-green-50 text-green-700 border-green-200',
    pending_completion_ack: 'bg-teal-50 text-teal-700 border-teal-200',
    pending_checkout: 'bg-purple-50 text-purple-700 border-purple-200',
    completed: 'bg-gray-100 text-gray-600 border-gray-200',
    cancelled: 'bg-red-50 text-red-700 border-red-200',
  };
  return map[status] || 'bg-gray-100 text-gray-600 border-gray-200';
}

// A permit is "resuming" (not its first-ever check-in) once any scheduled
// day already has a checkedInAt — used to skip re-showing the full
// first-time approval framing at Gate 3 and on the vendor's status card.
function hasResumedBefore(permit) {
  return (permit.dailyLog || []).some((d) => d.checkedInAt);
}

function dayProgress(permit) {
  const total = permit.dailySchedule?.length || permit.durationDays || 1;
  const done = (permit.dailyLog || []).filter((d) => d.checkedOutAt).length;
  return { done, total };
}

function fireConfetti() {
  confetti({ particleCount: 90, spread: 70, origin: { y: 0.6 }, colors: ['#C5A880', '#A58B62', '#1A1A1A'] });
}

// ----------------------------------------------------
// ROOT APP
// ----------------------------------------------------
// True only for the dedicated vendor-application link (?view=apply) — that
// link is what gets shared/QR-coded to contractors, so it must never expose
// the staff nav or any other section, no matter what `activeTab` holds.
const isVendorOnlyLink = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('view') === 'apply';

function vendorLinkUrl() {
  const url = new URL(window.location.href);
  url.search = '?view=apply';
  return url.toString();
}

function App() {
  const [activeTab, setActiveTab] = useState('vendor');
  const [permits, setPermits] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [activePermitId, setActivePermitId] = useState(null);
  const [gstTime, setGstTime] = useState('');
  const [modal, setModal] = useState(null); // { type, permit? }
  const [assistActor, setAssistActor] = useState(null); // who is filling the vendor form on someone's behalf

  const startAssist = (actor) => {
    setAssistActor(actor);
    setActivePermitId(null);
    setActiveTab('vendor');
  };
  const clearAssist = () => setAssistActor(null);
  const [grayscale, setGrayscale] = useState(() => {
    try {
      return localStorage.getItem('permit_pro_grayscale') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('permit_pro_grayscale', grayscale ? '1' : '0');
    } catch {
      // ignore — per-viewer convenience only
    }
  }, [grayscale]);

  useEffect(() => {
    const unsub = subscribePermits(setPermits);
    return () => unsub();
  }, []);

  useEffect(() => {
    const unsub = subscribeAuditLogs(setAuditLogs);
    return () => unsub();
  }, []);

  useEffect(() => {
    const tick = () => {
      const gst = new Date().toLocaleString('en-GB', {
        timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      setGstTime(gst);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  const activePermit = useMemo(() => permits.find((p) => p.id === activePermitId) || null, [permits, activePermitId]);

  const totalOnSiteHeadcount = useMemo(
    () => permits.filter((p) => p.status === 'active').reduce((sum, p) => sum + crewSizeOf(p), 0),
    [permits]
  );

  const pendingReceiptCount = permits.filter((p) => p.status === 'pending_receipt').length;

  const openModal = (type, permit = null) => setModal({ type, permit });
  const closeModal = () => setModal(null);

  const tabs = [
    { id: 'vendor', label: 'Vendor Portal' },
    { id: 'security', label: 'Security Gate 3' },
    { id: 'supervisor', label: 'Engineering Supervisor' },
    { id: 'admin', label: 'EHS Admin Dashboard' },
  ];

  return (
    <div className="min-h-screen bg-edition-cream flex flex-col" style={grayscale ? { filter: 'grayscale(100%)' } : undefined}>
      <header className="bg-edition-950 text-white py-4 px-6 border-b border-edition-gold shadow-md no-print">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 bg-edition-gold flex items-center justify-center font-bold text-edition-black rounded-sm tracking-wider">
              PP
            </div>
            <div>
              <h1 className="font-display text-2xl font-bold tracking-widest text-edition-cream uppercase leading-none">
                Permit Pro
              </h1>
              <p className="text-[10px] text-edition-gold uppercase tracking-wider">
                The Abu Dhabi EDITION &bull; TADE-OSHMS-Form 11
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {!isVendorOnlyLink && (
              <>
                <div className="hidden md:flex items-center gap-1.5 bg-edition-charcoal border border-edition-gold/30 px-3 py-1.5 rounded text-[11px] font-mono">
                  <span className={`h-2 w-2 rounded-full bg-green-400 beacon-pulse`} />
                  GST {gstTime}
                </div>
                <div className="flex items-center gap-1.5 bg-edition-gold text-edition-black px-3 py-1.5 rounded text-[11px] font-bold uppercase tracking-wider">
                  <Users className="h-3.5 w-3.5" />
                  {totalOnSiteHeadcount} On Site
                </div>
                <button
                  onClick={() => openModal('shareLink')}
                  title="Share the vendor application link / QR code"
                  className="p-2 rounded border bg-edition-charcoal text-edition-gold border-edition-gold/30 hover:border-edition-gold transition-all"
                >
                  <Share2 className="h-4 w-4" />
                </button>
              </>
            )}
            <button
              onClick={() => setGrayscale((g) => !g)}
              title="Toggle black-and-white mode"
              className={`p-2 rounded border transition-all ${grayscale ? 'bg-edition-gold text-edition-black border-edition-gold' : 'bg-edition-charcoal text-edition-gold border-edition-gold/30 hover:border-edition-gold'}`}
            >
              <Contrast className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* The vendor-application link (?view=apply) never renders this nav —
            a contractor on that link has no way to reach any staff-only
            section, regardless of what's typed into the address bar. */}
        {!isVendorOnlyLink && (
          <nav className="max-w-7xl mx-auto flex flex-wrap bg-edition-charcoal p-1 rounded border border-edition-gold/30 mt-4">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`relative px-4 py-2 rounded-sm text-xs font-medium uppercase tracking-wider transition-all duration-200 ${
                  activeTab === t.id ? 'bg-edition-gold text-edition-black shadow' : 'text-gray-300 hover:text-white'
                }`}
              >
                {t.label}
                {t.id === 'supervisor' && pendingReceiptCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 bg-red-600 text-white text-[9px] font-bold h-4 w-4 rounded-full flex items-center justify-center">
                    {pendingReceiptCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
        )}
      </header>

      <main className="flex-grow max-w-7xl w-full mx-auto p-4 md:p-8">
        {(isVendorOnlyLink || activeTab === 'vendor') && (
          <VendorPortalView
            activePermit={activePermit}
            setActivePermitId={setActivePermitId}
            openModal={openModal}
            assistedBy={assistActor}
            clearAssist={clearAssist}
          />
        )}
        {!isVendorOnlyLink && activeTab === 'security' && (
          <StaffGate area="Security Gate 3">
            <SecurityGateView permits={permits} onAssist={() => startAssist('Security Gate 3')} />
          </StaffGate>
        )}
        {!isVendorOnlyLink && activeTab === 'supervisor' && (
          <StaffGate area="Engineering Supervisor">
            <SupervisorHubView permits={permits} openModal={openModal} onAssist={() => startAssist('Engineering Supervisor')} />
          </StaffGate>
        )}
        {!isVendorOnlyLink && activeTab === 'admin' && (
          <StaffGate area="EHS Admin Dashboard">
            <AdminDashboardView permits={permits} auditLogs={auditLogs} totalOnSiteHeadcount={totalOnSiteHeadcount} openModal={openModal} />
          </StaffGate>
        )}
      </main>

      <footer className="bg-edition-black/5 border-t border-edition-gold/20 py-4 text-center text-xs text-gray-500 no-print">
        <p>&copy; 2026 Permit Pro &bull; The Abu Dhabi EDITION. Database: {useMock ? 'Local Simulation Sandbox Mode' : 'Connected to Supabase'}</p>
      </footer>

      {modal?.type === 'form11' && <Form11OfficialDocumentModal permit={modal.permit} onClose={closeModal} />}
      {modal?.type === 'masterReport' && <MasterComplianceReportModal permits={permits} onClose={closeModal} />}
      {modal?.type === 'emailBackup' && <EmailBackupModal permit={modal.permit} onClose={closeModal} />}
      {modal?.type === 'evacuation' && <EmergencyEvacuationModal permits={permits} onClose={closeModal} />}
      {modal?.type === 'shareLink' && <ShareApplicationModal onClose={closeModal} />}
    </div>
  );
}

// ----------------------------------------------------
// STAFF GATE — keeps every staff-only section behind a PIN. Shared across
// Security, Supervisor and Admin so a contractor who somehow lands on the
// staff URL (rather than the vendor-only link) still can't see anything —
// this is basic pilot-mode protection, not real authentication: the PIN
// lives in this client bundle and the database has no per-role access
// control behind it. Treat it as a lock on the door, not a vault.
function StaffGate({ area, children }) {
  const [unlocked, setUnlocked] = useState(() => {
    try {
      return sessionStorage.getItem('permit_pro_staff_unlocked') === '1';
    } catch {
      return false;
    }
  });
  const [pin, setPin] = useState('');

  const handleLogin = (e) => {
    e.preventDefault();
    if (pin === '1234' || pin === 'admin') {
      try { sessionStorage.setItem('permit_pro_staff_unlocked', '1'); } catch { /* per-viewer convenience only */ }
      setUnlocked(true);
    } else {
      alert('Invalid staff PIN.');
    }
  };

  if (unlocked) return children;

  return (
    <div className="max-w-md mx-auto bg-white border border-edition-gold p-6 rounded shadow-lg text-center mt-12">
      <LogIn className="h-10 w-10 text-edition-gold mx-auto mb-3" />
      <h2 className="text-xl font-bold tracking-wider text-edition-black uppercase">{area}</h2>
      <p className="text-xs text-gray-500 mb-4">Staff access only — enter the PIN to continue.</p>
      <form onSubmit={handleLogin} className="space-y-4">
        <input type="password" placeholder="Enter Staff PIN" value={pin} onChange={(e) => setPin(e.target.value)}
          className="w-full bg-edition-cream border border-edition-gold/30 rounded px-3 py-2 text-center text-sm focus:outline-none focus:border-edition-gold font-medium" required autoFocus />
        <button type="submit" className="w-full bg-edition-black text-white hover:bg-edition-charcoal text-xs uppercase tracking-widest py-3 rounded border border-edition-gold">Unlock</button>
      </form>
    </div>
  );
}

// ----------------------------------------------------
// SHARE APPLICATION LINK — QR + copyable URL for off-site contractors
// ----------------------------------------------------
function ShareApplicationModal({ onClose }) {
  const [copied, setCopied] = useState(false);
  const url = vendorLinkUrl();

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard access denied — the link is still visible to copy manually
    }
  };

  return (
    <ModalShell title="Apply for a Work Permit" subtitle="Safe to share with any contractor — on-site or off-site" onClose={onClose}>
      <div className="flex flex-col items-center">
        <div className="bg-edition-cream p-4 rounded border border-edition-gold/30 mb-4">
          <QRCodeCanvas value={url} size={180} bgColor="#FAF8F5" fgColor="#1A1A1A" />
        </div>
        <p className="text-xs text-gray-600 text-center mb-3">
          This link opens <strong>only</strong> the application form — no staff sections, no other permits' data. Safe to post publicly or hand to any contractor.
        </p>
        <div className="w-full bg-edition-cream border border-edition-gold/30 rounded px-3 py-2 text-xs font-mono break-all mb-3">
          {url}
        </div>
        <button onClick={copyLink} className="w-full flex items-center justify-center gap-1.5 bg-edition-black text-white text-xs uppercase tracking-widest py-3 rounded border border-edition-gold">
          <Copy className="h-3.5 w-3.5 text-edition-gold" /> {copied ? 'Link Copied!' : 'Copy Link'}
        </button>
      </div>
    </ModalShell>
  );
}

// ----------------------------------------------------
// VENDOR PORTAL — Sections 1-7 (permit application)
// ----------------------------------------------------
function VendorPortalView({ activePermit, setActivePermitId, openModal, assistedBy, clearAssist }) {
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState(todayIso());
  const [permitTimeTypeId, setPermitTimeTypeId] = useState('day');
  const [startTime, setStartTime] = useState(PERMIT_TIME_TYPES[0].startTime);
  const [endTime, setEndTime] = useState(PERMIT_TIME_TYPES[0].endTime);
  const [locationSelectValue, setLocationSelectValue] = useState('');
  const [locationName, setLocationName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [mobileNo, setMobileNo] = useState('');
  const [vehiclePlate, setVehiclePlate] = useState('');
  const [descriptionOfWork, setDescriptionOfWork] = useState('');

  const [ptw, setPtw] = useState({ hotWork: false, workingAtHeights: false, confinedSpace: false, others: false, othersText: '' });
  const [documents, setDocuments] = useState({ methodStatement: '', safetyInstruction: '', riskAssessment: '', insuranceDocument: '' });
  const [safety, setSafety] = useState({ barriersErected: false, safetySignsAndNotices: false, laddersTiedFooted: false, ventilateTheArea: false, others: '' });
  const [ppe, setPpe] = useState({ safetyFootwear: false, hardHat: false, eyeProtection: false, handProtection: false, earProtection: false, fallArrestSystem: false, others: '' });

  const [workers, setWorkers] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const fileInputRef = useRef(null);

  const [repName, setRepName] = useState('');
  const [signatureData, setSignatureData] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const durationDays = diffDaysInclusive(startDate, endDate);
  const overMax = durationDays > MAX_PERMIT_DAYS;
  const dailySchedule = useMemo(() => generateDailySchedule(startDate, endDate, startTime, endTime), [startDate, endDate, startTime, endTime]);

  const selectedLocation = HOTEL_LOCATIONS.find((l) => l.name === locationName);
  const isHighRiskWork = ptw.hotWork || ptw.workingAtHeights || ptw.confinedSpace;
  const riskLevel = isHighRiskWork || selectedLocation?.riskLevel === 'High' ? 'High' : 'Regular';

  const applyPermitTimeType = (id) => {
    const t = PERMIT_TIME_TYPES.find((p) => p.id === id);
    if (!t) return;
    setPermitTimeTypeId(id);
    setStartTime(t.startTime);
    setEndTime(t.endTime);
    if (id === 'night') {
      setPtw((prev) => ({ ...prev, hotWork: false }));
    }
  };

  const applyDurationPreset = (days) => {
    if (days === 1) {
      const today = todayIso();
      setStartDate(today);
      setEndDate(today);
      return;
    }
    const start = new Date(`${startDate}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + (days - 1));
    setEndDate(end.toISOString().split('T')[0]);
  };

  const setToMax = () => applyDurationPreset(MAX_PERMIT_DAYS);

  const handleLocationSelect = (value) => {
    setLocationSelectValue(value);
    if (value === TYPE_LOCATION_VALUE) {
      setLocationName('');
    } else {
      setLocationName(value);
    }
  };

  const applyCrewPreset = (preset) => {
    setWorkers(preset.workers.map((w, i) => ({
      id: `w-${Date.now()}-${i}`,
      ...w,
      badgeNo: '',
      localPhotoId: null,
      isCheckedIn: false,
      checkInTime: null,
      checkOutTime: null,
    })));
  };

  const addBlankWorker = () => {
    setWorkers((prev) => [...prev, {
      id: `w-${Date.now()}`, name: '', emiratesId: '', expiryDate: '', trade: '', role: '', phone: '', badgeNo: '',
      localPhotoId: null, isCheckedIn: false, checkInTime: null, checkOutTime: null,
    }]);
  };

  const updateWorker = (id, field, value) => {
    setWorkers((prev) => prev.map((w) => (w.id === id ? { ...w, [field]: value } : w)));
  };

  const removeWorker = (id) => setWorkers((prev) => prev.filter((w) => w.id !== id));

  // Extracts an Emirates ID number (784-YYYY-NNNNNNN-C) and an expiry date
  // from raw OCR text. Emirates ID cards print the expiry as DD/MM/YYYY,
  // usually on the line labeled "Expiry Date" / "Date of Expiry".
  function parseEmiratesIdText(rawText) {
    const idMatch = rawText.match(/784[\s-]?\d{4}[\s-]?\d{7}[\s-]?\d/);
    const emiratesId = idMatch ? idMatch[0].replace(/[\s]/g, '').replace(/^(\d{3})-?(\d{4})-?(\d{7})-?(\d)$/, '$1-$2-$3-$4') : '';

    const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
    let expiryDate = '';
    for (let i = 0; i < lines.length; i++) {
      if (/expiry/i.test(lines[i])) {
        const dateMatch = (lines[i] + ' ' + (lines[i + 1] || '')).match(/(\d{2})[/.-](\d{2})[/.-](\d{4})/);
        if (dateMatch) {
          expiryDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
        }
        break;
      }
    }
    return { emiratesId, expiryDate };
  }

  const handleOcrScan = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setIsScanning(true);
    setOcrProgress(0);
    try {
      const result = await Tesseract.recognize(file, 'eng', {
        logger: (m) => { if (m.status === 'recognizing text') setOcrProgress(Math.round(m.progress * 100)); },
      });
      const rawText = result.data.text;
      const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
      let parsedName = '';
      for (let i = 0; i < lines.length; i++) {
        if (/name/i.test(lines[i])) {
          const match = lines[i].replace(/name/i, '').replace(/[:;]/, '').trim();
          parsedName = match.length > 3 ? match : (lines[i + 1] || '');
        }
      }
      if (!parsedName) parsedName = lines.find((l) => l.length > 5 && !/\d/.test(l)) || 'Unnamed Worker';
      const { emiratesId, expiryDate } = parseEmiratesIdText(rawText);

      const workerId = `w-${Date.now()}`;
      // Keep the actual card image on this device only — never uploaded to
      // Supabase — so it doesn't eat into the shared database's storage.
      try {
        await savePhoto(workerId, file);
      } catch (photoErr) {
        console.error('Could not save ID photo locally:', photoErr);
      }

      setWorkers((prev) => [...prev, {
        id: workerId, name: parsedName, emiratesId, expiryDate, trade: '', role: 'Worker', phone: '', badgeNo: '',
        localPhotoId: workerId, isCheckedIn: false, checkInTime: null, checkOutTime: null,
      }]);
    } catch (err) {
      console.error(err);
      alert('ID scan failed — add the worker manually.');
    } finally {
      setIsScanning(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const workerValidity = workers.map((w) => validateWorkerId(w));
  const hasInvalidWorker = workerValidity.some((v) => !v.valid);

  const canSubmit = !overMax && locationName && companyName && mobileNo && descriptionOfWork && workers.length > 0 && !hasInvalidWorker && confirmed && repName;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (hasInvalidWorker) {
      alert('One or more workers have an invalid or expired Emirates ID. Fix or remove them before submitting.');
      return;
    }
    if (!canSubmit) {
      alert('Please complete all required sections, add at least one worker, and confirm the contractor declaration.');
      return;
    }
    const isHighRisk = riskLevel === 'High';
    const permitData = {
      startDate, endDate, durationDays, permitTimeType: permitTimeTypeId, startTime, endTime, dailySchedule,
      companyName, mobileNo, workLocation: locationName, descriptionOfWork, riskLevel, vehiclePlate,
      permitToWork: ptw,
      documents: {
        methodStatement: documents.methodStatement || 'NO',
        safetyInstruction: documents.safetyInstruction || 'NO',
        riskAssessment: documents.riskAssessment || 'NO',
        insuranceDocument: documents.insuranceDocument || 'NO',
      },
      safetyPrecautions: safety,
      ppe,
      contractorConfirmation: { confirmed: true, representativeName: repName, signedAt: new Date().toISOString().replace('T', ' ').slice(0, 16), signatureDataUrl: signatureData },
      departmentReceipt: { authorized: false, supervisorName: '', authorizedAt: '', notes: '', signatureDataUrl: '' },
      cessationOfWork: { isCompleted: false, signedBy: '', time: '', notes: '', signatureDataUrl: '' },
      cancellation: { isCancelled: false, signedBy: '', date: '', time: '', signatureDataUrl: '' },
      dailyLog: dailySchedule.map((d) => ({ date: d.date, checkedInAt: null, checkedOutAt: null })),
      hccApproval: { required: isHighRisk, approved: false, approvedBy: '', approvedAt: '', notes: '' },
      closureMode: null,
      completionAck: {},
      submittedByStaff: assistedBy || '',
      status: 'pending_receipt',
      idPhotoUrl: '',
      workers,
    };
    try {
      const created = await createPermit(permitData);
      await logAuditEvent({
        permitId: created.id,
        eventType: 'permit_created',
        message: `Permit ${created.permitRef} submitted by ${companyName} (${workers.length} workers).${assistedBy ? ` Assisted by ${assistedBy}.` : ''}`,
        actor: assistedBy || repName,
      });
      setActivePermitId(created.id);
      if (clearAssist) clearAssist();
    } catch (err) {
      console.error(err);
      alert('Submission failed. Check the console for details.');
    }
  };

  if (activePermit) {
    return <VendorPermitStatusCard permit={activePermit} onReset={() => setActivePermitId(null)} openModal={openModal} />;
  }

  return (
    <div className="max-w-3xl mx-auto bg-white border border-edition-gold rounded shadow-lg">
      <div className="text-center pt-8 pb-4 px-6 border-b border-edition-gold/15">
        <h2 className="font-display text-3xl font-bold tracking-wider text-edition-black uppercase">General Work Permit</h2>
        <div className="h-0.5 bg-edition-gold w-16 mx-auto mt-2 mb-2" />
        <p className="text-[11px] text-gray-500 tracking-wider uppercase">TADE-OSHMS-Form 11 (Rev 01) &bull; Contractor Application</p>
      </div>

      {assistedBy && (
        <div className="mx-6 md:mx-8 mt-6 bg-blue-50 border border-blue-300 text-blue-800 rounded p-3 text-xs font-semibold flex items-center gap-1.5">
          <UserPlus className="h-4 w-4 shrink-0" /> Filling this out on the vendor's behalf — assisted by {assistedBy}.
        </div>
      )}

      {riskLevel === 'High' && (
        <div className="mx-6 md:mx-8 mt-6 bg-red-50 border border-red-300 text-red-800 rounded p-3 text-xs flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            <strong className="uppercase tracking-wide">High-Risk Permit.</strong> Email the Risk Assessment, Method Statement, and supporting
            documents separately to the HCC Manager at <strong>{HCC_MANAGER_EMAIL}</strong>. This permit will not be authorized for site access
            until the HCC Manager approves it in the system — bring the physical originals to site once approved.
          </span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="p-6 md:p-8 space-y-8">

        {/* SECTION 1-3: Validity, Hours, Particulars */}
        <Section title="1-3 · When and Where" icon={Calendar}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start Date *">
              <input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
            </Field>
            <Field label="End Date *">
              <input type="date" required value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} className={inputCls} />
            </Field>
          </div>

          <div className="flex flex-wrap gap-2 mt-3">
            {DURATION_PRESETS.map((d) => (
              <button type="button" key={d} onClick={() => applyDurationPreset(d)}
                className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider border rounded hover:border-edition-gold ${d === 1 ? 'bg-edition-gold text-edition-black border-edition-gold' : 'bg-edition-cream text-edition-black border-edition-gold/40'}`}>
                {d === 1 ? 'Today' : `${d} Days`}{d === MAX_PERMIT_DAYS ? ' (Max 1 Wk)' : ''}
              </button>
            ))}
          </div>

          {overMax && (
            <div className="mt-3 bg-red-50 border border-red-300 text-red-800 rounded p-3 text-xs flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-4 w-4" /> Permits cannot exceed {MAX_PERMIT_DAYS} consecutive days ({durationDays} selected).</span>
              <button type="button" onClick={setToMax} className="bg-red-700 text-white px-3 py-1 rounded text-[10px] font-bold uppercase shrink-0">Set to 7-Day Max</button>
            </div>
          )}

          <div className="mt-5">
            <label className="block text-[11px] font-semibold text-edition-black uppercase tracking-wider mb-1.5">Day or Night Work? *</label>
            <div className="grid grid-cols-2 gap-2 mb-2">
              {PERMIT_TIME_TYPES.map((t) => (
                <button type="button" key={t.id} onClick={() => applyPermitTimeType(t.id)}
                  className={`px-3 py-2.5 text-left rounded border ${permitTimeTypeId === t.id ? 'bg-edition-black text-white border-edition-gold' : 'bg-edition-cream text-edition-black border-edition-gold/30'}`}>
                  <span className="block text-[11px] font-bold uppercase tracking-wider">{t.label}</span>
                  <span className={`block text-[10px] mt-0.5 ${permitTimeTypeId === t.id ? 'text-edition-gold' : 'text-gray-500'}`}>{t.hoursLabel}</span>
                </button>
              ))}
            </div>

            {permitTimeTypeId === 'night' && (
              <div className="bg-amber-50 border border-amber-300 text-amber-800 rounded p-2.5 text-[11px] mb-2 flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Night Work Permit — noisy or hot work is not permitted at night. Noisy work must be scheduled on a Day Permit (10:00 AM – 5:00 PM).
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label="Daily Start Time">
                <input type="time" value={startTime} disabled={permitTimeTypeId === 'day'}
                  onChange={(e) => setStartTime(e.target.value)}
                  className={`${inputCls} ${permitTimeTypeId === 'day' ? 'opacity-60 cursor-not-allowed' : ''}`} />
              </Field>
              <Field label="Daily End Time">
                <input type="time" value={endTime} disabled={permitTimeTypeId === 'day'}
                  onChange={(e) => setEndTime(e.target.value)}
                  className={`${inputCls} ${permitTimeTypeId === 'day' ? 'opacity-60 cursor-not-allowed' : ''}`} />
              </Field>
            </div>
          </div>

          {dailySchedule.length > 0 && !overMax && (
            <div className="mt-3 border border-edition-gold/20 rounded overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-edition-cream uppercase text-[9px] text-gray-500">
                  <tr><th className="px-3 py-2 text-left">Day</th><th className="px-3 py-2 text-left">Date</th><th className="px-3 py-2 text-left">Working Window</th></tr>
                </thead>
                <tbody className="divide-y divide-edition-gold/10">
                  {dailySchedule.map((d) => (
                    <tr key={d.dayNumber}><td className="px-3 py-1.5 font-semibold">Day {d.dayNumber} ({d.dayName})</td><td className="px-3 py-1.5">{d.date}</td><td className="px-3 py-1.5 font-mono">{d.formattedHours}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-3 mt-5">
            <Field label="Location of Work *">
              <select required={locationSelectValue !== TYPE_LOCATION_VALUE} value={locationSelectValue} onChange={(e) => handleLocationSelect(e.target.value)} className={inputCls}>
                <option value="">Select location inside the hotel...</option>
                <option value={TYPE_LOCATION_VALUE}>✎ Type location manually...</option>
                {HOTEL_LOCATIONS.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
              </select>
              {locationSelectValue === TYPE_LOCATION_VALUE && (
                <input
                  autoFocus
                  required
                  value={locationName}
                  onChange={(e) => setLocationName(e.target.value)}
                  placeholder="Type the exact location..."
                  className={`${inputCls} mt-2`}
                />
              )}
            </Field>
            <Field label="Contracting Company *">
              <input required value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="e.g. Al Futtaim Engineering LLC" className={inputCls} />
            </Field>
            <Field label="Mobile Number *">
              <input required value={mobileNo} onChange={(e) => setMobileNo(e.target.value)} placeholder="+971 5X XXX XXXX" className={inputCls} />
            </Field>
            <Field label="Vehicle Plate (optional)">
              <input value={vehiclePlate} onChange={(e) => setVehiclePlate(e.target.value)} placeholder="Abu Dhabi 5 - 49201" className={inputCls} />
            </Field>
          </div>

          <Field label="Description of Work *" className="mt-3">
            <textarea required rows="3" value={descriptionOfWork} onChange={(e) => setDescriptionOfWork(e.target.value)}
              placeholder="Describe the scope of work in detail..." className={inputCls} />
          </Field>
        </Section>

        {/* SECTION 4: Permit To Work Requirements */}
        <Section title="4 · What Type of Work Is This?" icon={Flame}>
          <div className="grid grid-cols-2 gap-2">
            <Checkbox label="Hot Work (welding, cutting, grinding)" checked={ptw.hotWork} onChange={(v) => setPtw({ ...ptw, hotWork: v })} icon={Flame} disabled={permitTimeTypeId === 'night'} disabledHint="Not allowed at night" />
            <Checkbox label="Working at Heights (ladder, scaffold)" checked={ptw.workingAtHeights} onChange={(v) => setPtw({ ...ptw, workingAtHeights: v })} icon={Mountain} />
            <Checkbox label="Confined Space (small closed area)" checked={ptw.confinedSpace} onChange={(v) => setPtw({ ...ptw, confinedSpace: v })} icon={Wind} />
            <Checkbox label="Other" checked={ptw.others} onChange={(v) => setPtw({ ...ptw, others: v })} icon={Zap} />
          </div>
          {ptw.others && (
            <input value={ptw.othersText} onChange={(e) => setPtw({ ...ptw, othersText: e.target.value })} placeholder="Tell us what kind of work..." className={`${inputCls} mt-2`} />
          )}
        </Section>

        {/* SECTION 5: Documentation Verification */}
        <Section title="5 · Do You Have These Documents?" icon={ClipboardList}>
          <div className="space-y-2">
            <TriStateField label="Method Statement" value={documents.methodStatement} onChange={(v) => setDocuments({ ...documents, methodStatement: v })} />
            <TriStateField label="Safety Instruction" value={documents.safetyInstruction} onChange={(v) => setDocuments({ ...documents, safetyInstruction: v })} />
            <TriStateField label="Risk Assessment" value={documents.riskAssessment} onChange={(v) => setDocuments({ ...documents, riskAssessment: v })} />
            <TriStateField label="Insurance Document" value={documents.insuranceDocument} onChange={(v) => setDocuments({ ...documents, insuranceDocument: v })} />
          </div>
        </Section>

        {/* SECTION 6: Precautionary Measures & PPE */}
        <Section title="6 · Safety Steps & Protective Gear" icon={ShieldCheck}>
          <p className="text-[10px] font-bold uppercase text-gray-500 mb-1.5">Safety Steps at the Work Area</p>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <Checkbox label="Barriers Put Up" checked={safety.barriersErected} onChange={(v) => setSafety({ ...safety, barriersErected: v })} />
            <Checkbox label="Warning Signs Put Up" checked={safety.safetySignsAndNotices} onChange={(v) => setSafety({ ...safety, safetySignsAndNotices: v })} />
            <Checkbox label="Ladders Held / Tied" checked={safety.laddersTiedFooted} onChange={(v) => setSafety({ ...safety, laddersTiedFooted: v })} />
            <Checkbox label="Fresh Air / Ventilation" checked={safety.ventilateTheArea} onChange={(v) => setSafety({ ...safety, ventilateTheArea: v })} />
          </div>
          <input value={safety.others} onChange={(e) => setSafety({ ...safety, others: e.target.value })} placeholder="Anything else? (e.g. fire extinguisher on site)" className={`${inputCls} mb-4`} />

          <p className="text-[10px] font-bold uppercase text-gray-500 mb-1.5">Safety Gear You Will Wear</p>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <Checkbox label="Safety Shoes" checked={ppe.safetyFootwear} onChange={(v) => setPpe({ ...ppe, safetyFootwear: v })} />
            <Checkbox label="Hard Hat / Helmet" checked={ppe.hardHat} onChange={(v) => setPpe({ ...ppe, hardHat: v })} />
            <Checkbox label="Safety Glasses" checked={ppe.eyeProtection} onChange={(v) => setPpe({ ...ppe, eyeProtection: v })} />
            <Checkbox label="Gloves" checked={ppe.handProtection} onChange={(v) => setPpe({ ...ppe, handProtection: v })} />
            <Checkbox label="Ear Protection" checked={ppe.earProtection} onChange={(v) => setPpe({ ...ppe, earProtection: v })} />
            <Checkbox label="Fall Arrest Harness" checked={ppe.fallArrestSystem} onChange={(v) => setPpe({ ...ppe, fallArrestSystem: v })} />
          </div>
          <input value={ppe.others} onChange={(e) => setPpe({ ...ppe, others: e.target.value })} placeholder="Anything else? (e.g. welding gloves)" className={inputCls} />
        </Section>

        {/* CREW ROSTER */}
        <Section title="Workers on This Permit" icon={Users}>
          <div className="flex flex-wrap gap-2 mb-3">
            {CREW_PRESETS.map((preset) => (
              <button type="button" key={preset.id} onClick={() => applyCrewPreset(preset)}
                className="flex items-center gap-1.5 bg-edition-black text-white text-[11px] font-semibold uppercase tracking-wider px-3 py-2 rounded border border-edition-gold">
                <Zap className="h-3.5 w-3.5 text-edition-gold" /> {preset.label}
              </button>
            ))}
            <button type="button" onClick={addBlankWorker}
              className="flex items-center gap-1.5 bg-white text-edition-black text-[11px] font-semibold uppercase tracking-wider px-3 py-2 rounded border border-edition-gold/40">
              <Plus className="h-3.5 w-3.5" /> Add Worker
            </button>
            <input type="file" accept="image/*" capture="environment" ref={fileInputRef} onChange={handleOcrScan} className="hidden" />
            <button type="button" onClick={() => fileInputRef.current.click()}
              className="flex items-center gap-1.5 bg-white text-edition-black text-[11px] font-semibold uppercase tracking-wider px-3 py-2 rounded border border-edition-gold/40">
              <Camera className="h-3.5 w-3.5" /> Scan Emirates ID
            </button>
          </div>

          {isScanning && (
            <div className="mb-3 text-xs text-edition-black font-semibold flex items-center gap-1.5">
              <RefreshCw className="h-3.5 w-3.5 animate-spin text-edition-gold" /> Reading ID card... ({ocrProgress}%)
            </div>
          )}

          {workers.length === 0 ? (
            <p className="text-xs text-gray-500 italic">No workers added yet. Use a crew preset, scan an Emirates ID, or add one manually.</p>
          ) : (
            <div className="space-y-2">
              {workers.map((w, i) => {
                const validity = validateWorkerId(w);
                return (
                  <div key={w.id} className={`rounded p-2 border ${validity.valid ? 'bg-edition-cream/50 border-edition-gold/15' : 'bg-red-50 border-red-300'}`}>
                    <div className="grid grid-cols-12 gap-2 items-center">
                      <span className="col-span-1 text-[10px] font-bold text-gray-400 text-center">#{i + 1}</span>
                      <input value={w.name} onChange={(e) => updateWorker(w.id, 'name', e.target.value)} placeholder="Full name" className="col-span-3 bg-white border border-edition-gold/20 rounded px-2 py-1.5 text-xs" />
                      <input value={w.emiratesId} onChange={(e) => updateWorker(w.id, 'emiratesId', e.target.value)} placeholder="784-XXXX-XXXXXXX-X" className={`col-span-2 bg-white border rounded px-2 py-1.5 text-xs ${validity.valid ? 'border-edition-gold/20' : 'border-red-400 text-red-700'}`} />
                      <input type="date" value={w.expiryDate || ''} onChange={(e) => updateWorker(w.id, 'expiryDate', e.target.value)} title="Emirates ID expiry date" className={`col-span-2 bg-white border rounded px-2 py-1.5 text-xs ${validity.valid ? 'border-edition-gold/20' : 'border-red-400 text-red-700'}`} />
                      <input value={w.trade} onChange={(e) => updateWorker(w.id, 'trade', e.target.value)} placeholder="Trade" className="col-span-2 bg-white border border-edition-gold/20 rounded px-2 py-1.5 text-xs" />
                      <input value={w.role} onChange={(e) => updateWorker(w.id, 'role', e.target.value)} placeholder="Role" className="col-span-1 bg-white border border-edition-gold/20 rounded px-2 py-1.5 text-xs" />
                      <button type="button" onClick={() => removeWorker(w.id)} className="col-span-1 text-red-500 hover:text-red-700 flex justify-center"><Trash2 className="h-4 w-4" /></button>
                    </div>
                    {!validity.valid && (
                      <div className="flex items-center gap-1.5 text-[10px] font-bold text-red-700 uppercase tracking-wider mt-1.5 ml-8">
                        <AlertTriangle className="h-3 w-3" /> {validity.reason} — cannot submit until fixed or removed.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-[10px] text-gray-500 mt-2">{workers.length} worker(s) registered on this permit.</p>
          {hasInvalidWorker && (
            <div className="mt-2 bg-red-50 border border-red-300 text-red-800 rounded p-2.5 text-[11px] font-semibold flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4 shrink-0" /> One or more Emirates IDs are invalid or expired. Submission is blocked until every worker has a valid, unexpired ID.
            </div>
          )}
        </Section>

        {/* SECTION 7: Contractor Confirmation */}
        <Section title="7 · Your Confirmation & Signature" icon={PenTool}>
          <Field label="Your Full Name *">
            <input required value={repName} onChange={(e) => setRepName(e.target.value)} placeholder="Full name of signatory" className={inputCls} />
          </Field>
          <SignaturePad label="Sign Here" onChange={setSignatureData} className="mt-3" />
          <label className="flex items-start gap-2 mt-3 text-xs text-gray-700">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
            I confirm this information is correct. All workers listed here know the safety rules for this job. I am responsible for following the hotel's safety rules while this permit is valid.
          </label>
        </Section>

        <button type="submit" disabled={!canSubmit}
          className="w-full bg-edition-gold hover:bg-edition-darkGold disabled:opacity-40 disabled:cursor-not-allowed text-edition-black font-bold text-xs uppercase tracking-widest py-3.5 px-4 rounded border border-edition-gold shadow transition-all">
          Submit for Approval
        </button>
      </form>
    </div>
  );
}

function Section({ title, icon: Icon, children }) {
  return (
    <div className="border-t border-edition-gold/10 pt-6 first:border-t-0 first:pt-0">
      <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-edition-black mb-3">
        <Icon className="h-4 w-4 text-edition-gold" /> {title}
      </h3>
      {children}
    </div>
  );
}

function Field({ label, children, className = '' }) {
  return (
    <div className={className}>
      <label className="block text-[11px] font-semibold text-edition-black uppercase tracking-wider mb-1">{label}</label>
      {children}
    </div>
  );
}

function Checkbox({ label, checked, onChange, icon: Icon, disabled = false, disabledHint = '' }) {
  return (
    <label
      title={disabled ? disabledHint : undefined}
      className={`flex items-center gap-2 border rounded px-3 py-2 text-xs font-medium transition-all ${
        disabled ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed line-through'
        : checked ? 'bg-edition-black text-white border-edition-gold cursor-pointer'
        : 'bg-edition-cream text-edition-black border-edition-gold/20 cursor-pointer'
      }`}
    >
      <input type="checkbox" checked={checked && !disabled} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="hidden" />
      {Icon && <Icon className={`h-3.5 w-3.5 ${checked && !disabled ? 'text-edition-gold' : 'text-gray-400'}`} />}
      {label}{disabled && disabledHint ? ` — ${disabledHint}` : ''}
    </label>
  );
}

function TriStateField({ label, value, onChange }) {
  const options = [
    { id: 'YES', label: 'Yes' },
    { id: 'NO', label: 'No' },
    { id: 'N_A', label: 'N/A' },
  ];
  return (
    <div className="flex items-center justify-between gap-3 bg-edition-cream/50 border border-edition-gold/15 rounded px-3 py-2">
      <span className="text-xs font-medium text-edition-black">{label}</span>
      <div className="flex gap-1">
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded border ${
              value === opt.id
                ? opt.id === 'YES' ? 'bg-green-600 text-white border-green-600'
                : opt.id === 'NO' ? 'bg-red-600 text-white border-red-600'
                : 'bg-gray-500 text-white border-gray-500'
                : 'bg-white text-edition-black border-edition-gold/25'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const inputCls = 'w-full bg-edition-cream border border-edition-gold/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-edition-gold text-edition-black';

// ----------------------------------------------------
// Signature pad — lightweight canvas capture
// ----------------------------------------------------
function SignaturePad({ label, onChange, className = '' }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);

  const getPos = (e, canvas) => {
    const rect = canvas.getBoundingClientRect();
    const point = e.touches ? e.touches[0] : e;
    return { x: point.clientX - rect.left, y: point.clientY - rect.top };
  };

  const start = (e) => {
    drawing.current = true;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const { x, y } = getPos(e, canvas);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e) => {
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const { x, y } = getPos(e, canvas);
    ctx.lineTo(x, y);
    ctx.strokeStyle = '#1A1A1A';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.stroke();
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(canvasRef.current.toDataURL('image/png'));
  };
  const clear = () => {
    const canvas = canvasRef.current;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    onChange('');
  };

  return (
    <div className={className}>
      <label className="block text-[11px] font-semibold text-edition-black uppercase tracking-wider mb-1">{label}</label>
      <canvas
        ref={canvasRef} width={500} height={120}
        className="w-full bg-white border border-dashed border-edition-gold/50 rounded touch-none cursor-crosshair"
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
      />
      <button type="button" onClick={clear} className="text-[10px] text-gray-500 hover:text-red-600 uppercase tracking-wider mt-1">Clear Signature</button>
    </div>
  );
}

// ----------------------------------------------------
// Vendor's live permit status card
// ----------------------------------------------------
function VendorPermitStatusCard({ permit, onReset, openModal }) {
  const [marking, setMarking] = useState(false);
  const { done, total } = dayProgress(permit);
  const resuming = permit.status === 'pending_checkin' && hasResumedBefore(permit);

  const markCompleted = async () => {
    setMarking(true);
    try {
      await vendorMarkCompleted(permit.id);
      await logAuditEvent({ permitId: permit.id, eventType: 'vendor_marked_completed', message: `${permit.companyName} marked work completed for today on ${permit.permitRef}.`, actor: permit.contractorConfirmation?.representativeName || permit.companyName });
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto bg-white border border-edition-gold p-8 rounded shadow-lg text-center">
      <h2 className="font-display text-3xl font-semibold tracking-wider text-edition-black mb-1 uppercase">Permit {permit.permitRef}</h2>
      <div className="h-0.5 bg-edition-gold w-16 mx-auto mt-2 mb-6" />

      <div className="bg-edition-cream inline-block p-4 rounded border border-edition-gold/30 mb-6">
        <QRCodeCanvas value={permit.id} size={128} bgColor="#FAF8F5" fgColor="#1A1A1A" />
        <p className="text-[10px] uppercase text-gray-500 tracking-widest mt-2">Permit ID: {permit.id.slice(0, 8)}</p>
      </div>

      {total > 1 && (
        <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-3">Day {done + 1} of {total} &bull; Valid {permit.startDate} to {permit.endDate}</p>
      )}

      <div className={`border rounded-md py-3 px-4 mb-4 flex flex-col items-center ${statusBadgeClass(permit.status)}`}>
        <span className="flex items-center gap-1.5 font-semibold text-sm uppercase tracking-wide">
          {permit.status === 'active' ? <CheckCircle className="h-5 w-5" /> : <RefreshCw className="h-4 w-4 animate-spin" />}
          {resuming ? 'Valid Permit — Ready to Resume at Gate 3' : statusLabel(permit.status)}
        </span>
      </div>

      {permit.hccApproval?.required && (
        <div className={`border rounded-md py-2.5 px-4 mb-6 text-xs font-semibold flex items-center justify-center gap-1.5 ${permit.hccApproval.approved ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-300 text-red-800'}`}>
          <ShieldAlert className="h-4 w-4 shrink-0" />
          {permit.hccApproval.approved
            ? `HCC Approved by ${permit.hccApproval.approvedBy}`
            : `HCC Manager Approval Pending — email documents to ${HCC_MANAGER_EMAIL}`}
        </div>
      )}

      <div className="text-left bg-edition-cream/50 p-4 rounded border border-edition-gold/10 text-sm space-y-2 mb-6">
        <Row label="Location" value={permit.workLocation} />
        <Row label="Validity" value={`${permit.startDate} to ${permit.endDate} (${permit.durationDays}d)`} />
        <Row label="Daily Hours" value={`${permit.startTime} - ${permit.endTime}`} />
        <Row label="Crew Size" value={`${crewSizeOf(permit)} Person(s)`} />
        <Row label="Company" value={permit.companyName} />
        <div className="pt-1.5 text-xs text-gray-600">
          <span className="text-gray-400 block uppercase text-[10px] mb-0.5">Description of work</span>
          <p className="italic bg-white p-2 rounded border border-edition-gold/10">{permit.descriptionOfWork}</p>
        </div>
      </div>

      {permit.status === 'active' && (
        <button onClick={markCompleted} disabled={marking}
          className="w-full flex items-center justify-center gap-1.5 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white font-bold text-xs uppercase tracking-widest py-3 rounded mb-3">
          <ThumbsUp className="h-4 w-4" /> {marking ? 'Submitting...' : 'Mark Work Completed for Today'}
        </button>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => openModal('form11', permit)} className="flex items-center justify-center gap-1.5 bg-white border border-edition-gold text-edition-black text-[11px] uppercase tracking-wider py-2.5 rounded">
          <Printer className="h-3.5 w-3.5" /> View Form 11
        </button>
        <button onClick={onReset} className="bg-edition-black text-white hover:bg-edition-charcoal text-[11px] uppercase tracking-widest py-2.5 rounded border border-edition-gold">
          New Application
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between border-b border-edition-gold/10 pb-1.5">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-right">{value}</span>
    </div>
  );
}

// ----------------------------------------------------
// SECURITY GATE 3 — check-in/out, daily window status
// ----------------------------------------------------
function SecurityGateView({ permits, onAssist }) {
  const [nowTick, setNowTick] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNowTick(new Date()), 15000);
    return () => clearInterval(id);
  }, []);

  const pendingCheckIn = permits.filter((p) => p.status === 'pending_checkin');
  const activeOnSite = permits.filter((p) => p.status === 'active');
  const pendingCheckOut = permits.filter((p) => p.status === 'pending_checkout');

  const doBatchCheckIn = async (permit) => {
    await batchCheckInPermit(permit.id);
    await logAuditEvent({ permitId: permit.id, eventType: 'crew_checked_in', message: `Full crew (${crewSizeOf(permit)}) checked in at Gate 3.`, actor: 'Security Gate 3' });
    fireConfetti();
  };

  const doBatchCheckOut = async (permit) => {
    await batchCheckOutPermit(permit.id);
    await logAuditEvent({ permitId: permit.id, eventType: 'crew_checked_out', message: `Full crew (${crewSizeOf(permit)}) checked out at Gate 3.`, actor: 'Security Gate 3' });
  };

  const toggleWorker = async (permit, workerId) => {
    await toggleWorkerCheckIn(permit.id, workerId);
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div className="flex justify-end">
        <button onClick={onAssist} className="flex items-center gap-1.5 bg-edition-black text-white text-[11px] uppercase tracking-wider px-3 py-2 rounded border border-edition-gold">
          <UserPlus className="h-3.5 w-3.5 text-edition-gold" /> Assist New Vendor Application
        </button>
      </div>

      <GateSection title="Awaiting Gate 3 Check-In" icon={ShieldCheck} count={pendingCheckIn.length} badgeClass="bg-amber-100 border-amber-300 text-amber-800">
        {pendingCheckIn.length === 0 ? <Empty text="No permits awaiting entry check-in." /> : (
          <div className="grid md:grid-cols-2 gap-4">
            {pendingCheckIn.map((permit) => {
              const hccBlocked = permit.hccApproval?.required && !permit.hccApproval?.approved;
              const resuming = hasResumedBefore(permit);
              const { done, total } = dayProgress(permit);
              return (
                <PermitGateCard key={permit.id} permit={permit}>
                  {resuming && (
                    <div className="bg-blue-50 border border-blue-200 text-blue-800 rounded px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider mb-2">
                      Resuming — Day {done + 1} of {total}, already authorized
                    </div>
                  )}
                  {hccBlocked ? (
                    <div className="bg-red-50 border border-red-300 text-red-800 rounded p-2.5 text-[11px] font-semibold flex items-center gap-1.5">
                      <ShieldAlert className="h-4 w-4 shrink-0" /> Blocked — Awaiting HCC Manager Approval
                    </div>
                  ) : (
                    <button onClick={() => doBatchCheckIn(permit)} className="w-full flex items-center justify-center gap-1.5 bg-edition-black text-white hover:bg-edition-charcoal text-[11px] uppercase tracking-widest font-semibold py-3 px-4 rounded border border-edition-gold">
                      <UserCheck className="h-4 w-4 text-edition-gold" /> {resuming ? 'Resume Check-In' : 'Check-In All Crew'} ({crewSizeOf(permit)})
                    </button>
                  )}
                </PermitGateCard>
              );
            })}
          </div>
        )}
      </GateSection>

      <GateSection title="Active On-Site Crews" icon={Users} count={activeOnSite.length} badgeClass="bg-green-100 border-green-300 text-green-800">
        {activeOnSite.length === 0 ? <Empty text="No crews currently on site." /> : (
          <div className="grid md:grid-cols-2 gap-4">
            {activeOnSite.map((permit) => {
              const within = isWithinWindow(permit.startTime, permit.endTime, nowTick);
              return (
                <PermitGateCard key={permit.id} permit={permit}>
                  <div className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full inline-flex items-center gap-1 mb-2 ${within ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                    <span className={`h-2 w-2 rounded-full ${within ? 'bg-green-500' : 'bg-amber-500'}`} />
                    {within ? 'Within Permitted Daily Window' : 'Outside Permitted Daily Window'}
                  </div>
                  <div className="space-y-1.5 mb-2">
                    {permit.workers.map((w) => (
                      <div key={w.id} className="flex items-center justify-between bg-white border border-edition-gold/15 rounded px-2 py-1.5 text-xs">
                        <div>
                          <span className="font-semibold">{w.name}</span>
                          <span className="text-gray-400 ml-2">{w.badgeNo || '—'}</span>
                        </div>
                        <button onClick={() => toggleWorker(permit, w.id)} className={`text-[9px] font-bold uppercase px-2 py-1 rounded ${w.isCheckedIn ? 'bg-green-600 text-white' : 'bg-gray-200 text-gray-600'}`}>
                          {w.isCheckedIn ? 'On Site' : 'Off Site'}
                        </button>
                      </div>
                    ))}
                  </div>
                </PermitGateCard>
              );
            })}
          </div>
        )}
      </GateSection>

      <GateSection title="Awaiting Gate 3 Check-Out" icon={Clock} count={pendingCheckOut.length} badgeClass="bg-purple-100 border-purple-300 text-purple-800">
        {pendingCheckOut.length === 0 ? <Empty text="No crews cleared for release yet." /> : (
          <div className="grid md:grid-cols-2 gap-4">
            {pendingCheckOut.map((permit) => {
              const isLastDay = todayIso() >= permit.endDate;
              const isFinal = permit.closureMode === 'series' || isLastDay;
              return (
                <PermitGateCard key={permit.id} permit={permit}>
                  <div className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded mb-2 inline-block ${isFinal ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'}`}>
                    {isFinal ? 'Final — Permit Closes on Checkout' : 'Day Closure — Permit Resumes Tomorrow'}
                  </div>
                  <button onClick={() => doBatchCheckOut(permit)} className="w-full flex items-center justify-center gap-1.5 bg-purple-700 hover:bg-purple-800 text-white text-[11px] uppercase tracking-widest font-semibold py-3 px-4 rounded">
                    <UserX className="h-4 w-4" /> {isFinal ? 'Check-Out, Return IDs & Close Permit' : 'Check-Out & Return IDs for Today'} ({crewSizeOf(permit)})
                  </button>
                </PermitGateCard>
              );
            })}
          </div>
        )}
      </GateSection>
    </div>
  );
}

function GateSection({ title, icon: Icon, count, badgeClass, children }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4 border-b border-edition-gold/15 pb-2">
        <h2 className="text-xl font-bold tracking-wider text-edition-black uppercase flex items-center gap-2">
          <Icon className="h-6 w-6 text-edition-gold" /> {title}
        </h2>
        <span className={`border px-3 py-1 rounded-sm text-xs font-semibold tracking-wider ${badgeClass}`}>{count}</span>
      </div>
      {children}
    </div>
  );
}

function Empty({ text }) {
  return <p className="text-xs text-gray-500 italic py-3">{text}</p>;
}

function PermitGateCard({ permit, children }) {
  return (
    <div className="bg-white border border-edition-gold rounded p-5 shadow">
      <div className="flex justify-between items-start mb-2">
        <div>
          <h3 className="font-bold text-base text-edition-black">{permit.companyName}</h3>
          <p className="text-xs font-semibold text-edition-darkGold uppercase tracking-wider">{permit.permitRef} &bull; {permit.workLocation}</p>
        </div>
        <span className={`px-2 py-0.5 border rounded text-[9px] font-bold uppercase tracking-wider ${permit.riskLevel === 'High' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-edition-cream text-edition-black border-edition-gold/20'}`}>
          {permit.riskLevel}
        </span>
      </div>
      <div className="bg-edition-cream/60 rounded p-2 text-xs space-y-1 my-3 border border-edition-gold/10">
        <div><span className="text-gray-500 uppercase text-[9px]">Crew:</span> <span className="font-bold">{crewSizeOf(permit)} Workers</span></div>
        <div><span className="text-gray-500 uppercase text-[9px]">Daily Hours:</span> <span className="font-mono font-semibold">{permit.startTime} - {permit.endTime}</span></div>
        <div className="italic text-gray-600 line-clamp-1">{permit.descriptionOfWork}</div>
      </div>
      {children}
    </div>
  );
}

// ----------------------------------------------------
// ENGINEERING SUPERVISOR HUB — Section 8 & 9
// ----------------------------------------------------
function SupervisorHubView({ permits, openModal, onAssist }) {
  const [section8Permit, setSection8Permit] = useState(null);
  const [section9Permit, setSection9Permit] = useState(null);
  const [ackPermit, setAckPermit] = useState(null);

  const pendingReceipt = permits.filter((p) => p.status === 'pending_receipt');
  const activeWork = permits.filter((p) => p.status === 'active');
  const pendingAck = permits.filter((p) => p.status === 'pending_completion_ack');

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div className="flex justify-end">
        <button onClick={onAssist} className="flex items-center gap-1.5 bg-edition-black text-white text-[11px] uppercase tracking-wider px-3 py-2 rounded border border-edition-gold">
          <UserPlus className="h-3.5 w-3.5 text-edition-gold" /> Assist New Vendor Application
        </button>
      </div>

      <div>
        <h3 className="text-sm font-bold uppercase text-edition-black tracking-widest mb-3 border-b border-edition-gold/10 pb-1.5">
          Section 8 · Awaiting Department Receipt ({pendingReceipt.length})
        </h3>
        {pendingReceipt.length === 0 ? <Empty text="No permits awaiting supervisor sign-off." /> : (
          <div className="grid md:grid-cols-2 gap-4">
            {pendingReceipt.map((permit) => (
              <PermitGateCard key={permit.id} permit={permit}>
                <button onClick={() => setSection8Permit(permit)} className="w-full bg-edition-gold hover:bg-edition-darkGold text-edition-black font-bold text-xs uppercase tracking-widest py-3 px-4 rounded border border-edition-gold">
                  Review &amp; Authorize (Sec. 8)
                </button>
              </PermitGateCard>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-bold uppercase text-edition-black tracking-widest mb-3 border-b border-edition-gold/10 pb-1.5">
          Awaiting Completion Acknowledgment ({pendingAck.length})
        </h3>
        <p className="text-[11px] text-gray-500 -mt-2 mb-3">The vendor has marked work completed for today. Acknowledge and choose whether this closes the permit for the day or for good.</p>
        {pendingAck.length === 0 ? <Empty text="No completions awaiting acknowledgment." /> : (
          <div className="grid md:grid-cols-2 gap-4">
            {pendingAck.map((permit) => (
              <PermitGateCard key={permit.id} permit={permit}>
                <button onClick={() => setAckPermit(permit)} className="w-full flex items-center justify-center gap-1.5 bg-teal-600 hover:bg-teal-700 text-white text-[11px] uppercase tracking-widest font-semibold py-3 px-4 rounded">
                  <ThumbsUp className="h-4 w-4" /> Acknowledge Completion
                </button>
              </PermitGateCard>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-bold uppercase text-edition-black tracking-widest mb-3 border-b border-edition-gold/10 pb-1.5">
          Section 9 · Active Crews — Manual Cessation Override ({activeWork.length})
        </h3>
        <p className="text-[11px] text-gray-500 -mt-2 mb-3">Normally the vendor marks work completed themselves. Use this only if Engineering needs to close it on their behalf.</p>
        {activeWork.length === 0 ? <Empty text="No active vendor crews on site." /> : (
          <div className="grid md:grid-cols-2 gap-4">
            {activeWork.map((permit) => (
              <PermitGateCard key={permit.id} permit={permit}>
                <div className="flex gap-2">
                  <button onClick={() => openModal('form11', permit)} className="flex-1 bg-white border border-edition-gold text-edition-black text-[11px] uppercase tracking-wider py-2.5 rounded">Form 11</button>
                  <button onClick={() => setSection9Permit(permit)} className="flex-1 bg-edition-black hover:bg-edition-charcoal text-white text-[11px] uppercase tracking-widest font-semibold py-2.5 rounded border border-edition-gold">Cessation (Sec. 9)</button>
                </div>
              </PermitGateCard>
            ))}
          </div>
        )}
      </div>

      {section8Permit && <SupervisorSection8Modal permit={section8Permit} onClose={() => setSection8Permit(null)} />}
      {section9Permit && <ContractorSection9Modal permit={section9Permit} onClose={() => setSection9Permit(null)} />}
      {ackPermit && <CompletionAckModal permit={ackPermit} onClose={() => setAckPermit(null)} />}
    </div>
  );
}

function CompletionAckModal({ permit, onClose }) {
  const [ackBy, setAckBy] = useState('');
  const [notes, setNotes] = useState('');
  const isLastDay = todayIso() >= permit.endDate;
  const { done, total } = dayProgress(permit);

  const choose = async (closureMode) => {
    if (!ackBy) { alert('Enter the acknowledging engineer\'s name.'); return; }
    await acknowledgeCompletion(permit.id, closureMode, ackBy, notes);
    await logAuditEvent({
      permitId: permit.id,
      eventType: 'completion_acknowledged',
      message: `Engineering acknowledged completion for ${permit.permitRef} — ${closureMode === 'series' ? 'closing the series (final)' : 'closing the day, permit remains valid'}.`,
      actor: ackBy,
    });
    onClose();
  };

  return (
    <ModalShell title="Acknowledge Work Completion" subtitle={`Permit ${permit.permitRef} — ${permit.companyName} — Day ${done + 1} of ${total}`} onClose={onClose}>
      <Field label="Acknowledged By *">
        <input value={ackBy} onChange={(e) => setAckBy(e.target.value)} className={inputCls} placeholder="Engineering supervisor name" />
      </Field>
      <Field label="Notes (optional)" className="mt-3">
        <textarea rows="2" value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} placeholder="Area inspected and left safe, etc." />
      </Field>

      <div className="grid grid-cols-1 gap-3 mt-5">
        <button onClick={() => choose('day')} disabled={isLastDay}
          className="w-full text-left bg-blue-50 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed border border-blue-300 text-blue-900 rounded p-3">
          <span className="block text-xs font-bold uppercase tracking-wider">Close the Day</span>
          <span className="block text-[11px] mt-0.5">Permit stays valid through {permit.endDate}. Security can resume check-in tomorrow with no new approval.{isLastDay ? ' (Unavailable — today is the last scheduled day.)' : ''}</span>
        </button>
        <button onClick={() => choose('series')}
          className="w-full text-left bg-red-50 hover:bg-red-100 border border-red-300 text-red-900 rounded p-3">
          <span className="block text-xs font-bold uppercase tracking-wider">Close the Series (Final)</span>
          <span className="block text-[11px] mt-0.5">The permit ends for good once Security checks the crew out.</span>
        </button>
      </div>
    </ModalShell>
  );
}

function ModalShell({ title, subtitle, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className={`bg-white border border-edition-gold rounded shadow-2xl relative max-h-[90vh] overflow-y-auto ${wide ? 'max-w-3xl w-full' : 'max-w-md w-full'}`}>
        <div className="sticky top-0 bg-white border-b border-edition-gold/15 p-5 flex justify-between items-start z-10">
          <div>
            <h3 className="text-lg font-bold uppercase tracking-wider text-edition-black">{title}</h3>
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-edition-black"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function SupervisorSection8Modal({ permit, onClose }) {
  const [supervisorName, setSupervisorName] = useState('');
  const [notes, setNotes] = useState('');
  const [signatureData, setSignatureData] = useState('');
  const isHighRisk = permit.riskLevel === 'High';
  const [hccApproved, setHccApproved] = useState(permit.hccApproval?.approved || false);
  const [hccManagerName, setHccManagerName] = useState(permit.hccApproval?.approvedBy || '');
  const [hccNotes, setHccNotes] = useState('');

  const authorize = async () => {
    if (!supervisorName) { alert('Enter the authorizing supervisor name.'); return; }
    if (isHighRisk && !hccApproved) { alert('This is a High-Risk permit — HCC Manager approval is required before Section 8 authorization.'); return; }
    if (isHighRisk && !hccManagerName) { alert('Enter the HCC Manager\'s name.'); return; }

    const patch = {
      departmentReceipt: { authorized: true, supervisorName, authorizedAt: new Date().toISOString().replace('T', ' ').slice(0, 16), notes, signatureDataUrl: signatureData },
      status: 'pending_checkin',
    };
    if (isHighRisk) {
      patch.hccApproval = { required: true, approved: true, approvedBy: hccManagerName, approvedAt: new Date().toISOString().replace('T', ' ').slice(0, 16), notes: hccNotes };
    }
    await updatePermit(permit.id, patch);
    await logAuditEvent({ permitId: permit.id, eventType: 'section8_authorized', message: `Section 8 receipt authorized for ${permit.permitRef}.${isHighRisk ? ` HCC approved by ${hccManagerName}.` : ''}${notes ? ' Note: ' + notes : ''}`, actor: supervisorName });
    fireConfetti();
    onClose();
  };

  return (
    <ModalShell title="Section 8 · Department Receipt Authorization" subtitle={`Permit ${permit.permitRef} — ${permit.companyName}`} onClose={onClose}>
      <div className="bg-edition-cream/50 rounded p-3 text-xs space-y-1 mb-4 border border-edition-gold/10">
        <Row label="Location" value={permit.workLocation} />
        <Row label="Crew Size" value={`${crewSizeOf(permit)} Workers`} />
        <Row label="Validity" value={`${permit.startDate} to ${permit.endDate}`} />
        <Row label="Daily Hours" value={`${permit.startTime} - ${permit.endTime}`} />
      </div>

      {isHighRisk && (
        <div className="bg-red-50 border border-red-300 text-red-800 rounded p-3 text-xs mb-4">
          <p className="font-bold uppercase tracking-wide flex items-center gap-1.5 mb-1"><ShieldAlert className="h-4 w-4" /> High-Risk Permit — HCC Approval Required</p>
          <p className="mb-2">The vendor was instructed to email their Risk Assessment and Method Statement to {HCC_MANAGER_EMAIL}. Confirm the HCC Manager has reviewed and approved before authorizing.</p>
          <Field label="HCC Manager Name *">
            <input value={hccManagerName} onChange={(e) => setHccManagerName(e.target.value)} className={inputCls} placeholder="e.g. Fatima Al Suwaidi (HCC Manager)" />
          </Field>
          <Field label="HCC Notes (optional)" className="mt-2">
            <input value={hccNotes} onChange={(e) => setHccNotes(e.target.value)} className={inputCls} placeholder="e.g. Reviewed rigging plan, approved with conditions" />
          </Field>
          <label className="flex items-center gap-2 mt-2 text-xs font-semibold">
            <input type="checkbox" checked={hccApproved} onChange={(e) => setHccApproved(e.target.checked)} />
            HCC Manager has reviewed and approved this permit's risk documentation.
          </label>
        </div>
      )}

      <Field label="Supervisor Name *">
        <input value={supervisorName} onChange={(e) => setSupervisorName(e.target.value)} className={inputCls} placeholder="e.g. Hamdan Al Zaabi (Director of Engineering)" />
      </Field>
      <Field label="Conditions / Notes" className="mt-3">
        <textarea rows="2" value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} placeholder="e.g. Fire watch mandatory, work must cease before dinner service..." />
      </Field>
      <SignaturePad label="Supervisor Signature" onChange={setSignatureData} className="mt-3" />
      <button onClick={authorize} disabled={isHighRisk && !hccApproved}
        className="w-full mt-4 bg-edition-gold hover:bg-edition-darkGold disabled:opacity-40 disabled:cursor-not-allowed text-edition-black font-bold text-xs uppercase tracking-widest py-3 rounded border border-edition-gold">
        Authorize Receipt &amp; Release to Gate 3
      </button>
    </ModalShell>
  );
}

function ContractorSection9Modal({ permit, onClose }) {
  const [signedBy, setSignedBy] = useState('');
  const [notes, setNotes] = useState('');
  const [signatureData, setSignatureData] = useState('');

  const submit = async () => {
    if (!signedBy) { alert('Enter who is certifying work cessation.'); return; }
    await submitWorkCessation(permit.id, { signedBy, notes, signatureDataUrl: signatureData });
    await logAuditEvent({ permitId: permit.id, eventType: 'section9_cessation', message: `Section 9 cessation of work filed for ${permit.permitRef}. Crew withdrawal certified.`, actor: signedBy });
    onClose();
  };

  return (
    <ModalShell title="Section 9 · Cessation of Work" subtitle={`Permit ${permit.permitRef} — ${permit.companyName}`} onClose={onClose}>
      <p className="text-xs text-gray-600 mb-4">Certifies job handover, safe area handover, and withdrawal of the authorized crew from site. This releases the permit to Gate 3 for final check-out.</p>
      <Field label="Certified By *">
        <input value={signedBy} onChange={(e) => setSignedBy(e.target.value)} className={inputCls} placeholder="Supervisor or contractor representative" />
      </Field>
      <Field label="Handover Notes" className="mt-3">
        <textarea rows="2" value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} placeholder="Area left clean and safe, tools removed, etc." />
      </Field>
      <SignaturePad label="Signature" onChange={setSignatureData} className="mt-3" />
      <button onClick={submit} className="w-full mt-4 bg-edition-black hover:bg-edition-charcoal text-white font-bold text-xs uppercase tracking-widest py-3 rounded border border-edition-gold">
        Certify Cessation &amp; Send to Gate 3
      </button>
    </ModalShell>
  );
}

function DepartmentSection10Modal({ permit, onClose }) {
  const [signedBy, setSignedBy] = useState('');
  const [signatureData, setSignatureData] = useState('');

  const finalize = async () => {
    if (!signedBy) { alert('Enter the closing department representative.'); return; }
    await finalizePermitCancellation(permit.id, { signedBy, signatureDataUrl: signatureData });
    await logAuditEvent({ permitId: permit.id, eventType: 'section10_closed', message: `Section 10 formal closure recorded for ${permit.permitRef}.`, actor: signedBy });
    onClose();
  };

  return (
    <ModalShell title="Section 10 · Formal Closure" subtitle={`Permit ${permit.permitRef} — ${permit.companyName}`} onClose={onClose}>
      <p className="text-xs text-gray-600 mb-4">Responsible department sign-off that formally closes this permit record.</p>
      <Field label="Closed By *">
        <input value={signedBy} onChange={(e) => setSignedBy(e.target.value)} className={inputCls} placeholder="Responsible department representative" />
      </Field>
      <SignaturePad label="Signature" onChange={setSignatureData} className="mt-3" />
      <button onClick={finalize} className="w-full mt-4 bg-red-700 hover:bg-red-800 text-white font-bold text-xs uppercase tracking-widest py-3 rounded">
        Finalize Closure
      </button>
    </ModalShell>
  );
}

// ----------------------------------------------------
// ADMIN DASHBOARD — EHS Manpower & Working Hours Analytics Hub
// ----------------------------------------------------
const WINDOWS = [
  { id: 'today', label: 'Today (24h)', days: 1 },
  { id: '3d', label: '3 Days', days: 3 },
  { id: '5d', label: '5 Days', days: 5 },
  { id: '6d', label: '6 Days', days: 6 },
  { id: '7d', label: '7 Days (1 Wk)', days: 7 },
  { id: 'all', label: 'All Time', days: null },
];

function AdminDashboardView({ permits, auditLogs, totalOnSiteHeadcount, openModal }) {
  const [windowId, setWindowId] = useState('7d');
  const [searchTerm, setSearchTerm] = useState('');
  const [section10Permit, setSection10Permit] = useState(null);

  const windowDef = WINDOWS.find((w) => w.id === windowId);
  const cutoff = windowDef.days ? new Date(Date.now() - (windowDef.days - 1) * 86400000) : null;
  const cutoffIso = cutoff ? cutoff.toISOString().split('T')[0] : null;

  const daysInWindow = (permit) => {
    if (!windowDef.days) return permit.dailySchedule?.length || permit.durationDays || 1;
    return (permit.dailySchedule || []).filter((d) => d.date >= cutoffIso).length;
  };

  const zoneStats = useMemo(() => {
    const byZone = {};
    HOTEL_LOCATIONS.forEach((l) => { byZone[l.name] = { zone: l.name, riskLevel: l.riskLevel, permitsIssued: 0, workers: 0, manHours: 0 }; });
    permits.forEach((p) => {
      const zone = byZone[p.workLocation] || (byZone[p.workLocation] = { zone: p.workLocation, riskLevel: p.riskLevel, permitsIssued: 0, workers: 0, manHours: 0 });
      const days = daysInWindow(p);
      if (days <= 0) return;
      zone.permitsIssued += 1;
      zone.workers += crewSizeOf(p);
      zone.manHours += crewSizeOf(p) * days * hoursBetween(p.startTime, p.endTime);
    });
    return Object.values(byZone).filter((z) => z.permitsIssued > 0).sort((a, b) => b.manHours - a.manHours);
  }, [permits, windowId]);

  const maxManHours = Math.max(1, ...zoneStats.map((z) => z.manHours));

  const durationDistribution = useMemo(() => {
    const dist = {};
    permits.forEach((p) => { dist[p.durationDays] = (dist[p.durationDays] || 0) + 1; });
    return Object.entries(dist).map(([days, count]) => ({ days: Number(days), count })).sort((a, b) => a.days - b.days);
  }, [permits]);
  const maxDistCount = Math.max(1, ...durationDistribution.map((d) => d.count));

  const leaderboard = useMemo(() => {
    const byCompany = {};
    permits.forEach((p) => {
      const c = byCompany[p.companyName] || (byCompany[p.companyName] = { company: p.companyName, permits: 0, headcount: 0, manHours: 0 });
      c.permits += 1;
      c.headcount += crewSizeOf(p);
      c.manHours += crewSizeOf(p) * (p.dailySchedule?.length || p.durationDays || 1) * hoursBetween(p.startTime, p.endTime);
    });
    return Object.values(byCompany).sort((a, b) => b.manHours - a.manHours).slice(0, 8);
  }, [permits]);

  const filteredPermits = permits.filter((p) =>
    p.companyName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.workLocation?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.permitRef?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const closeablePermits = permits.filter((p) => p.status === 'completed');

  return (
    <div className="space-y-6">
      <div className="bg-white border border-edition-gold rounded-lg shadow-lg p-5 md:p-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-edition-gold/15 pb-6 mb-6">
          <div>
            <h2 className="text-xl font-bold tracking-wider text-edition-black uppercase flex items-center gap-2">
              <BarChart3 className="h-6 w-6 text-edition-gold" /> EHS Manpower &amp; Working Hours Analytics
            </h2>
            <p className="text-xs text-gray-500 mt-1 uppercase tracking-wider">TADE-OSHMS-Form 11 compliance overview</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => openModal('masterReport')} className="flex items-center gap-1.5 bg-edition-black text-white text-[11px] uppercase tracking-wider px-3 py-2 rounded border border-edition-gold"><FileText className="h-3.5 w-3.5 text-edition-gold" /> PDF Master Report</button>
            <button onClick={() => openModal('emailBackup')} className="flex items-center gap-1.5 bg-white text-edition-black text-[11px] uppercase tracking-wider px-3 py-2 rounded border border-edition-gold/40"><Mail className="h-3.5 w-3.5" /> Email Backup</button>
            <button onClick={() => openModal('evacuation')} className="flex items-center gap-1.5 bg-red-700 text-white text-[11px] uppercase tracking-wider px-3 py-2 rounded"><Siren className="h-3.5 w-3.5" /> Emergency Muster</button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-6">
          <Metric label="Live Headcount" value={totalOnSiteHeadcount} dark />
          <Metric label="Active Crews" value={permits.filter((p) => p.status === 'active').length} />
          <Metric label="Pending Receipt" value={permits.filter((p) => p.status === 'pending_receipt').length} />
          <Metric label="Awaiting Gate-In" value={permits.filter((p) => p.status === 'pending_checkin').length} />
          <Metric label="Awaiting Closure" value={closeablePermits.length} />
          <Metric label="Total Permits" value={permits.length} />
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          {WINDOWS.map((w) => (
            <button key={w.id} onClick={() => setWindowId(w.id)}
              className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider border rounded ${windowId === w.id ? 'bg-edition-gold text-edition-black border-edition-gold' : 'bg-edition-cream text-edition-black border-edition-gold/20'}`}>
              {w.label}
            </button>
          ))}
        </div>

        <div className="grid md:grid-cols-2 gap-6 mb-6">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-widest text-edition-black mb-2">Site-by-Site Breakdown ({windowDef.label})</h3>
            <div className="border border-edition-gold/20 rounded overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-edition-cream uppercase text-[9px] text-gray-500">
                  <tr><th className="px-3 py-2 text-left">Zone</th><th className="px-3 py-2 text-right">Permits</th><th className="px-3 py-2 text-right">Workers</th><th className="px-3 py-2 text-right">Man-Hours</th></tr>
                </thead>
                <tbody className="divide-y divide-edition-gold/10">
                  {zoneStats.length === 0 ? (
                    <tr><td colSpan="4" className="text-center py-4 text-gray-400 italic">No activity in this window.</td></tr>
                  ) : zoneStats.map((z) => (
                    <tr key={z.zone}>
                      <td className="px-3 py-2">
                        <div className="font-semibold">{z.zone}</div>
                        <div className="w-full bg-gray-100 h-1 rounded-full mt-1 overflow-hidden"><div className="bg-edition-gold h-full" style={{ width: `${(z.manHours / maxManHours) * 100}%` }} /></div>
                      </td>
                      <td className="px-3 py-2 text-right font-bold">{z.permitsIssued}</td>
                      <td className="px-3 py-2 text-right">{z.workers}</td>
                      <td className="px-3 py-2 text-right font-bold">{z.manHours.toFixed(1)}h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-bold uppercase tracking-widest text-edition-black mb-2">Permit Duration Distribution</h3>
            <div className="space-y-1.5">
              {durationDistribution.map((d) => (
                <div key={d.days} className="flex items-center gap-2 text-xs">
                  <span className="w-12 font-semibold shrink-0">{d.days}d</span>
                  <div className="flex-grow bg-gray-100 h-4 rounded overflow-hidden"><div className="bg-edition-darkGold h-full" style={{ width: `${(d.count / maxDistCount) * 100}%` }} /></div>
                  <span className="w-6 text-right shrink-0 font-bold">{d.count}</span>
                </div>
              ))}
            </div>

            <h3 className="text-xs font-bold uppercase tracking-widest text-edition-black mb-2 mt-5 flex items-center gap-1.5"><Award className="h-3.5 w-3.5 text-edition-gold" /> Contractor Leaderboard</h3>
            <div className="space-y-1.5">
              {leaderboard.map((c, i) => (
                <div key={c.company} className="flex items-center justify-between bg-edition-cream/50 border border-edition-gold/10 rounded px-2.5 py-1.5 text-xs">
                  <span className="font-semibold">#{i + 1} {c.company}</span>
                  <span className="text-gray-500">{c.headcount} workers &bull; {c.manHours.toFixed(0)}h</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="relative max-w-sm w-full mb-4">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <input type="text" placeholder="Search ref, company or location..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-edition-cream border border-edition-gold/30 rounded pl-9 pr-4 py-2 text-xs focus:outline-none focus:border-edition-gold text-edition-black" />
        </div>

        <div className="overflow-x-auto border border-edition-gold/20 rounded">
          <table className="min-w-full divide-y divide-edition-gold/15 text-sm text-left">
            <thead className="bg-edition-cream uppercase text-[10px] text-gray-500 tracking-wider">
              <tr>
                <th className="px-4 py-3 font-semibold">Ref</th>
                <th className="px-4 py-3 font-semibold">Company &amp; Location</th>
                <th className="px-4 py-3 font-semibold">Validity</th>
                <th className="px-4 py-3 font-semibold">Crew</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edition-gold/10 text-edition-black">
              {filteredPermits.length === 0 ? (
                <tr><td colSpan="6" className="text-center py-8 text-gray-400 text-xs uppercase tracking-wider">No records matching search query.</td></tr>
              ) : filteredPermits.map((p) => (
                <tr key={p.id} className="hover:bg-edition-cream/30">
                  <td className="px-4 py-3 font-bold">{p.permitRef}</td>
                  <td className="px-4 py-3"><div className="font-semibold">{p.companyName}</div><div className="text-[11px] text-gray-500">{p.workLocation}</div></td>
                  <td className="px-4 py-3 text-xs">{p.startDate} → {p.endDate}</td>
                  <td className="px-4 py-3 text-xs font-bold">{crewSizeOf(p)}</td>
                  <td className="px-4 py-3"><span className={`border px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${statusBadgeClass(p.status)}`}>{statusLabel(p.status)}</span></td>
                  <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                    <button onClick={() => openModal('form11', p)} className="text-[10px] uppercase font-semibold text-edition-darkGold hover:underline">Form 11</button>
                    {p.status === 'completed' && <button onClick={() => setSection10Permit(p)} className="text-[10px] uppercase font-semibold text-red-600 hover:underline">Close (Sec.10)</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white border border-edition-gold rounded-lg shadow-lg p-5 md:p-8">
        <h3 className="text-xs font-bold uppercase tracking-widest text-edition-black mb-3 flex items-center gap-1.5"><ClipboardList className="h-4 w-4 text-edition-gold" /> Audit Trail</h3>
        <div className="space-y-1.5 max-h-64 overflow-y-auto">
          {auditLogs.length === 0 ? <Empty text="No audit events logged yet." /> : auditLogs.map((log) => (
            <div key={log.id} className="flex items-start gap-2 text-xs border-b border-edition-gold/5 pb-1.5">
              <ChevronRight className="h-3.5 w-3.5 text-edition-gold shrink-0 mt-0.5" />
              <div><span className="text-gray-400 font-mono mr-2">{log.createdAt}</span>{log.message}{log.actor && <span className="text-gray-400"> — {log.actor}</span>}</div>
            </div>
          ))}
        </div>
      </div>

      {section10Permit && <DepartmentSection10Modal permit={section10Permit} onClose={() => setSection10Permit(null)} />}
    </div>
  );
}

function Metric({ label, value, dark }) {
  return (
    <div className={`border p-3 rounded text-center ${dark ? 'bg-edition-950 border-edition-gold text-white' : 'bg-edition-cream border-edition-gold/15 text-edition-black'}`}>
      <span className={`text-[9px] uppercase tracking-widest font-bold block mb-1 ${dark ? 'text-edition-gold' : 'text-gray-500'}`}>{label}</span>
      <span className="text-2xl font-extrabold">{value}</span>
    </div>
  );
}

// ----------------------------------------------------
// FORM 11 OFFICIAL DOCUMENT MODAL (printable)
// ----------------------------------------------------
function Form11OfficialDocumentModal({ permit, onClose }) {
  if (!permit) return null;
  return (
    <ModalShell title={`Form 11 — Permit ${permit.permitRef}`} subtitle="Official printable document" onClose={onClose} wide>
      <div id="print-root" className="text-xs text-edition-black space-y-4">
        <div className="text-center border-b border-edition-gold/20 pb-3">
          <h2 className="font-display text-2xl font-bold uppercase">The Abu Dhabi EDITION</h2>
          <p className="uppercase tracking-widest text-[10px] text-gray-500">{permit.formRef} (Rev {permit.revisionNo}, {permit.releaseDate})</p>
          <p className="font-bold mt-1">General Work Permit — {permit.permitRef}</p>
        </div>

        <DocSection title="Sections 1-3 · Particulars">
          <DocRow label="Company" value={permit.companyName} />
          <DocRow label="Mobile" value={permit.mobileNo} />
          <DocRow label="Location" value={permit.workLocation} />
          <DocRow label="Validity" value={`${permit.startDate} to ${permit.endDate} (${permit.durationDays} days)`} />
          <DocRow label="Daily Hours" value={`${permit.startTime} - ${permit.endTime}`} />
          <DocRow label="Risk Level" value={permit.riskLevel} />
          <DocRow label="Description" value={permit.descriptionOfWork} />
        </DocSection>

        <DocSection title="Section 4 · Permit To Work">
          <DocRow label="Hot Work" value={permit.permitToWork?.hotWork ? 'YES' : 'NO'} />
          <DocRow label="Working at Heights" value={permit.permitToWork?.workingAtHeights ? 'YES' : 'NO'} />
          <DocRow label="Confined Space" value={permit.permitToWork?.confinedSpace ? 'YES' : 'NO'} />
        </DocSection>

        <DocSection title="Section 5 · Documentation Verification">
          <DocRow label="Method Statement" value={permit.documents?.methodStatement} />
          <DocRow label="Safety Instruction" value={permit.documents?.safetyInstruction} />
          <DocRow label="Risk Assessment" value={permit.documents?.riskAssessment} />
          <DocRow label="Insurance Document" value={permit.documents?.insuranceDocument} />
        </DocSection>

        <DocSection title="Authorized Personnel Roster & Emirates ID Register">
          <table className="w-full text-[10px] border border-edition-gold/20">
            <thead className="bg-edition-cream"><tr><th className="p-1.5 text-left">Name</th><th className="p-1.5 text-left">Emirates ID</th><th className="p-1.5 text-left">Trade</th><th className="p-1.5 text-left">Badge</th></tr></thead>
            <tbody>
              {permit.workers?.map((w) => (
                <tr key={w.id} className="border-t border-edition-gold/10"><td className="p-1.5">{w.name}</td><td className="p-1.5">{w.emiratesId}</td><td className="p-1.5">{w.trade}</td><td className="p-1.5">{w.badgeNo || '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </DocSection>

        <DocSection title="Section 7 · Contractor Confirmation">
          <DocRow label="Representative" value={permit.contractorConfirmation?.representativeName} />
          <DocRow label="Signed At" value={permit.contractorConfirmation?.signedAt} />
        </DocSection>

        <DocSection title="Section 8 · Department Receipt">
          <DocRow label="Supervisor" value={permit.departmentReceipt?.supervisorName || 'Pending'} />
          <DocRow label="Authorized At" value={permit.departmentReceipt?.authorizedAt || '—'} />
          <DocRow label="Notes" value={permit.departmentReceipt?.notes || '—'} />
        </DocSection>

        <DocSection title="Section 9 · Cessation of Work">
          <DocRow label="Completed" value={permit.cessationOfWork?.isCompleted ? 'YES' : 'NO'} />
          <DocRow label="Signed By" value={permit.cessationOfWork?.signedBy || '—'} />
        </DocSection>

        <DocSection title="Section 10 · Cancellation & Closure">
          <DocRow label="Closed" value={permit.cancellation?.isCancelled ? 'YES' : 'NO'} />
          <DocRow label="Signed By" value={permit.cancellation?.signedBy || '—'} />
        </DocSection>
      </div>
      <div className="no-print mt-5">
        <button onClick={() => window.print()} className="w-full flex items-center justify-center gap-1.5 bg-edition-black text-white text-xs uppercase tracking-widest py-3 rounded border border-edition-gold">
          <Printer className="h-4 w-4 text-edition-gold" /> Print Official Document
        </button>
      </div>
    </ModalShell>
  );
}

function DocSection({ title, children }) {
  return (
    <div className="border-t border-edition-gold/10 pt-2">
      <p className="font-bold uppercase text-[10px] tracking-widest text-edition-darkGold mb-1">{title}</p>
      {children}
    </div>
  );
}
function DocRow({ label, value }) {
  return <div className="flex justify-between border-b border-dotted border-gray-200 py-0.5"><span className="text-gray-500">{label}</span><span className="font-medium text-right max-w-[70%]">{value ?? '—'}</span></div>;
}

// ----------------------------------------------------
// MASTER COMPLIANCE REPORT — jsPDF export
// ----------------------------------------------------
function MasterComplianceReportModal({ permits, onClose }) {
  const generate = () => {
    const doc = new jsPDF();
    let y = 18;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
    doc.text('The Abu Dhabi EDITION — Master Compliance Report', 14, y);
    y += 6;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(`TADE-OSHMS-Form 11 · Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, 14, y);
    y += 10;

    const totalWorkers = permits.reduce((s, p) => s + crewSizeOf(p), 0);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.text(`Executive Summary: ${permits.length} permits on record · ${totalWorkers} total worker-registrations · ${permits.filter(p => p.status === 'active').length} active on site`, 14, y);
    y += 8;

    doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.text('Ref', 14, y); doc.text('Company', 32, y); doc.text('Location', 90, y); doc.text('Crew', 150, y); doc.text('Status', 165, y);
    y += 2; doc.line(14, y, 196, y); y += 5;

    doc.setFont('helvetica', 'normal');
    permits.forEach((p) => {
      if (y > 280) { doc.addPage(); y = 18; }
      doc.text(String(p.permitRef || p.id.slice(0, 6)), 14, y);
      doc.text(String(p.companyName || '').slice(0, 28), 32, y);
      doc.text(String(p.workLocation || '').slice(0, 32), 90, y);
      doc.text(String(crewSizeOf(p)), 150, y);
      doc.text(String(statusLabel(p.status)).slice(0, 20), 165, y);
      y += 6;
    });

    y += 10;
    if (y > 260) { doc.addPage(); y = 18; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text('Sign-Off', 14, y); y += 8;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text('EHS Compliance Manager: ______________________     Date: ____________', 14, y); y += 8;
    doc.text('Director of Engineering: ______________________     Date: ____________', 14, y);

    doc.save(`permit-pro-master-report-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  return (
    <ModalShell title="Executive PDF Master Record" subtitle={`${permits.length} permits will be included`} onClose={onClose}>
      <p className="text-xs text-gray-600 mb-4">Generates a print-ready compliance report covering every permit on record, with an executive summary and formal sign-off block. The file downloads directly to your device.</p>
      <button onClick={generate} className="w-full flex items-center justify-center gap-1.5 bg-edition-black text-white text-xs uppercase tracking-widest py-3 rounded border border-edition-gold">
        <FileText className="h-4 w-4 text-edition-gold" /> Generate &amp; Download PDF
      </button>
    </ModalShell>
  );
}

// ----------------------------------------------------
// EMAIL BACKUP MODAL — simulated dispatch (no live email backend wired up)
// ----------------------------------------------------
function EmailBackupModal({ permit, onClose }) {
  const [recipients, setRecipients] = useState('ehs.compliance@editionhotels.com, director.engineering@editionhotels.com, gate3.security@editionhotels.com');
  const [reportType, setReportType] = useState('master_report');
  const [sent, setSent] = useState(false);

  const dispatch = async () => {
    await logAuditEvent({
      permitId: permit?.id ?? null,
      eventType: 'email_backup_dispatched',
      message: `Email backup dispatch logged for ${reportType.replace('_', ' ')} to: ${recipients}`,
      actor: 'Admin Dashboard',
    });
    setSent(true);
  };

  return (
    <ModalShell title="Automated Email Backup" subtitle={permit ? `Permit ${permit.permitRef}` : 'All records'} onClose={onClose}>
      <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded p-3 text-[11px] mb-4">
        No email service is connected yet — this logs the dispatch to the audit trail but does not send a real email. Wire up an email provider (e.g. Resend, SendGrid) to make this live.
      </div>
      <Field label="Recipients">
        <textarea rows="2" value={recipients} onChange={(e) => setRecipients(e.target.value)} className={inputCls} />
      </Field>
      <Field label="Report Type" className="mt-3">
        <select value={reportType} onChange={(e) => setReportType(e.target.value)} className={inputCls}>
          <option value="master_report">Master Compliance Report (PDF)</option>
          <option value="single_permit">Single Permit — Form 11</option>
          <option value="analytics_snapshot">EHS Analytics Snapshot</option>
        </select>
      </Field>
      {sent ? (
        <div className="mt-4 bg-green-50 border border-green-200 text-green-800 rounded p-3 text-xs flex items-center gap-1.5"><CheckCircle className="h-4 w-4" /> Dispatch logged to audit trail.</div>
      ) : (
        <button onClick={dispatch} className="w-full mt-4 flex items-center justify-center gap-1.5 bg-edition-black text-white text-xs uppercase tracking-widest py-3 rounded border border-edition-gold">
          <Mail className="h-4 w-4 text-edition-gold" /> Log Backup Dispatch
        </button>
      )}
    </ModalShell>
  );
}

// ----------------------------------------------------
// EMERGENCY EVACUATION MODAL — live roll-call muster
// ----------------------------------------------------
function EmergencyEvacuationModal({ permits, onClose }) {
  const [accounted, setAccounted] = useState({});

  const onSiteWorkers = useMemo(() => {
    const list = [];
    permits.filter((p) => p.status === 'active').forEach((p) => {
      (p.workers || []).filter((w) => w.isCheckedIn).forEach((w) => {
        list.push({ ...w, location: p.workLocation, company: p.companyName, permitRef: p.permitRef });
      });
    });
    return list;
  }, [permits]);

  const toggleAccounted = (id) => setAccounted((prev) => ({ ...prev, [id]: !prev[id] }));
  const accountedCount = onSiteWorkers.filter((w) => accounted[w.id]).length;

  return (
    <ModalShell title="Emergency Evacuation — Live Roll-Call Muster" subtitle={`${onSiteWorkers.length} personnel on site`} onClose={onClose} wide>
      <div className="flex items-center justify-between mb-4 bg-red-50 border border-red-200 rounded p-3">
        <span className="text-sm font-bold text-red-800">Accounted For: {accountedCount} / {onSiteWorkers.length}</span>
        <Siren className="h-5 w-5 text-red-600" />
      </div>
      {onSiteWorkers.length === 0 ? <Empty text="No personnel currently checked in on site." /> : (
        <div className="space-y-1.5 max-h-96 overflow-y-auto">
          {onSiteWorkers.map((w) => (
            <div key={w.id} className={`flex items-center justify-between border rounded px-3 py-2 text-xs ${accounted[w.id] ? 'bg-green-50 border-green-200' : 'bg-white border-edition-gold/15'}`}>
              <div>
                <span className="font-bold">{w.name}</span>
                <span className="text-gray-400 ml-2">{w.company} &bull; {w.location}</span>
              </div>
              <button onClick={() => toggleAccounted(w.id)} className={`text-[9px] font-bold uppercase px-2.5 py-1 rounded ${accounted[w.id] ? 'bg-green-600 text-white' : 'bg-gray-200 text-gray-600'}`}>
                {accounted[w.id] ? 'Accounted' : 'Mark Safe'}
              </button>
            </div>
          ))}
        </div>
      )}
    </ModalShell>
  );
}

export default App;
