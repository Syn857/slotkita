/*
 * SlotKita slot engine — pure, DOM-free scheduling logic.
 * Works in Node (via module.exports) and in the browser (via window.SlotEngine).
 * All times are handled as Asia/Kuala_Lumpur (MYT, UTC+8, no DST) civil dates/times.
 */
(function (root) {
  'use strict';

  var MYT_OFFSET_MIN = 480; // UTC+8, fixed, no daylight saving
  var MINUTES_PER_DAY = 1440;
  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  // ---- time-of-day helpers ("HH:MM" <-> minutes since midnight) ----

  var TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function isValidTimeString(s) {
    return typeof s === 'string' && TIME_RE.test(s);
  }

  function timeToMinutes(hhmm) {
    if (!isValidTimeString(hhmm)) return null;
    var parts = hhmm.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }

  function minutesToTime(mins) {
    if (typeof mins !== 'number' || isNaN(mins) || mins < 0 || mins > MINUTES_PER_DAY) return null;
    if (mins === MINUTES_PER_DAY) return '24:00';
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return pad2(h) + ':' + pad2(m);
  }

  // ---- calendar date helpers ("YYYY-MM-DD" civil date, timezone-agnostic) ----

  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function isValidDateString(s) {
    if (typeof s !== 'string') return false;
    var m = DATE_RE.exec(s);
    if (!m) return false;
    var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }

  function formatDateParts(y, mo, d) {
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }

  function dateStrToUtcDate(dateStr) {
    var m = DATE_RE.exec(dateStr);
    return new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
  }

  function getDayOfWeek(dateStr) {
    if (!isValidDateString(dateStr)) return null;
    return dateStrToUtcDate(dateStr).getUTCDay(); // 0 = Sunday .. 6 = Saturday
  }

  function addDays(dateStr, n) {
    if (!isValidDateString(dateStr)) return null;
    var base = dateStrToUtcDate(dateStr);
    var shifted = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + n));
    return formatDateParts(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
  }

  // Current civil date in MYT, derived from a UTC epoch (defaults to now). Kept
  // injectable so callers/tests never depend on the host machine's local timezone.
  function getTodayMyt(nowMs) {
    var epoch = typeof nowMs === 'number' ? nowMs : Date.now();
    var shifted = new Date(epoch + MYT_OFFSET_MIN * 60000);
    return formatDateParts(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
  }

  function getNextDates(startDateStr, count) {
    var out = [];
    for (var i = 0; i < count; i++) {
      out.push(addDays(startDateStr, i));
    }
    return out;
  }

  // ---- opening hours ----

  // weeklyHours: array of 7 entries indexed 0(Sun)..6(Sat): { closed, open, close }
  function getOpeningInterval(weeklyHours, dateStr) {
    if (!Array.isArray(weeklyHours) || !isValidDateString(dateStr)) return null;
    var dow = getDayOfWeek(dateStr);
    var day = weeklyHours[dow];
    if (!day || day.closed) return null;
    var startMin = timeToMinutes(day.open);
    var endMin = timeToMinutes(day.close);
    if (startMin === null || endMin === null || endMin <= startMin) return null;
    return { startMin: startMin, endMin: endMin };
  }

  // ---- unavailable blocks ----

  function getBlocksForDate(blocks, dateStr) {
    if (!Array.isArray(blocks)) return [];
    return blocks
      .filter(function (b) { return b && b.date === dateStr; })
      .map(function (b) {
        return { id: b.id, startMin: timeToMinutes(b.startTime), endMin: timeToMinutes(b.endTime) };
      })
      .filter(function (b) { return b.startMin !== null && b.endMin !== null && b.endMin > b.startMin; })
      .sort(function (a, b) { return a.startMin - b.startMin; });
  }

  // Validates a candidate block against basic range rules and overlap with
  // existing blocks on the same date. Returns { valid, error } or { valid: true, startMin, endMin }.
  function validateBlockInput(input, existingBlocksForDate) {
    if (!input || !isValidDateString(input.date)) {
      return { valid: false, error: 'Pick a valid date.' };
    }
    if (!isValidTimeString(input.startTime) || !isValidTimeString(input.endTime)) {
      return { valid: false, error: 'Start and end time must be in HH:MM format.' };
    }
    var startMin = timeToMinutes(input.startTime);
    var endMin = timeToMinutes(input.endTime);
    if (endMin <= startMin) {
      return { valid: false, error: 'End time must be after start time.' };
    }
    var existing = existingBlocksForDate || [];
    for (var i = 0; i < existing.length; i++) {
      var b = existing[i];
      if (startMin < b.endMin && endMin > b.startMin) {
        return { valid: false, error: 'This overlaps an existing unavailable block on that date.' };
      }
    }
    return { valid: true, startMin: startMin, endMin: endMin };
  }

  // Merge overlapping/adjacent minute intervals, sorted ascending by start.
  function mergeIntervals(intervals) {
    var sorted = intervals.slice().sort(function (a, b) { return a.startMin - b.startMin; });
    var merged = [];
    for (var i = 0; i < sorted.length; i++) {
      var cur = sorted[i];
      var last = merged[merged.length - 1];
      if (last && cur.startMin <= last.endMin) {
        last.endMin = Math.max(last.endMin, cur.endMin);
      } else {
        merged.push({ startMin: cur.startMin, endMin: cur.endMin });
      }
    }
    return merged;
  }

  // Subtracts blocked intervals from a single opening interval, clipping blocks
  // to the opening interval bounds. Returns free sub-intervals, ascending.
  function subtractBlocks(openingInterval, blocks) {
    if (!openingInterval) return [];
    var clipped = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var s = Math.max(b.startMin, openingInterval.startMin);
      var e = Math.min(b.endMin, openingInterval.endMin);
      if (e > s) clipped.push({ startMin: s, endMin: e });
    }
    var merged = mergeIntervals(clipped);
    var free = [];
    var cursor = openingInterval.startMin;
    for (var j = 0; j < merged.length; j++) {
      if (merged[j].startMin > cursor) {
        free.push({ startMin: cursor, endMin: merged[j].startMin });
      }
      cursor = Math.max(cursor, merged[j].endMin);
    }
    if (cursor < openingInterval.endMin) {
      free.push({ startMin: cursor, endMin: openingInterval.endMin });
    }
    return free;
  }

  // Packs sequential candidate slots into free intervals. Each slot occupies
  // durationMin (the service) plus bufferMin (cleanup/setup) which must also
  // fit inside the free interval, so buffer time never overflows opening hours
  // or spills into a blocked period.
  function packSlots(freeIntervals, durationMin, bufferMin) {
    var occupied = durationMin + Math.max(0, bufferMin || 0);
    var slots = [];
    for (var i = 0; i < freeIntervals.length; i++) {
      var interval = freeIntervals[i];
      var cursor = interval.startMin;
      while (cursor + occupied <= interval.endMin) {
        slots.push({ startMin: cursor, endMin: cursor + durationMin });
        cursor += occupied;
      }
    }
    return slots;
  }

  function generateCandidateSlots(openingInterval, blocks, durationMin, bufferMin) {
    if (!openingInterval || !durationMin || durationMin <= 0) return [];
    var free = subtractBlocks(openingInterval, blocks);
    return packSlots(free, durationMin, bufferMin);
  }

  // High-level: compute the day's status plus candidate slots for one service.
  // config: { weeklyHours, bufferMin, blocks, services }
  function getSlotsForDate(config, dateStr, serviceId) {
    var service = (config.services || []).filter(function (s) { return s.id === serviceId; })[0];
    if (!service || !(service.durationMin > 0)) {
      return { dateStr: dateStr, closed: true, slots: [], error: 'Unknown service.' };
    }
    var opening = getOpeningInterval(config.weeklyHours, dateStr);
    if (!opening) {
      return { dateStr: dateStr, closed: true, slots: [] };
    }
    var blocks = getBlocksForDate(config.blocks, dateStr);
    var slots = generateCandidateSlots(opening, blocks, service.durationMin, config.bufferMin || 0);
    return { dateStr: dateStr, closed: false, slots: slots };
  }

  function isSlotAvailable(config, dateStr, serviceId, startMin) {
    var result = getSlotsForDate(config, dateStr, serviceId);
    return result.slots.some(function (s) { return s.startMin === startMin; });
  }

  // ---- .ics export ----

  function escapeIcsText(text) {
    return String(text)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\n|\r/g, '\\n');
  }

  // Absolute UTC instant corresponding to a MYT civil date + minutes-since-midnight.
  function mytToUtcDate(dateStr, minutesInDay) {
    var d = dateStrToUtcDate(dateStr);
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) +
        minutesInDay * 60000 -
        MYT_OFFSET_MIN * 60000
    );
  }

  function formatIcsUtc(date) {
    return (
      date.getUTCFullYear() +
      pad2(date.getUTCMonth() + 1) +
      pad2(date.getUTCDate()) +
      'T' +
      pad2(date.getUTCHours()) +
      pad2(date.getUTCMinutes()) +
      pad2(date.getUTCSeconds()) +
      'Z'
    );
  }

  // Builds a HOLD (not-confirmed) .ics VEVENT. `now` and `uid` are injectable for
  // deterministic tests; both default to real values in normal use.
  function buildIcsForSlot(opts) {
    var dateStr = opts.dateStr;
    var startMin = opts.startMin;
    var durationMin = opts.durationMin;
    var serviceName = opts.serviceName || 'Appointment';
    var businessName = opts.businessName || 'SlotKita';
    var now = opts.now instanceof Date ? opts.now : new Date();
    var uid = opts.uid || ('slotkita-' + now.getTime() + '-' + Math.random().toString(36).slice(2));

    var dtStart = mytToUtcDate(dateStr, startMin);
    var dtEnd = mytToUtcDate(dateStr, startMin + durationMin);
    var summary = 'HOLD (not confirmed): ' + serviceName + ' – ' + businessName;
    var description =
      'This is a candidate time slot only. Nothing has been booked, submitted or ' +
      'reserved. Contact ' + businessName + ' to confirm this appointment.';

    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SlotKita//MVP//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:' + escapeIcsText(uid),
      'DTSTAMP:' + formatIcsUtc(now),
      'DTSTART:' + formatIcsUtc(dtStart),
      'DTEND:' + formatIcsUtc(dtEnd),
      'SUMMARY:' + escapeIcsText(summary),
      'DESCRIPTION:' + escapeIcsText(description),
      'STATUS:TENTATIVE',
      'END:VEVENT',
      'END:VCALENDAR'
    ];
    return lines.join('\r\n') + '\r\n';
  }

  var SlotEngine = {
    MYT_OFFSET_MIN: MYT_OFFSET_MIN,
    MINUTES_PER_DAY: MINUTES_PER_DAY,
    DAY_NAMES: DAY_NAMES,
    isValidTimeString: isValidTimeString,
    timeToMinutes: timeToMinutes,
    minutesToTime: minutesToTime,
    isValidDateString: isValidDateString,
    getDayOfWeek: getDayOfWeek,
    addDays: addDays,
    getTodayMyt: getTodayMyt,
    getNextDates: getNextDates,
    getOpeningInterval: getOpeningInterval,
    getBlocksForDate: getBlocksForDate,
    validateBlockInput: validateBlockInput,
    mergeIntervals: mergeIntervals,
    subtractBlocks: subtractBlocks,
    generateCandidateSlots: generateCandidateSlots,
    getSlotsForDate: getSlotsForDate,
    isSlotAvailable: isSlotAvailable,
    escapeIcsText: escapeIcsText,
    mytToUtcDate: mytToUtcDate,
    formatIcsUtc: formatIcsUtc,
    buildIcsForSlot: buildIcsForSlot
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SlotEngine;
  } else {
    root.SlotEngine = SlotEngine;
  }
})(typeof window !== 'undefined' ? window : globalThis);
