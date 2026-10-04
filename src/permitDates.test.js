import test from 'node:test';
import assert from 'node:assert/strict';
import { todayIso, addDaysIso, dateValidity, permitDateLabel } from './permitDates.js';

// Abu Dhabi is UTC+4, so GST wall-clock time = UTC + 4h.
const gst = (iso, hhmm) => new Date(`${iso}T${hhmm}:00+04:00`);

const dayPermit = { startDate: '2026-10-05', endDate: '2026-10-05', startTime: '10:00', endTime: '17:00' };
const nightPermit = { startDate: '2026-10-05', endDate: '2026-10-05', startTime: '18:00', endTime: '06:00' };

test('todayIso uses Abu Dhabi time, not the device/UTC date', () => {
  // 01:00 on Oct 6 in Abu Dhabi is still Oct 5 in UTC — must read as Oct 6.
  assert.equal(todayIso(gst('2026-10-06', '01:00')), '2026-10-06');
  assert.equal(todayIso(gst('2026-10-05', '23:30')), '2026-10-05');
});

test('addDaysIso crosses month and year boundaries', () => {
  assert.equal(addDaysIso('2026-10-31', 1), '2026-11-01');
  assert.equal(addDaysIso('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysIso('2026-10-05', -1), '2026-10-04');
});

test('a day permit is valid on its date only', () => {
  assert.equal(dateValidity(dayPermit, gst('2026-10-04', '12:00')), 'future');
  assert.equal(dateValidity(dayPermit, gst('2026-10-05', '09:00')), 'ok');
  assert.equal(dateValidity(dayPermit, gst('2026-10-05', '23:59')), 'ok');
  assert.equal(dateValidity(dayPermit, gst('2026-10-06', '00:30')), 'expired');
  assert.equal(dateValidity(dayPermit, gst('2026-10-06', '12:00')), 'expired');
  assert.equal(dateValidity(dayPermit, gst('2026-10-20', '12:00')), 'expired');
});

test('a night permit stays valid past midnight until its end time, then expires', () => {
  assert.equal(dateValidity(nightPermit, gst('2026-10-05', '19:00')), 'ok');
  assert.equal(dateValidity(nightPermit, gst('2026-10-06', '03:00')), 'ok');
  assert.equal(dateValidity(nightPermit, gst('2026-10-06', '06:00')), 'ok');
  assert.equal(dateValidity(nightPermit, gst('2026-10-06', '06:01')), 'expired');
  assert.equal(dateValidity(nightPermit, gst('2026-10-07', '03:00')), 'expired');
  assert.equal(dateValidity(nightPermit, gst('2026-10-04', '23:00')), 'future');
});

test('permitDateLabel shows one date (and still reads old multi-day permits)', () => {
  assert.equal(permitDateLabel(dayPermit), '2026-10-05');
  assert.equal(permitDateLabel({ ...dayPermit, endDate: '2026-10-07' }), '2026-10-05 to 2026-10-07');
});
