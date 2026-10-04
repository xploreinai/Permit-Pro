// Date rules for one-day work permits. All "today" logic uses Abu Dhabi time
// (GST, UTC+4) no matter what timezone the device is set to.

// "Today" always means today in Abu Dhabi, whatever timezone the device is set to.
export function todayIso(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDaysIso(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function timeNowGst(now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
}

// A permit is valid for ONE day only. Gate 3 uses this so a permit can't be used
// before its date or after it. A night permit that runs past midnight stays
// valid until its end time the next morning.
export function dateValidity(permit, now = new Date()) {
  const today = todayIso(now);
  if (today < permit.startDate) return 'future';
  if (today === permit.startDate) return 'ok';
  const overnight = permit.endTime <= permit.startTime;
  if (overnight && today === addDaysIso(permit.startDate, 1) && timeNowGst(now) <= permit.endTime) return 'ok';
  return 'expired';
}

export function permitDateLabel(permit) {
  return permit.endDate && permit.endDate !== permit.startDate ? `${permit.startDate} to ${permit.endDate}` : permit.startDate;
}
