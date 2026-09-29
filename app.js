/*
 * SlotKita — DOM wiring around slot-engine.js. Nothing here reaches a network
 * or storage: all state is in memory for this browser tab only.
 */
(function () {
  'use strict';

  var SlotEngine = window.SlotEngine;

  var DAY_LABELS = ['Ahad', 'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu'];
  var DAY_LABELS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTH_LABELS = ['Jan', 'Feb', 'Mac', 'Apr', 'Mei', 'Jun', 'Jul', 'Ogo', 'Sep', 'Okt', 'Nov', 'Dis'];

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function makeId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function defaultWeeklyHours() {
    return [0, 1, 2, 3, 4, 5, 6].map(function (i) {
      return i === 0
        ? { closed: true, open: '09:30', close: '19:30' }
        : { closed: false, open: '09:30', close: '19:30' };
    });
  }

  function defaultServices() {
    return [
      { id: 'haircut', name: 'Haircut (gunting rambut)', durationMin: 30, priceRM: 25 },
      { id: 'wash-blow', name: 'Wash & blow-dry (basuh & blow)', durationMin: 45, priceRM: 35 },
      { id: 'colour', name: 'Colouring (warna rambut)', durationMin: 120, priceRM: 120 }
    ];
  }

  var today = SlotEngine.getTodayMyt();

  var state = {
    businessName: 'Your salon',
    weeklyHours: defaultWeeklyHours(),
    bufferMin: 10,
    services: defaultServices(),
    blocks: [
      {
        id: makeId('block'),
        date: SlotEngine.addDays(today, 1),
        startTime: '13:00',
        endTime: '14:00',
        label: 'Rehat tengah hari (lunch break)'
      }
    ],
    selectedServiceId: 'haircut',
    visibleDates: SlotEngine.getNextDates(today, 7),
    selectedDateStr: today,
    selectedSlotStartMin: null
  };

  function getConfig() {
    return {
      weeklyHours: state.weeklyHours,
      bufferMin: state.bufferMin,
      blocks: state.blocks,
      services: state.services
    };
  }

  function withFocusPreserved(fn) {
    var active = document.activeElement;
    var activeId = active && active.id ? active.id : null;
    var selStart = active && 'selectionStart' in active ? active.selectionStart : null;
    fn();
    if (activeId) {
      var el = document.getElementById(activeId);
      if (el) {
        el.focus();
        if (selStart !== null && typeof el.setSelectionRange === 'function') {
          try {
            el.setSelectionRange(selStart, selStart);
          } catch (e) {
            /* not a text-selectable input; ignore */
          }
        }
      }
    }
  }

  function reconcileSelection() {
    if (state.selectedSlotStartMin != null) {
      var ok = SlotEngine.isSlotAvailable(
        getConfig(),
        state.selectedDateStr,
        state.selectedServiceId,
        state.selectedSlotStartMin
      );
      if (!ok) state.selectedSlotStartMin = null;
    }
  }

  // ---- render: service options ----

  function renderServiceOptions() {
    var container = document.getElementById('service-options');
    container.innerHTML = state.services
      .map(function (s) {
        var id = 'service-' + s.id;
        var checked = s.id === state.selectedServiceId ? ' checked' : '';
        return (
          '<label class="service-option" for="' + id + '">' +
          '<input type="radio" name="service" id="' + id + '" value="' + s.id + '"' + checked + '>' +
          '<span class="service-name">' + escapeHtml(s.name) + '</span>' +
          '<span class="service-meta">' + s.durationMin + ' min &middot; RM ' + s.priceRM + ' (sample price)</span>' +
          '</label>'
        );
      })
      .join('');
    container.querySelectorAll('input[type="radio"]').forEach(function (input) {
      input.addEventListener('change', function () {
        state.selectedServiceId = input.value;
        withFocusPreserved(render);
      });
    });
  }

  // ---- render: weekly hours ----

  function renderHoursEditor() {
    var container = document.getElementById('hours-editor');
    container.innerHTML = state.weeklyHours
      .map(function (day, i) {
        var openMin = SlotEngine.timeToMinutes(day.open);
        var closeMin = SlotEngine.timeToMinutes(day.close);
        var invalid = !day.closed && openMin !== null && closeMin !== null && closeMin <= openMin;
        var rowClass = 'hours-row' + (day.closed ? ' is-closed' : '');
        return (
          '<div class="' + rowClass + '">' +
          '<span class="hours-day">' + DAY_LABELS[i] + ' <span class="hours-day-en">(' + DAY_LABELS_EN[i] + ')</span></span>' +
          '<label class="closed-toggle" for="day-closed-' + i + '">' +
          '<input type="checkbox" id="day-closed-' + i + '"' + (day.closed ? ' checked' : '') + '> Closed' +
          '</label>' +
          '<label class="sr-only" for="day-open-' + i + '">' + DAY_LABELS_EN[i] + ' opening time</label>' +
          '<input type="time" id="day-open-' + i + '" value="' + day.open + '"' + (day.closed ? ' disabled' : '') + '>' +
          '<span aria-hidden="true">&ndash;</span>' +
          '<label class="sr-only" for="day-close-' + i + '">' + DAY_LABELS_EN[i] + ' closing time</label>' +
          '<input type="time" id="day-close-' + i + '" value="' + day.close + '"' + (day.closed ? ' disabled' : '') + '>' +
          (invalid
            ? '<p class="field-error" role="alert">Closing time must be after opening time — no slots will be offered for ' +
              DAY_LABELS_EN[i] +
              ' until this is fixed.</p>'
            : '') +
          '</div>'
        );
      })
      .join('');

    state.weeklyHours.forEach(function (day, i) {
      var closedInput = document.getElementById('day-closed-' + i);
      var openInput = document.getElementById('day-open-' + i);
      var closeInput = document.getElementById('day-close-' + i);
      closedInput.addEventListener('change', function () {
        state.weeklyHours[i].closed = closedInput.checked;
        withFocusPreserved(render);
      });
      openInput.addEventListener('change', function () {
        state.weeklyHours[i].open = openInput.value;
        withFocusPreserved(render);
      });
      closeInput.addEventListener('change', function () {
        state.weeklyHours[i].close = closeInput.value;
        withFocusPreserved(render);
      });
    });
  }

  // ---- render: buffer ----

  function syncBufferInput() {
    var input = document.getElementById('buffer-input');
    if (document.activeElement !== input) {
      input.value = state.bufferMin;
    }
  }

  function initBufferInput() {
    var input = document.getElementById('buffer-input');
    var errorEl = document.getElementById('buffer-error');
    input.value = state.bufferMin;
    input.addEventListener('change', function () {
      var n = parseInt(input.value, 10);
      if (isNaN(n) || n < 0 || n > 180) {
        errorEl.hidden = false;
        errorEl.textContent = 'Buffer must be a whole number of minutes between 0 and 180.';
        input.value = state.bufferMin;
        return;
      }
      errorEl.hidden = true;
      state.bufferMin = n;
      withFocusPreserved(render);
    });
  }

  // ---- render: unavailable blocks ----

  function formatBlockLabel(block) {
    var d = block.date.split('-');
    var dow = SlotEngine.getDayOfWeek(block.date);
    var when = DAY_LABELS_EN[dow] + ' ' + d[2] + ' ' + MONTH_LABELS[parseInt(d[1], 10) - 1];
    var label = block.label ? escapeHtml(block.label) + ' — ' : '';
    return label + when + ', ' + block.startTime + '–' + block.endTime;
  }

  function renderBlockList() {
    var listEl = document.getElementById('block-list');
    if (state.blocks.length === 0) {
      listEl.innerHTML = '<li class="block-empty">No unavailable blocks added yet.</li>';
      return;
    }
    var sorted = state.blocks.slice().sort(function (a, b) {
      return a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date);
    });
    listEl.innerHTML = sorted
      .map(function (b) {
        return (
          '<li><span>' +
          formatBlockLabel(b) +
          '</span><button type="button" class="btn btn-danger" id="delete-block-' +
          b.id +
          '" data-id="' +
          b.id +
          '">Delete</button></li>'
        );
      })
      .join('');
    sorted.forEach(function (b) {
      document.getElementById('delete-block-' + b.id).addEventListener('click', function () {
        state.blocks = state.blocks.filter(function (x) {
          return x.id !== b.id;
        });
        withFocusPreserved(render);
      });
    });
  }

  function initBlockForm() {
    var form = document.getElementById('block-form');
    var errorEl = document.getElementById('block-error');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var dateInput = document.getElementById('block-date');
      var startInput = document.getElementById('block-start');
      var endInput = document.getElementById('block-end');
      var labelInput = document.getElementById('block-label');

      var input = { date: dateInput.value, startTime: startInput.value, endTime: endInput.value };
      var existing = SlotEngine.getBlocksForDate(state.blocks, input.date);
      var result = SlotEngine.validateBlockInput(input, existing);

      if (!result.valid) {
        errorEl.hidden = false;
        errorEl.textContent = result.error;
        return;
      }

      errorEl.hidden = true;
      state.blocks.push({
        id: makeId('block'),
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        label: labelInput.value.trim().slice(0, 40)
      });
      form.reset();
      withFocusPreserved(render);
    });
  }

  // ---- render: date navigation ----

  function renderDateNav() {
    var container = document.getElementById('date-nav');
    container.innerHTML = state.visibleDates
      .map(function (d) {
        var dow = SlotEngine.getDayOfWeek(d);
        var isClosed = !SlotEngine.getOpeningInterval(state.weeklyHours, d);
        var selected = d === state.selectedDateStr;
        var parts = d.split('-');
        var classes = 'date-tab' + (selected ? ' is-selected' : '') + (isClosed ? ' is-closed' : '');
        return (
          '<button type="button" id="date-nav-' +
          d +
          '" class="' +
          classes +
          '" role="tab" aria-selected="' +
          selected +
          '" data-date="' +
          d +
          '">' +
          '<span class="date-tab-day">' +
          DAY_LABELS[dow] +
          '</span>' +
          '<span class="date-tab-num">' +
          parts[2] +
          '/' +
          parts[1] +
          '</span>' +
          (isClosed ? '<span class="date-tab-tag">Closed</span>' : '') +
          '</button>'
        );
      })
      .join('');
    state.visibleDates.forEach(function (d) {
      document.getElementById('date-nav-' + d).addEventListener('click', function () {
        state.selectedDateStr = d;
        withFocusPreserved(render);
      });
    });
  }

  // ---- render: slot list ----

  function renderSlotList() {
    var statusEl = document.getElementById('slots-status');
    var listEl = document.getElementById('slot-list');
    var result = SlotEngine.getSlotsForDate(getConfig(), state.selectedDateStr, state.selectedServiceId);

    if (result.closed) {
      statusEl.textContent = 'Ditutup pada hari ini — closed on this day, no slots to show.';
      listEl.innerHTML = '';
      return;
    }
    if (result.slots.length === 0) {
      statusEl.textContent = 'Tiada slot tersedia — no candidate slots available for this day with the current settings.';
      listEl.innerHTML = '';
      return;
    }
    statusEl.textContent = result.slots.length + ' candidate slot(s) available.';
    listEl.innerHTML = result.slots
      .map(function (s) {
        var label = SlotEngine.minutesToTime(s.startMin) + '–' + SlotEngine.minutesToTime(s.endMin);
        var selected = state.selectedSlotStartMin === s.startMin;
        return (
          '<button type="button" id="slot-' +
          s.startMin +
          '" class="slot-btn' +
          (selected ? ' is-selected' : '') +
          '" aria-pressed="' +
          selected +
          '" data-start="' +
          s.startMin +
          '">' +
          label +
          '</button>'
        );
      })
      .join('');
    result.slots.forEach(function (s) {
      document.getElementById('slot-' + s.startMin).addEventListener('click', function () {
        state.selectedSlotStartMin = state.selectedSlotStartMin === s.startMin ? null : s.startMin;
        withFocusPreserved(render);
      });
    });
  }

  // ---- render: selection summary ----

  function formatDateLong(dateStr) {
    var parts = dateStr.split('-');
    var dow = SlotEngine.getDayOfWeek(dateStr);
    return (
      DAY_LABELS_EN[dow] + ', ' + parseInt(parts[2], 10) + ' ' + MONTH_LABELS[parseInt(parts[1], 10) - 1] + ' ' + parts[0]
    );
  }

  function buildSummaryText(service, dateStr, startMin, endMin) {
    var startTime = SlotEngine.minutesToTime(startMin);
    var endTime = SlotEngine.minutesToTime(endMin);
    return (
      'SlotKita — candidate hold (NOT confirmed)\n' +
      'Business: ' + state.businessName + '\n' +
      'Service: ' + service.name + ' (sample price RM ' + service.priceRM + ')\n' +
      'Date: ' + formatDateLong(dateStr) + '\n' +
      'Time: ' + startTime + '–' + endTime + ' MYT (Asia/Kuala_Lumpur)\n\n' +
      'This is a candidate time slot only. Nothing has been booked, submitted or ' +
      'reserved. Contact the business directly to confirm.'
    );
  }

  function renderSummary() {
    var summaryEl = document.getElementById('selection-summary');
    if (state.selectedSlotStartMin == null) {
      summaryEl.hidden = true;
      summaryEl.innerHTML = '';
      return;
    }
    var service = state.services.filter(function (s) {
      return s.id === state.selectedServiceId;
    })[0];
    var startMin = state.selectedSlotStartMin;
    var endMin = startMin + service.durationMin;
    var text = buildSummaryText(service, state.selectedDateStr, startMin, endMin);

    summaryEl.hidden = false;
    summaryEl.innerHTML =
      '<h3>Candidate hold — not confirmed</h3>' +
      '<p class="disclaimer">Nothing has been booked, submitted or reserved. Download a calendar HOLD or copy this summary to share with the salon.</p>' +
      '<textarea id="summary-text" readonly rows="6">' + escapeHtml(text) + '</textarea>' +
      '<div class="summary-actions">' +
      '<button type="button" id="download-ics-btn" class="btn btn-primary">Download .ics (HOLD)</button>' +
      '<button type="button" id="copy-summary-btn" class="btn btn-secondary">Copy summary</button>' +
      '</div>' +
      '<p id="copy-status" class="status-msg" role="status"></p>';

    document.getElementById('download-ics-btn').addEventListener('click', function () {
      var ics = SlotEngine.buildIcsForSlot({
        dateStr: state.selectedDateStr,
        startMin: startMin,
        durationMin: service.durationMin,
        serviceName: service.name,
        businessName: state.businessName
      });
      var blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'slotkita-hold-' + state.selectedDateStr + '-' + SlotEngine.minutesToTime(startMin).replace(':', '') + '.ics';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      document.getElementById('copy-status').textContent = 'Calendar HOLD file downloaded.';
    });

    document.getElementById('copy-summary-btn').addEventListener('click', function () {
      var statusEl = document.getElementById('copy-status');
      var textarea = document.getElementById('summary-text');
      function done(ok) {
        statusEl.textContent = ok ? 'Summary copied to clipboard.' : 'Could not copy automatically — text is selected, press Ctrl/Cmd+C.';
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          done(true);
        }, function () {
          textarea.select();
          done(false);
        });
      } else {
        textarea.select();
        try {
          done(document.execCommand('copy'));
        } catch (e) {
          done(false);
        }
      }
    });
  }

  // ---- master render ----

  function render() {
    reconcileSelection();
    renderServiceOptions();
    renderHoursEditor();
    syncBufferInput();
    renderBlockList();
    renderDateNav();
    renderSlotList();
    renderSummary();
  }

  document.addEventListener('DOMContentLoaded', function () {
    initBufferInput();
    initBlockForm();
    render();
  });
})();
