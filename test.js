/*
 * Test suite for slot-engine.js. Pure Node, no dependencies.
 * Run: node test.js
 */
'use strict';

const assert = require('assert');
const SlotEngine = require('./slot-engine.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push({ name, err });
  }
}

// ---- fixtures ----

function makeWeeklyHours(overrides) {
  const base = [0, 1, 2, 3, 4, 5, 6].map(function () {
    return { closed: false, open: '09:30', close: '19:30' };
  });
  base[0] = { closed: true, open: '09:30', close: '19:30' }; // Sunday closed
  if (overrides) {
    Object.keys(overrides).forEach(function (k) {
      base[Number(k)] = Object.assign({}, base[Number(k)], overrides[k]);
    });
  }
  return base;
}

function makeConfig(overrides) {
  const base = {
    weeklyHours: makeWeeklyHours(),
    bufferMin: 10,
    blocks: [],
    services: [
      { id: 'haircut', name: 'Haircut', durationMin: 30 },
      { id: 'wash-blow', name: 'Wash & Blow-dry', durationMin: 45 },
      { id: 'colour', name: 'Colouring', durationMin: 120 }
    ]
  };
  return Object.assign({}, base, overrides || {});
}

// ---- time / date primitives ----

test('timeToMinutes parses HH:MM', () => {
  assert.strictEqual(SlotEngine.timeToMinutes('00:00'), 0);
  assert.strictEqual(SlotEngine.timeToMinutes('09:30'), 570);
  assert.strictEqual(SlotEngine.timeToMinutes('23:59'), 1439);
});

test('timeToMinutes rejects invalid strings', () => {
  assert.strictEqual(SlotEngine.timeToMinutes('24:00'), null);
  assert.strictEqual(SlotEngine.timeToMinutes('9:30'), null);
  assert.strictEqual(SlotEngine.timeToMinutes('12:60'), null);
  assert.strictEqual(SlotEngine.timeToMinutes('abc'), null);
});

test('minutesToTime round-trips', () => {
  assert.strictEqual(SlotEngine.minutesToTime(570), '09:30');
  assert.strictEqual(SlotEngine.minutesToTime(0), '00:00');
  assert.strictEqual(SlotEngine.minutesToTime(1440), '24:00');
});

test('isValidDateString rejects impossible calendar dates', () => {
  assert.strictEqual(SlotEngine.isValidDateString('2026-02-30'), false);
  assert.strictEqual(SlotEngine.isValidDateString('2026-13-01'), false);
  assert.strictEqual(SlotEngine.isValidDateString('2026-09-27'), true);
});

test('getDayOfWeek matches known weekday', () => {
  // 2026-09-27 is a Sunday.
  assert.strictEqual(SlotEngine.getDayOfWeek('2026-09-27'), 0);
  assert.strictEqual(SlotEngine.getDayOfWeek('2026-09-28'), 1);
});

test('addDays crosses a month boundary', () => {
  assert.strictEqual(SlotEngine.addDays('2026-01-31', 1), '2026-02-01');
  assert.strictEqual(SlotEngine.addDays('2026-09-27', 5), '2026-10-02');
});

test('addDays crosses a year boundary', () => {
  assert.strictEqual(SlotEngine.addDays('2026-12-31', 1), '2027-01-01');
});

test('addDays handles the Feb 29 leap day correctly', () => {
  // 2028 is a leap year.
  assert.strictEqual(SlotEngine.addDays('2028-02-28', 1), '2028-02-29');
  assert.strictEqual(SlotEngine.addDays('2028-02-29', 1), '2028-03-01');
  // 2026 is not a leap year: Feb 28 -> Mar 1 directly.
  assert.strictEqual(SlotEngine.addDays('2026-02-28', 1), '2026-03-01');
});

test('getNextDates returns N consecutive dates starting from the given date', () => {
  const dates = SlotEngine.getNextDates('2026-09-27', 7);
  assert.deepStrictEqual(dates, [
    '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30',
    '2026-10-01', '2026-10-02', '2026-10-03'
  ]);
});

test('getTodayMyt derives the MYT calendar date from a UTC epoch, not host TZ', () => {
  // 2026-09-27T16:30:00Z = 2026-09-28T00:30 MYT -> next calendar day in MYT.
  const epoch = Date.UTC(2026, 8, 27, 16, 30, 0);
  assert.strictEqual(SlotEngine.getTodayMyt(epoch), '2026-09-28');
  // 2026-09-27T15:59:00Z is still 2026-09-27 23:59 MYT.
  const epoch2 = Date.UTC(2026, 8, 27, 15, 59, 0);
  assert.strictEqual(SlotEngine.getTodayMyt(epoch2), '2026-09-27');
});

// ---- opening hours ----

test('getOpeningInterval returns null for a day marked closed', () => {
  const wh = makeWeeklyHours();
  assert.strictEqual(SlotEngine.getOpeningInterval(wh, '2026-09-27'), null); // Sunday
});

test('getOpeningInterval returns the configured interval for an open day', () => {
  const wh = makeWeeklyHours();
  assert.deepStrictEqual(SlotEngine.getOpeningInterval(wh, '2026-09-28'), { startMin: 570, endMin: 1170 });
});

test('getOpeningInterval rejects a day whose close time is not after open time', () => {
  const wh = makeWeeklyHours({ 1: { closed: false, open: '10:00', close: '10:00' } });
  assert.strictEqual(SlotEngine.getOpeningInterval(wh, '2026-09-28'), null);
});

// ---- zero availability / closed day end-to-end ----

test('getSlotsForDate reports closed with no slots on a closed day', () => {
  const config = makeConfig();
  const result = SlotEngine.getSlotsForDate(config, '2026-09-27', 'haircut'); // Sunday
  assert.strictEqual(result.closed, true);
  assert.deepStrictEqual(result.slots, []);
});

test('getSlotsForDate returns zero slots when a single block covers the whole day', () => {
  const config = makeConfig({
    blocks: [{ id: 'b1', date: '2026-09-28', startTime: '09:30', endTime: '19:30' }]
  });
  const result = SlotEngine.getSlotsForDate(config, '2026-09-28', 'haircut');
  assert.strictEqual(result.closed, false);
  assert.deepStrictEqual(result.slots, []);
});

test('getSlotsForDate returns an error for an unknown service id', () => {
  const config = makeConfig();
  const result = SlotEngine.getSlotsForDate(config, '2026-09-28', 'does-not-exist');
  assert.strictEqual(result.closed, true);
  assert.deepStrictEqual(result.slots, []);
  assert.ok(result.error);
});

// ---- block validation ----

test('validateBlockInput rejects end time not after start time', () => {
  const res = SlotEngine.validateBlockInput({ date: '2026-09-28', startTime: '12:00', endTime: '12:00' }, []);
  assert.strictEqual(res.valid, false);
});

test('validateBlockInput rejects malformed time strings', () => {
  const res = SlotEngine.validateBlockInput({ date: '2026-09-28', startTime: '12:00', endTime: '25:00' }, []);
  assert.strictEqual(res.valid, false);
});

test('validateBlockInput rejects a block overlapping an existing one on the same date', () => {
  const existing = SlotEngine.getBlocksForDate(
    [{ id: 'b1', date: '2026-09-28', startTime: '12:00', endTime: '13:00' }],
    '2026-09-28'
  );
  const res = SlotEngine.validateBlockInput({ date: '2026-09-28', startTime: '12:30', endTime: '13:30' }, existing);
  assert.strictEqual(res.valid, false);
});

test('validateBlockInput accepts a non-overlapping block', () => {
  const existing = SlotEngine.getBlocksForDate(
    [{ id: 'b1', date: '2026-09-28', startTime: '12:00', endTime: '13:00' }],
    '2026-09-28'
  );
  const res = SlotEngine.validateBlockInput({ date: '2026-09-28', startTime: '13:00', endTime: '14:00' }, existing);
  assert.strictEqual(res.valid, true);
});

// ---- overlapping blocks handling inside slot generation ----

test('subtractBlocks merges overlapping blocks before computing free time', () => {
  const opening = { startMin: 540, endMin: 600 }; // 09:00-10:00
  const blocks = [
    { startMin: 540, endMin: 570 }, // 09:00-09:30
    { startMin: 560, endMin: 590 }  // 09:20-09:50 (overlaps the first)
  ];
  const free = SlotEngine.subtractBlocks(opening, blocks);
  assert.deepStrictEqual(free, [{ startMin: 590, endMin: 600 }]);
});

test('generateCandidateSlots skips over multiple blocked periods in one day', () => {
  const opening = { startMin: 570, endMin: 720 }; // 09:30-12:00
  const blocks = [
    { startMin: 600, endMin: 630 }, // 10:00-10:30
    { startMin: 660, endMin: 690 }  // 11:00-11:30
  ];
  const slots = SlotEngine.generateCandidateSlots(opening, blocks, 30, 0);
  const starts = slots.map((s) => SlotEngine.minutesToTime(s.startMin));
  assert.deepStrictEqual(starts, ['09:30', '10:30', '11:30']);
});

// ---- buffer & opening-hour overflow prevention ----

test('slots respect buffer minutes as spacing between consecutive appointments', () => {
  const opening = { startMin: 0, endMin: 100 };
  const slots = SlotEngine.generateCandidateSlots(opening, [], 30, 10);
  // Each occupied block is 40 min (30 duration + 10 buffer): starts at 0, 40.
  // A third slot at 80 would need until 120, which overflows the 100-min window.
  assert.deepStrictEqual(slots.map((s) => s.startMin), [0, 40]);
});

test('a slot is never offered if duration + buffer would overflow the opening interval (end-of-day case)', () => {
  const opening = { startMin: 0, endMin: 100 };
  const slots = SlotEngine.generateCandidateSlots(opening, [], 30, 10);
  // 80 + 30 + 10 = 120 > 100 would be the next slot; it must not appear.
  assert.strictEqual(slots.some((s) => s.startMin === 90), false);
  slots.forEach((s) => {
    assert.ok(s.startMin + 30 + 10 <= 100, 'slot ' + s.startMin + ' overflows with buffer');
  });
});

test('a slot exactly fitting duration+buffer at the closing boundary is included', () => {
  const opening = { startMin: 0, endMin: 40 }; // exactly one 30+10 slot
  const slots = SlotEngine.generateCandidateSlots(opening, [], 30, 10);
  assert.deepStrictEqual(slots.map((s) => s.startMin), [0]);
});

test('no candidate slot ever overlaps a blocked period', () => {
  const opening = { startMin: 570, endMin: 1170 };
  const blocks = [{ startMin: 720, endMin: 780 }]; // 12:00-13:00 lunch
  const slots = SlotEngine.generateCandidateSlots(opening, blocks, 45, 10);
  slots.forEach((s) => {
    const occStart = s.startMin;
    const occEnd = s.startMin + 45 + 10;
    const overlaps = occStart < blocks[0].endMin && occEnd > blocks[0].startMin;
    assert.strictEqual(overlaps, false, 'slot at ' + s.startMin + ' overlaps the lunch block');
  });
});

test('long service duration (colouring) yields fewer, non-overlapping slots', () => {
  const config = makeConfig();
  const result = SlotEngine.getSlotsForDate(config, '2026-09-28', 'colour'); // 120 min, 09:30-19:30, buffer 10
  for (let i = 1; i < result.slots.length; i++) {
    assert.ok(result.slots[i].startMin >= result.slots[i - 1].startMin + 120 + 10);
  }
  assert.ok(result.slots.length > 0);
});

// ---- selection invalidation after edits ----

test('isSlotAvailable returns false once a block is added over a previously free slot', () => {
  const config = makeConfig();
  const before = SlotEngine.getSlotsForDate(config, '2026-09-28', 'haircut');
  const targetStart = before.slots[0].startMin;
  assert.strictEqual(SlotEngine.isSlotAvailable(config, '2026-09-28', 'haircut', targetStart), true);

  const startTime = SlotEngine.minutesToTime(targetStart);
  const endTime = SlotEngine.minutesToTime(targetStart + 30);
  const configWithBlock = makeConfig({
    blocks: [{ id: 'b1', date: '2026-09-28', startTime: startTime, endTime: endTime }]
  });
  assert.strictEqual(SlotEngine.isSlotAvailable(configWithBlock, '2026-09-28', 'haircut', targetStart), false);
});

test('isSlotAvailable returns false when the day is switched to closed', () => {
  const config = makeConfig();
  const before = SlotEngine.getSlotsForDate(config, '2026-09-28', 'haircut');
  const targetStart = before.slots[0].startMin;
  const closedConfig = makeConfig({ weeklyHours: makeWeeklyHours({ 1: { closed: true } }) });
  assert.strictEqual(SlotEngine.isSlotAvailable(closedConfig, '2026-09-28', 'haircut', targetStart), false);
});

// ---- ICS export ----

test('buildIcsForSlot converts MYT time to correct UTC DTSTART/DTEND', () => {
  const ics = SlotEngine.buildIcsForSlot({
    dateStr: '2026-09-28',
    startMin: SlotEngine.timeToMinutes('09:30'), // 09:30 MYT = 01:30 UTC same day
    durationMin: 30,
    serviceName: 'Haircut',
    businessName: 'Contoh Salon',
    now: new Date(Date.UTC(2026, 8, 27, 3, 0, 0)),
    uid: 'test-uid-1'
  });
  assert.ok(ics.includes('DTSTART:20260928T013000Z'));
  assert.ok(ics.includes('DTEND:20260928T020000Z'));
  assert.ok(/\r\n/.test(ics), 'ics must use CRLF line endings');
});

test('buildIcsForSlot rolls back to the previous UTC date for early MYT morning slots', () => {
  const ics = SlotEngine.buildIcsForSlot({
    dateStr: '2026-09-28',
    startMin: SlotEngine.timeToMinutes('00:30'), // 00:30 MYT 28th = 16:30 UTC 27th
    durationMin: 30,
    serviceName: 'Haircut',
    businessName: 'Contoh Salon',
    now: new Date(Date.UTC(2026, 8, 27, 3, 0, 0)),
    uid: 'test-uid-2'
  });
  assert.ok(ics.includes('DTSTART:20260927T163000Z'));
  assert.ok(ics.includes('DTEND:20260927T170000Z'));
});

test('buildIcsForSlot correctly rolls the UTC date forward across a month boundary', () => {
  // 2026-10-01 00:15 MYT = 2026-09-30 16:15 UTC
  const ics = SlotEngine.buildIcsForSlot({
    dateStr: '2026-10-01',
    startMin: SlotEngine.timeToMinutes('00:15'),
    durationMin: 15,
    serviceName: 'Haircut',
    businessName: 'Contoh Salon',
    now: new Date(Date.UTC(2026, 8, 30, 1, 0, 0)),
    uid: 'test-uid-3'
  });
  assert.ok(ics.includes('DTSTART:20260930T161500Z'));
  assert.ok(ics.includes('DTEND:20260930T163000Z'));
});

test('buildIcsForSlot marks the event as a HOLD / not confirmed, and escapes special text', () => {
  const ics = SlotEngine.buildIcsForSlot({
    dateStr: '2026-09-28',
    startMin: 570,
    durationMin: 30,
    serviceName: 'Cut; Wash, Trim',
    businessName: 'Salon "Contoh", Bangi',
    now: new Date(),
    uid: 'test-uid-4'
  });
  assert.ok(/SUMMARY:HOLD \(not confirmed\)/.test(ics));
  assert.ok(ics.includes('STATUS:TENTATIVE'));
  assert.ok(ics.includes('Cut\\; Wash\\, Trim'));
});

test('escapeIcsText escapes backslashes, semicolons, commas and newlines', () => {
  const out = SlotEngine.escapeIcsText('a\\b;c,d\ne');
  assert.strictEqual(out, 'a\\\\b\\;c\\,d\\ne');
});

// ---- report ----

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
  failures.forEach(function (f) {
    console.log('\nFAIL: ' + f.name);
    console.log(f.err && f.err.stack ? f.err.stack : f.err);
  });
  process.exitCode = 1;
}
