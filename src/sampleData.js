// Static reference data for Permit Pro — The Abu Dhabi EDITION.
// TADE-OSHMS-Form 11 (Rev 01, February 2024).

// Sentinel value for the "type your own location" dropdown option.
export const TYPE_LOCATION_VALUE = '__type__';

export const HOTEL_LOCATIONS = [
  { name: 'Ballroom', riskLevel: 'Regular' },
  { name: 'Meeting Rooms', riskLevel: 'Regular' },
  { name: 'Oak Room', riskLevel: 'Regular' },
  { name: 'Market', riskLevel: 'Regular' },
  { name: 'Lobby', riskLevel: 'Regular' },
  { name: 'Guest Room', riskLevel: 'Regular' },
  { name: 'Corridor', riskLevel: 'Regular' },
  { name: 'First Floor', riskLevel: 'Regular' },
  { name: 'Second Floor', riskLevel: 'Regular' },
  { name: 'Third Floor', riskLevel: 'Regular' },
  { name: 'Fourth Floor', riskLevel: 'Regular' },
  { name: 'Fifth Floor', riskLevel: 'Regular' },
  { name: 'Rooftop', riskLevel: 'High' },
  { name: 'Back of House', riskLevel: 'High' },
];

// There are exactly two permit time categories. A Day Permit always runs
// 10:00-17:00 — not editable, no shift picker. A Night Work Permit is kept
// deliberately separate and cannot carry noisy work (Hot Work — welding,
// cutting, grinding); that stays restricted to the Day Permit's 10-5 window.
export const PERMIT_TIME_TYPES = [
  { id: 'day', label: 'Day Permit', hoursLabel: '10:00 AM – 5:00 PM', startTime: '10:00', endTime: '17:00', fixed: true },
  { id: 'night', label: 'Night Work Permit', hoursLabel: 'Custom night hours', startTime: '18:00', endTime: '06:00', fixed: false },
];

export const DURATION_PRESETS = [1, 2, 3, 4, 5, 7];
export const MAX_PERMIT_DAYS = 7;

// PLACEHOLDER — replace with the real HCC Manager's email address.
export const HCC_MANAGER_EMAIL = 'hcc.manager@theeditionhotels.com';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function generateDailySchedule(startDate, endDate, startTime, endTime) {
  if (!startDate || !endDate) return [];
  const schedule = [];
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  let dayNumber = 1;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    schedule.push({
      dayNumber,
      date: d.toISOString().split('T')[0],
      dayName: DAY_NAMES[d.getDay()],
      startTime,
      endTime,
      formattedHours: `${startTime} - ${endTime}`,
    });
    dayNumber += 1;
  }
  return schedule;
}

export function diffDaysInclusive(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  return Math.round((end - start) / 86400000) + 1;
}

// Emirates ID: 784-YYYY-NNNNNNN-C. Expiry is validated separately per worker.
const FAR_FUTURE_EXPIRY = '2030-01-01';

export const CREW_PRESET_6 = {
  id: 'crew_6_welding_hvac',
  label: '6-Worker Crew (Welding & HVAC Team)',
  workers: [
    { name: 'Rashid Mahmood', emiratesId: '784-1988-3482190-1', expiryDate: FAR_FUTURE_EXPIRY, trade: 'Lead Certified TIG Welder (Class 1)', role: 'Team Lead & Welder', phone: '+971 50 842 1928' },
    { name: 'Suresh Kumar', emiratesId: '784-1992-7718294-3', expiryDate: FAR_FUTURE_EXPIRY, trade: 'Senior Mechanical Fitter', role: 'Mechanical Tech', phone: '+971 52 119 4832' },
    { name: 'Bilal Khan', emiratesId: '784-1995-1049281-9', expiryDate: FAR_FUTURE_EXPIRY, trade: 'Certified Fire Watch Sentinel', role: 'Fire Watch Guard', phone: '+971 55 382 9104' },
    { name: 'Farhan Akhtar', emiratesId: '784-1991-6629104-5', expiryDate: FAR_FUTURE_EXPIRY, trade: 'HVAC Duct & Damper Specialist', role: 'HVAC Tech', phone: '+971 50 771 2893' },
    { name: 'Amit Patel', emiratesId: '784-1996-3381902-7', expiryDate: FAR_FUTURE_EXPIRY, trade: 'Electrical & Controls Technician', role: 'Electrical Tech', phone: '+971 54 991 4302' },
    { name: 'Zayd Al Nuaimi', emiratesId: '784-1997-5501984-2', expiryDate: FAR_FUTURE_EXPIRY, trade: 'Safety Assistant & Site Helper', role: 'Assistant', phone: '+971 56 220 8419' },
  ],
};

export const CREW_PRESET_5 = {
  id: 'crew_5_rigger',
  label: '5-Worker Crew (High-Elevation Rigger Team)',
  workers: [
    { name: 'Jean-Luc Bernard', emiratesId: '784-1985-2207713-6', expiryDate: FAR_FUTURE_EXPIRY, trade: 'Project Supervisor / IRATA Level 3', role: 'Supervisor', phone: '+971 50 334 8821' },
    { name: 'Arjun Verma', emiratesId: '784-1993-4471820-2', expiryDate: FAR_FUTURE_EXPIRY, trade: 'IRATA Level 2 Facade Rigger', role: 'Rigger', phone: '+971 52 902 1147' },
    { name: 'Mohammed Zayed', emiratesId: '784-1990-6693281-8', expiryDate: FAR_FUTURE_EXPIRY, trade: 'Certified Scaffold Inspector', role: 'Scaffold Inspector', phone: '+971 55 610 3392' },
    { name: 'Carlos Mendoza', emiratesId: '784-1994-8817402-4', expiryDate: FAR_FUTURE_EXPIRY, trade: 'High-Elevation Structural Welder', role: 'Welder', phone: '+971 54 228 7765' },
    { name: "David O'Connor", emiratesId: '784-1989-1129384-0', expiryDate: FAR_FUTURE_EXPIRY, trade: 'Safety & Fall Arrest Sentinel', role: 'Safety Sentinel', phone: '+971 56 447 9931' },
  ],
};

// Emirates ID validation: format check + expiry check. Used both after OCR
// scanning and for manually-entered workers, so every worker goes through
// the same gate before a permit can be submitted.
const EMIRATES_ID_PATTERN = /^784-\d{4}-\d{7}-\d$/;

export function validateWorkerId(worker) {
  const id = (worker.emiratesId || '').trim();
  if (!id) return { valid: false, reason: 'Emirates ID required' };
  if (!EMIRATES_ID_PATTERN.test(id)) return { valid: false, reason: 'Invalid Emirates ID format' };
  if (worker.expiryDate) {
    const expiry = new Date(`${worker.expiryDate}T23:59:59`);
    if (expiry.getTime() < Date.now()) return { valid: false, reason: 'Emirates ID expired' };
  } else {
    return { valid: false, reason: 'Expiry date required' };
  }
  return { valid: true, reason: '' };
}

export const CREW_PRESETS = [CREW_PRESET_6, CREW_PRESET_5];

function withBadges(workers, startBadge) {
  return workers.map((w, i) => ({
    id: `w-seed-${startBadge + i}`,
    ...w,
    badgeNo: `SEC-${String(startBadge + i).padStart(3, '0')}`,
    isCheckedIn: false,
    checkInTime: null,
    checkOutTime: null,
  }));
}

export const INITIAL_PERMITS = [
  {
    id: 'seed-2026-006',
    permitSeq: 1,
    permitRef: 'PP-000001',
    formRef: 'TADE-OSHMS-Form 11',
    releaseDate: 'February 2024',
    revisionNo: '01',
    startDate: '2026-08-30',
    endDate: '2026-09-02',
    durationDays: 4,
    permitTimeType: 'day',
    startTime: '10:00',
    endTime: '17:00',
    dailySchedule: generateDailySchedule('2026-08-30', '2026-09-02', '10:00', '17:00'),
    companyName: 'Al Futtaim Engineering LLC',
    mobileNo: '+971 50 842 1928',
    workLocation: 'Oak Room',
    descriptionOfWork: 'TIG welding & replacement of secondary exhaust manifold damper section above char-grill line.',
    riskLevel: 'High',
    vehiclePlate: 'Abu Dhabi 5 - 49201',
    permitToWork: { hotWork: true, workingAtHeights: false, confinedSpace: false, others: false, othersText: '' },
    documents: { methodStatement: 'YES', safetyInstruction: 'YES', riskAssessment: 'YES', insuranceDocument: 'YES' },
    safetyPrecautions: {
      barriersErected: true,
      safetySignsAndNotices: true,
      laddersTiedFooted: true,
      ventilateTheArea: true,
      others: '2x 9kg CO2 & Dry Powder fire extinguishers stationed on site.',
    },
    ppe: {
      safetyFootwear: true,
      hardHat: true,
      eyeProtection: true,
      handProtection: true,
      earProtection: true,
      fallArrestSystem: false,
      others: 'Welding fire-resistant gauntlets & face shield.',
    },
    contractorConfirmation: {
      confirmed: true,
      representativeName: 'Tariq Mansoor',
      signedAt: '2026-08-30 08:00',
      signatureDataUrl: '',
    },
    departmentReceipt: {
      authorized: true,
      supervisorName: 'Hamdan Al Zaabi (Director of Engineering)',
      authorizedAt: '2026-08-30 08:30',
      notes: 'Fire watch mandatory with 2x 9kg CO2 extinguishers. Work must cease 30 mins before dinner service at 17:00.',
      signatureDataUrl: '',
    },
    cessationOfWork: { isCompleted: false, signedBy: '', time: '', notes: '', signatureDataUrl: '' },
    cancellation: { isCancelled: false, signedBy: '', date: '', time: '', signatureDataUrl: '' },
    dailyLog: [{ date: '2026-08-30', checkedInAt: '2026-08-30 08:15', checkedOutAt: null }],
    hccApproval: { required: true, approved: true, approvedBy: 'Fatima Al Suwaidi (HCC Manager)', approvedAt: '2026-08-30 08:20', notes: 'Risk assessment received by email and reviewed.' },
    closureMode: null,
    completionAck: {},
    submittedByStaff: '',
    status: 'active',
    idPhotoUrl: '',
    workers: withBadges(CREW_PRESET_6.workers, 41).map((w) => ({
      ...w,
      isCheckedIn: true,
      checkInTime: '2026-08-30 08:15',
    })),
    createdAt: '2026-08-30 08:00',
    lastUpdated: '2026-08-30 08:30',
  },
];

export const INITIAL_AUDIT_LOGS = [
  { id: 'log-1', permitId: 'seed-2026-006', eventType: 'permit_created', message: 'Permit 2026-006 submitted by Al Futtaim Engineering LLC.', actor: 'Tariq Mansoor', createdAt: '2026-08-30 08:00' },
  { id: 'log-2', permitId: 'seed-2026-006', eventType: 'section8_authorized', message: 'Section 8 receipt authorized — fire watch condition attached.', actor: 'Hamdan Al Zaabi', createdAt: '2026-08-30 08:30' },
  { id: 'log-3', permitId: 'seed-2026-006', eventType: 'crew_checked_in', message: '6-worker crew checked in at Gate 3.', actor: 'Security Gate 3', createdAt: '2026-08-30 08:30' },
];
