/* A+Piano: MIDI test (slice 1) */
(function () {
  "use strict";

  var NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  var BLACK_PC = { 1: true, 3: true, 6: true, 8: true, 10: true };
  var DEFAULT_LOW = 36; // C2 in the C4 = 60 convention
  var DEFAULT_HIGH = 72; // C5
  var MAX_LOG = 50;
  var LATENCY_SAMPLES = 40;

  var state = {
    access: null,
    visibleLow: DEFAULT_LOW,
    visibleHigh: DEFAULT_HIGH,
    held: {},       // note -> { vel, sources: { midi: ch, touch: true } }
    sustained: {},  // notes held only by the pedal
    sustainOn: false,
    last: null,     // { note, vel, ch, name }
    seenLow: null,
    seenHigh: null,
    log: [],
    filterRealtime: true,
    logOpen: false,
    runningStatus: 0,
    latency: [],
    wakeLock: null,
    connecting: false
  };

  var els = {
    status: document.getElementById("status"),
    btnConnect: document.getElementById("btn-connect"),
    lastName: document.getElementById("last-name"),
    lastNum: document.getElementById("last-num"),
    lastVel: document.getElementById("last-vel"),
    lastCh: document.getElementById("last-ch"),
    heldCount: document.getElementById("held-count"),
    sustain: document.getElementById("sustain"),
    seenLow: document.getElementById("seen-low"),
    seenHigh: document.getElementById("seen-high"),
    latency: document.getElementById("latency"),
    rangeLabel: document.getElementById("range-label"),
    btnResetRange: document.getElementById("btn-reset-range"),
    kbScroll: document.getElementById("kb-scroll"),
    keyboard: document.getElementById("keyboard"),
    btnLog: document.getElementById("btn-log"),
    filterRt: document.getElementById("filter-rt"),
    btnClear: document.getElementById("btn-clear"),
    log: document.getElementById("log")
  };

  function noteName(n) {
    if (n == null || n < 0 || n > 127) return "—";
    return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
  }
  function isBlack(n) { return !!BLACK_PC[n % 12]; }

  function hexBytes(bytes) {
    var s = [];
    for (var i = 0; i < bytes.length; i++) {
      s.push(bytes[i].toString(16).toUpperCase().padStart(2, "0"));
    }
    return s.join(" ");
  }

  function setStatus(kind, html) {
    els.status.className = "status" + (kind ? " is-" + kind : "");
    els.status.querySelector(".msg").innerHTML = html;
  }

  function midiSupported() {
    return typeof navigator.requestMIDIAccess === "function";
  }

  function isSecure() {
    return window.isSecureContext === true;
  }

  function unsupportedReason() {
    var ua = navigator.userAgent || "";
    var isiOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var parts = [];
    if (isiOS) {
      parts.push("Safari and every browser on iPhone and iPad do not support the Web MIDI API.");
    } else if (!midiSupported()) {
      parts.push("This browser does not support the Web MIDI API. Use Chrome or another Chromium browser on Android or a laptop (Chrome, Edge, Opera, or Firefox).");
    }
    if (!isSecure()) {
      parts.push("MIDI also needs a secure context: open this page over <strong>https</strong> or from <strong>localhost</strong>. A plain http IP address will not work.");
    }
    if (!parts.length) {
      parts.push("This browser cannot use MIDI. Use Chrome or another Chromium browser on Android or a laptop. Safari and iOS are not supported. The page must be served over https or localhost.");
    }
    return parts.join(" ");
  }

  /* ---------- keyboard drawing ---------- */

  function extendRangeTo(note) {
    var low = state.visibleLow;
    var high = state.visibleHigh;
    if (note < low) low = isBlack(note) ? note - 1 : note;
    if (note > high) high = isBlack(note) ? note + 1 : note;
    low = Math.max(0, low);
    high = Math.min(127, high);
    if (low !== state.visibleLow || high !== state.visibleHigh) {
      state.visibleLow = low;
      state.visibleHigh = high;
      buildKeyboard();
      return true;
    }
    return false;
  }

  function resetRange() {
    state.visibleLow = DEFAULT_LOW;
    state.visibleHigh = DEFAULT_HIGH;
    buildKeyboard();
    updateRangeLabel();
  }

  function updateRangeLabel() {
    var n = state.visibleHigh - state.visibleLow + 1;
    els.rangeLabel.textContent = "Visible " + noteName(state.visibleLow) + "–" + noteName(state.visibleHigh) + " · " + n + " keys";
    els.btnResetRange.disabled = (state.visibleLow === DEFAULT_LOW && state.visibleHigh === DEFAULT_HIGH);
  }

  function whiteNotesInRange() {
    var out = [];
    for (var n = state.visibleLow; n <= state.visibleHigh; n++) {
      if (!isBlack(n)) out.push(n);
    }
    return out;
  }

  function buildKeyboard() {
    var kb = els.keyboard;
    var whites = whiteNotesInRange();
    var whiteCount = whites.length || 1;

    kb.innerHTML = "";
    var whitesEl = document.createElement("div");
    whitesEl.className = "whites";
    var blacksEl = document.createElement("div");
    blacksEl.className = "blacks";

    // Real piano proportions: a white key is about 23.5 mm wide and 150 mm long
    // (6.4 : 1); black keys are about 58% as wide and 63% as long as a white key.
    var KEY_RATIO = 6.4;
    var minWhite = 16;
    var scrollW = els.kbScroll.clientWidth || 360;
    var inset = 4;
    var landscape = window.matchMedia("(orientation: landscape) and (max-height: 540px)").matches;
    var maxH = landscape
      ? Math.max(90, els.kbScroll.clientHeight || 140)
      : Math.max(110, Math.round(window.innerHeight * 0.45));
    var whiteW = Math.max(minWhite, (scrollW - inset * 2) / whiteCount);
    var height = whiteW * KEY_RATIO;
    if (height > maxH) {
      // Too tall for the space: shrink the whole keyboard, keeping proportion.
      height = maxH;
      whiteW = Math.max(minWhite, height / KEY_RATIO);
      height = whiteW * KEY_RATIO;
      if (height > maxH) height = maxH; // only when the min key width forces it
    }
    var width = whiteW * whiteCount;
    kb.style.width = width + "px";
    kb.style.height = Math.round(height) + "px";
    kb.style.margin = "0 auto";
    // Corner rounding scales with key width (a real key is only slightly rounded).
    kb.style.setProperty("--wr", Math.min(4, Math.max(1, whiteW * 0.08)).toFixed(1) + "px");
    kb.style.setProperty("--br", Math.min(2.5, Math.max(0.8, whiteW * 0.05)).toFixed(1) + "px");

    for (var i = 0; i < whites.length; i++) {
      var n = whites[i];
      var b = document.createElement("button");
      b.type = "button";
      b.className = "key white";
      b.dataset.note = String(n);
      b.setAttribute("aria-label", noteName(n));
      if (n % 12 === 0) {
        var oct = document.createElement("span");
        oct.className = "oct";
        oct.textContent = noteName(n);
        b.appendChild(oct);
      }
      bindKey(b, n);
      whitesEl.appendChild(b);
    }

    var blackW = Math.max(8, whiteW * 0.58);
    blacksEl.style.width = width + "px";
    var whiteIndex = 0;
    for (var n = state.visibleLow; n <= state.visibleHigh; n++) {
      if (!isBlack(n)) {
        whiteIndex++;
        continue;
      }
      var b = document.createElement("button");
      b.type = "button";
      b.className = "key black";
      b.dataset.note = String(n);
      b.setAttribute("aria-label", noteName(n));
      // Center on the boundary after the preceding white key.
      var left = whiteIndex * whiteW - blackW / 2;
      b.style.width = blackW + "px";
      b.style.left = left + "px";
      bindKey(b, n);
      blacksEl.appendChild(b);
    }

    kb.appendChild(whitesEl);
    kb.appendChild(blacksEl);
    updateRangeLabel();
    refreshKeyLights();
  }

  function bindKey(el, note) {
    el.addEventListener("pointerdown", function (e) {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      noteOn(note, 100, 1, "touch");
      logMessage([0x90, note, 100], performance.now(), "touch");
    });
    function release(e) {
      e.preventDefault();
      noteOff(note, 0, 1, "touch");
      logMessage([0x80, note, 0], performance.now(), "touch");
    }
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
  }

  function keyEl(note) {
    return els.keyboard.querySelector('[data-note="' + note + '"]');
  }

  function setKeyVisual(note) {
    var el = keyEl(note);
    if (!el) return;
    var h = state.held[note];
    var sus = !!state.sustained[note];
    if (h) {
      el.classList.add("held");
      el.classList.toggle("sustained", sus);
      el.style.setProperty("--vel", String(Math.max(0.15, h.vel / 127)));
    } else {
      el.classList.remove("held");
      el.style.removeProperty("--vel");
      el.classList.toggle("sustained", sus);
    }
  }

  function refreshKeyLights() {
    var keys = els.keyboard.querySelectorAll(".key");
    for (var i = 0; i < keys.length; i++) {
      setKeyVisual(parseInt(keys[i].dataset.note, 10));
    }
    updateReadout();
  }

  function scrollNoteIntoView(note) {
    var el = keyEl(note);
    if (!el) return;
    var sc = els.kbScroll;
    var left = el.offsetLeft;
    var right = left + el.offsetWidth;
    if (el.classList.contains("black")) {
      left = parseFloat(el.style.left) || left;
      right = left + (parseFloat(el.style.width) || el.offsetWidth);
    }
    if (left < sc.scrollLeft + 8) {
      sc.scrollLeft = Math.max(0, left - 24);
    } else if (right > sc.scrollLeft + sc.clientWidth - 8) {
      sc.scrollLeft = right - sc.clientWidth + 24;
    }
  }

  /* ---------- notes / sustain ---------- */

  function noteOn(note, vel, ch, source) {
    if (note < 0 || note > 127) return;
    extendRangeTo(note);
    var entry = state.held[note] || { vel: vel, sources: {} };
    entry.vel = vel;
    entry.sources[source] = (source === "midi") ? ch : true;
    state.held[note] = entry;
    delete state.sustained[note];
    if (source === "midi") {
      state.last = { note: note, vel: vel, ch: ch, name: noteName(note) };
      if (state.seenLow == null || note < state.seenLow) state.seenLow = note;
      if (state.seenHigh == null || note > state.seenHigh) state.seenHigh = note;
    }
    setKeyVisual(note);
    scrollNoteIntoView(note);
    updateReadout();
  }

  function noteOff(note, vel, ch, source) {
    var entry = state.held[note];
    if (entry) {
      delete entry.sources[source];
      var still = false;
      for (var k in entry.sources) { if (entry.sources.hasOwnProperty(k)) still = true; }
      if (!still) {
        delete state.held[note];
        if (state.sustainOn && source === "midi") {
          state.sustained[note] = true;
        }
      }
    } else if (state.sustainOn && source === "midi") {
      state.sustained[note] = true;
    }
    setKeyVisual(note);
    updateReadout();
  }

  function setSustain(on) {
    state.sustainOn = on;
    if (!on) {
      state.sustained = {};
    }
    refreshKeyLights();
  }

  function countHeld() {
    var n = 0;
    for (var k in state.held) if (state.held.hasOwnProperty(k)) n++;
    return n;
  }

  function updateReadout() {
    if (state.last) {
      els.lastName.textContent = state.last.name;
      els.lastNum.textContent = String(state.last.note);
      els.lastVel.textContent = String(state.last.vel);
      els.lastCh.textContent = String(state.last.ch);
    }
    els.heldCount.textContent = String(countHeld());
    els.sustain.textContent = state.sustainOn ? "on" : "off";
    els.sustain.classList.toggle("on", state.sustainOn);
    els.seenLow.textContent = state.seenLow == null ? "—" : (noteName(state.seenLow) + "  (" + state.seenLow + ")");
    els.seenHigh.textContent = state.seenHigh == null ? "—" : (noteName(state.seenHigh) + "  (" + state.seenHigh + ")");
    renderLatency();
  }

  /* ---------- latency ---------- */

  function recordLatency(eventStamp) {
    var stamp = eventStamp;
    // Double rAF waits until after the update has been painted. A single rAF
    // can fire with the current frame's timestamp, which is earlier than the
    // MIDI event and would look like a negative delay.
    requestAnimationFrame(function () {
      requestAnimationFrame(function (frameTime) {
        var end = frameTime;
        if (!(end >= stamp)) end = performance.now();
        var delay = end - stamp;
        if (!isFinite(delay) || delay < 0 || delay > 2000) return;
        state.latency.push(delay);
        if (state.latency.length > LATENCY_SAMPLES) state.latency.shift();
        renderLatency();
      });
    });
  }

  function renderLatency() {
    var arr = state.latency;
    if (!arr.length) {
      els.latency.innerHTML = "On-screen delay: — <em>(estimate of visual lag, not audio)</em>";
      return;
    }
    var sum = 0, min = arr[0], max = arr[0];
    for (var i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (arr[i] < min) min = arr[i];
      if (arr[i] > max) max = arr[i];
    }
    var avg = sum / arr.length;
    var mean = avg;
    var vsum = 0;
    for (var j = 0; j < arr.length; j++) {
      var d = arr[j] - mean;
      vsum += d * d;
    }
    var jitter = Math.sqrt(vsum / arr.length);
    els.latency.innerHTML =
      "On-screen delay: <b>" + avg.toFixed(1) + " ms</b> avg" +
      " (" + min.toFixed(1) + "–" + max.toFixed(1) + ", jitter " + jitter.toFixed(1) + " ms)" +
      " <em>— estimate of visual lag, not audio</em>";
  }

  /* ---------- log ---------- */

  function decodeMessage(bytes) {
    if (!bytes || !bytes.length) return "(empty)";
    var st = bytes[0];
    if (st === 0xF8) return "Clock";
    if (st === 0xFA) return "Start";
    if (st === 0xFB) return "Continue";
    if (st === 0xFC) return "Stop";
    if (st === 0xFE) return "Active sensing";
    if (st === 0xFF) return "System reset";
    if (st === 0xF0) return "SysEx (" + bytes.length + " bytes)";
    if (st === 0xF1) return "MTC quarter frame";
    if (st === 0xF2) return "Song position";
    if (st === 0xF3) return "Song select";
    if (st === 0xF6) return "Tune request";
    var type = st & 0xF0;
    var ch = (st & 0x0F) + 1;
    var d1 = bytes.length > 1 ? bytes[1] : 0;
    var d2 = bytes.length > 2 ? bytes[2] : 0;
    if (type === 0x90) {
      if (d2 === 0) return "Note off " + noteName(d1) + " (" + d1 + ") vel 0 ch " + ch;
      return "Note on " + noteName(d1) + " (" + d1 + ") vel " + d2 + " ch " + ch;
    }
    if (type === 0x80) return "Note off " + noteName(d1) + " (" + d1 + ") vel " + d2 + " ch " + ch;
    if (type === 0xA0) return "Poly aftertouch " + noteName(d1) + " (" + d1 + ") " + d2 + " ch " + ch;
    if (type === 0xB0) {
      var ccName = (d1 === 64) ? "Sustain" : ("CC " + d1);
      return ccName + " " + d2 + " ch " + ch;
    }
    if (type === 0xC0) return "Program change " + d1 + " ch " + ch;
    if (type === 0xD0) return "Channel aftertouch " + d1 + " ch " + ch;
    if (type === 0xE0) {
      var bend = (d2 << 7) | d1;
      return "Pitch bend " + bend + " ch " + ch;
    }
    return "Status 0x" + st.toString(16).toUpperCase();
  }

  function isRealtimeFiltered(bytes) {
    if (!bytes.length) return false;
    var st = bytes[0];
    return st === 0xFE || st === 0xF8;
  }

  function logMessage(bytes, stamp, source) {
    if (state.filterRealtime && isRealtimeFiltered(bytes)) return;
    var row = {
      t: stamp,
      hex: hexBytes(bytes),
      decoded: decodeMessage(bytes),
      source: source || "midi"
    };
    state.log.push(row);
    if (state.log.length > MAX_LOG) state.log.shift();
    renderLog();
  }

  function renderLog() {
    if (!state.log.length) {
      els.log.innerHTML = '<div class="empty">No messages yet.</div>';
      return;
    }
    var html = "";
    // Newest first, easier on a phone.
    for (var i = state.log.length - 1; i >= 0; i--) {
      var r = state.log[i];
      var src = r.source === "touch" ? ' <span class="src-touch">touch</span>' : "";
      html += '<div class="row">' +
        '<span class="t">' + Number(r.t).toFixed(1) + "</span>  " +
        '<span class="hex">' + r.hex + "</span>  " +
        r.decoded + src +
        "</div>";
    }
    els.log.innerHTML = html;
  }

  /* ---------- incoming MIDI ---------- */

  function handleBytes(bytes, stamp, source) {
    source = source || "midi";
    if (!bytes || !bytes.length) return;
    logMessage(bytes, stamp, source);
    if (source === "midi" && !isRealtimeFiltered(bytes)) {
      recordLatency(stamp);
    }

    var st = bytes[0];
    // Real-time single-byte messages: ignore for note state.
    if (st >= 0xF8) return;

    var type, ch, data, di;
    if (st < 0x80) {
      // Running status
      if (!state.runningStatus) return;
      type = state.runningStatus & 0xF0;
      ch = (state.runningStatus & 0x0F) + 1;
      data = bytes;
      di = 0;
    } else if (st < 0xF0) {
      state.runningStatus = st;
      type = st & 0xF0;
      ch = (st & 0x0F) + 1;
      data = bytes;
      di = 1;
    } else {
      state.runningStatus = 0;
      return;
    }

    var d1 = data.length > di ? data[di] : 0;
    var d2 = data.length > di + 1 ? data[di + 1] : 0;

    if (type === 0x90) {
      if (d2 === 0) noteOff(d1, d2, ch, "midi");
      else noteOn(d1, d2, ch, "midi");
    } else if (type === 0x80) {
      noteOff(d1, d2, ch, "midi");
    } else if (type === 0xB0 && d1 === 64) {
      setSustain(d2 >= 64);
    }
  }

  function onMIDIMessage(event) {
    var arr = [];
    var d = event.data;
    for (var i = 0; i < d.length; i++) arr.push(d[i]);
    var stamp = (typeof event.timeStamp === "number") ? event.timeStamp : performance.now();
    handleBytes(arr, stamp, "midi");
  }

  /* ---------- MIDI access / devices ---------- */

  function listInputNames(access) {
    var names = [];
    if (!access) return names;
    access.inputs.forEach(function (input) {
      if (input.state === "connected") {
        names.push(input.name || input.id || "Unnamed device");
      }
    });
    return names;
  }

  function attachInputs(access) {
    access.inputs.forEach(function (input) {
      input.onmidimessage = onMIDIMessage;
    });
  }

  function updateConnectionStatus() {
    var access = state.access;
    if (!access) return;
    var names = listInputNames(access);
    if (names.length) {
      var list = names.map(function (n) { return "<strong>" + escapeHtml(n) + "</strong>"; }).join(", ");
      setStatus("ok", "Connected: " + list + ". Play a key — it should light below.");
      els.btnConnect.textContent = names.length === 1 ? "Connected · " + names[0] : "Connected · " + names.length + " devices";
      els.btnConnect.classList.add("is-connected");
      requestWakeLock();
    } else {
      setStatus("warn", "MIDI is allowed, but no input device is connected. Plug in the Garagekey Mini (or another class-compliant MIDI keyboard) and it should appear automatically.");
      els.btnConnect.textContent = "Connect MIDI Keyboard Input";
      els.btnConnect.classList.remove("is-connected");
      releaseWakeLock();
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function hookStateChange(access) {
    access.onstatechange = function (e) {
      attachInputs(access);
      updateConnectionStatus();
      var port = e && e.port;
      if (port && port.type === "input" && port.state === "disconnected") {
        // Drop stuck MIDI notes if this was the last input.
        if (listInputNames(access).length === 0) {
          var leftover = Object.keys(state.held);
          leftover.forEach(function (n) { noteOff(parseInt(n, 10), 0, 1, "midi"); });
        }
      }
    };
  }

  function requestMIDI(fromGesture) {
    if (!midiSupported() || !isSecure()) {
      setStatus("err", unsupportedReason());
      els.btnConnect.disabled = !midiSupported();
      return;
    }
    if (state.connecting) return;
    state.connecting = true;
    if (fromGesture) els.btnConnect.disabled = true;

    navigator.requestMIDIAccess({ sysex: false }).then(function (access) {
      state.connecting = false;
      els.btnConnect.disabled = false;
      state.access = access;
      attachInputs(access);
      hookStateChange(access);
      updateConnectionStatus();
    }).catch(function (err) {
      state.connecting = false;
      els.btnConnect.disabled = false;
      els.btnConnect.classList.remove("is-connected");
      els.btnConnect.textContent = "Connect MIDI Keyboard Input";
      var name = (err && err.name) || "";
      var msg = (err && err.message) || String(err);
      if (name === "NotAllowedError" || name === "SecurityError") {
        setStatus("err", "MIDI permission was denied. Tap <strong>Connect MIDI Keyboard Input</strong> and allow access when the browser asks. " + escapeHtml(msg));
      } else {
        setStatus("err", "Could not open MIDI: " + escapeHtml(name + (msg ? (": " + msg) : "")) + ". If this persists, try Chrome or another Chromium browser over https or localhost.");
      }
    });
  }

  /* ---------- wake lock ---------- */

  function requestWakeLock() {
    if (!navigator.wakeLock || typeof navigator.wakeLock.request !== "function") return;
    navigator.wakeLock.request("screen").then(function (lock) {
      state.wakeLock = lock;
      lock.addEventListener("release", function () {
        if (state.wakeLock === lock) state.wakeLock = null;
      });
    }).catch(function () { /* optional */ });
  }

  function releaseWakeLock() {
    if (state.wakeLock) {
      try { state.wakeLock.release(); } catch (e) {}
      state.wakeLock = null;
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && state.access && listInputNames(state.access).length) {
      requestWakeLock();
    }
  });

  /* ---------- UI events ---------- */

  els.btnConnect.addEventListener("click", function () {
    requestMIDI(true);
  });
  els.btnResetRange.addEventListener("click", resetRange);
  els.btnLog.addEventListener("click", function () {
    state.logOpen = !state.logOpen;
    els.log.classList.toggle("open", state.logOpen);
    els.btnLog.textContent = state.logOpen ? "Hide log" : "Show log";
  });
  els.filterRt.addEventListener("change", function () {
    state.filterRealtime = els.filterRt.checked;
  });
  els.btnClear.addEventListener("click", function () {
    state.log = [];
    renderLog();
  });

  var building = false;
  function rebuildKeyboard() {
    if (building) return;
    building = true;
    try { buildKeyboard(); } finally { building = false; }
  }
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(function () { rebuildKeyboard(); }).observe(els.kbScroll);
  } else {
    window.addEventListener("resize", rebuildKeyboard);
  }
  window.addEventListener("resize", function () {
    // Follow orientation changes even if the scrollport size report is delayed.
    requestAnimationFrame(rebuildKeyboard);
  });

  /* ---------- test hook ---------- */

  window.__pfTest = {
    feed: function (bytes, timeStamp) {
      var arr = Array.prototype.slice.call(bytes);
      var stamp = (typeof timeStamp === "number") ? timeStamp : performance.now();
      handleBytes(arr, stamp, "midi");
    },
    getState: function () {
      var held = {};
      for (var k in state.held) if (state.held.hasOwnProperty(k)) {
        held[k] = { vel: state.held[k].vel, sources: Object.keys(state.held[k].sources) };
      }
      return {
        held: held,
        heldCount: countHeld(),
        last: state.last,
        seenLow: state.seenLow,
        seenHigh: state.seenHigh,
        sustainOn: state.sustainOn,
        sustained: Object.keys(state.sustained).map(Number),
        visibleLow: state.visibleLow,
        visibleHigh: state.visibleHigh,
        logLength: state.log.length,
        log: state.log.slice(),
        latencySamples: state.latency.length,
        midiSupported: midiSupported(),
        secureContext: isSecure()
      };
    }
  };

  /* ---------- boot ---------- */

  buildKeyboard();
  requestAnimationFrame(rebuildKeyboard);
  if (!midiSupported() || !isSecure()) {
    setStatus("err", unsupportedReason());
    if (!midiSupported()) els.btnConnect.disabled = true;
  } else {
    setStatus("warn", "Tap <strong>Connect MIDI Keyboard Input</strong> to allow this page to see your keyboard. A Garagekey Mini usually shows up as soon as it is plugged in over USB.");
    // Auto-try: works if permission was already granted. Must not replace the button,
    // because some browsers only grant access from a user gesture.
    requestMIDI(false);
  }
})();
