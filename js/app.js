/* A+Piano: MIDI Input Test (slice 1) */
(function () {
  "use strict";

  var NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  var BLACK_PC = { 1: true, 3: true, 6: true, 8: true, 10: true };
  var DEFAULT_LOW = 60; // C4 in the C4 = 60 convention
  var DEFAULT_HIGH = 72; // C5
  // MIDI doesn't tell a page how many keys a keyboard has. These ranges come from
  // owners' reports at the keyboard's default octave; anything else is learned from
  // the notes played and remembered on this phone by device name.
  var ASSET_VERSION = (document.currentScript && (document.currentScript.src.split("v=")[1] || "")) || "";
  // Built-in fallback; data/keyboards.json replaces it once loaded.
  var KEYBOARDS = [
    { brand: "Miditech", model: "Garagekey Mini", keys: 37, keySize: "mini", low: 48, high: 84, nameMatch: "garage\\s*key\\s*mini" }
  ];
  // Fallback key-size profiles; data/key-proportions.json replaces them once loaded.
  var KEY_PROFILES = {
    "full-size": { whiteWidthMm: 23.5, whiteLengthMm: 150, blackWidthMm: 13.7, blackLengthMm: 95, octaveWidthMm: 164.5 },
    "mini": { whiteWidthMm: 20, whiteLengthMm: 80, blackWidthMm: 8.5, blackLengthMm: 50, octaveWidthMm: 140 },
    "slim": { whiteWidthMm: 20, whiteLengthMm: 90, blackWidthMm: 9, blackLengthMm: 57, octaveWidthMm: 146 }
  };
  var KEY_MODEL_PROPS = [];
  var previewProfile = null;
  // Where a keyboard's lowest key usually sits for a given key count, when only the
  // count is known. Physical layout is standard; the octave is a starting guess that
  // slides as soon as notes are played.
  var ESTIMATE_BY_KEYS = { 25: 48, 32: 53, 37: 48, 49: 36, 61: 36, 88: 21 };
  var RANGE_STORE_KEY = "aplus.deviceRanges.v1";
  var MAX_LOG = 50;
  var LATENCY_SAMPLES = 40;

  var state = {
    access: null,
    visibleLow: DEFAULT_LOW,
    visibleHigh: DEFAULT_HIGH,
    homeLow: DEFAULT_LOW,
    homeHigh: DEFAULT_HIGH,
    rangeDevice: null,
    rangeFixed: false,
    rangeEstimated: false,
    octaveShift: 0,
    held: {},       // note -> { vel, sources: { midi: ch, touch: true } }
    sustained: {},  // notes held only by the pedal
    sustainOn: false,
    last: null,     // { note, vel, ch, name }
    seenLow: null,
    seenHigh: null,
    log: [],
    filterRealtime: true,
    logOpen: true,
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
    // Any real news shows the status line; on first load the button says it all.
    document.body.classList.remove("idle");
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
    var isAndroid = /Android/.test(ua);
    var isMac = /Macintosh|Mac OS X/.test(ua) && !isiOS;
    if (!midiSupported()) {
      // Every iPhone and iPad browser runs on Safari's engine, which has no MIDI.
      if (isiOS) return "iPhone and iPad browsers don't support MIDI.<br>Use an Android device or a computer with a non-Safari browser.";
      if (BROWSER_NAME === "Safari") return "Safari doesn't support MIDI.<br>Use another browser.";
      // A Chromium browser without MIDI is usually old or has it turned off.
      if (/^(Chrome|Edge|Brave|Opera|Vivaldi|Samsung Internet|Yandex)$/.test(BROWSER_NAME)) {
        return "MIDI isn't available in this version of " + BROWSER_NAME + ".<br>Update " + BROWSER_NAME + ", then reload this page.";
      }
      var who = BROWSER_NAME ? BROWSER_NAME + (isAndroid ? " for Android" : "") : "This browser";
      return who + " doesn't support MIDI.<br>" + (isAndroid ? "Use another browser on this device." : "Use another browser.");
    }
    if (!isSecure()) return "MIDI needs a secure (https) page.<br>Open this page with https:// at the start of the address.";
    return "This browser can't use MIDI.<br>Use another browser.";
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

  function snapLow(n) { return isBlack(n) ? n - 1 : n; }
  function snapHigh(n) { return isBlack(n) ? n + 1 : n; }

  function loadRanges() {
    try { return JSON.parse(localStorage.getItem(RANGE_STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveRanges(r) {
    try { localStorage.setItem(RANGE_STORE_KEY, JSON.stringify(r)); } catch (e) {}
  }

  function loadKeyboards() {
    if (!window.fetch) return;
    var q = "?v=" + ASSET_VERSION;
    function asJson(res) { return res && res.ok ? res.json() : null; }
    Promise.all([
      fetch("data/keyboards.json" + q).then(asJson, function () { return null; }),
      fetch("data/key-proportions.json" + q).then(asJson, function () { return null; })
    ]).then(function (pair) {
      var list = pair[0], props = pair[1];
      if (Array.isArray(list) && list.length) KEYBOARDS = list;
      if (props && props.profiles) {
        ["full-size", "mini", "slim"].forEach(function (id) {
          var src = props.profiles[id];
          if (!src) return;
          KEY_PROFILES[id] = {
            whiteWidthMm: src.whiteWidthMm,
            whiteLengthMm: src.whiteLengthMm,
            blackWidthMm: src.blackWidthMm,
            blackLengthMm: src.blackLengthMm,
            octaveWidthMm: src.octaveWidthMm
          };
        });
      }
      if (props && Array.isArray(props.models)) KEY_MODEL_PROPS = props.models;
      // If a keyboard connected before the list arrived, size it again.
      if (state.rangeDevice) { var d = state.rangeDevice; state.rangeDevice = null; applyDeviceRange([d]); }
      else buildKeyboard();
    }).catch(function () {});
  }

  function modelPropsFor(kb) {
    if (!kb) return null;
    for (var i = 0; i < KEY_MODEL_PROPS.length; i++) {
      var m = KEY_MODEL_PROPS[i];
      if (m.brand === kb.brand && m.model === kb.model) return m;
    }
    return null;
  }

  function activeKeyboard() {
    if (previewProfile) return { keySize: previewProfile };
    return state.rangeDevice ? findKeyboard(state.rangeDevice) : null;
  }

  function mergedKeyData(kb) {
    var over = previewProfile ? null : modelPropsFor(kb);
    var profileId = previewProfile || (kb && kb.keySize) || (over && over.profile) || "mini";
    var base = KEY_PROFILES[profileId] || KEY_PROFILES["full-size"];
    var p = {
      whiteWidthMm: base.whiteWidthMm,
      whiteLengthMm: base.whiteLengthMm,
      blackWidthMm: base.blackWidthMm,
      blackLengthMm: base.blackLengthMm,
      octaveWidthMm: base.octaveWidthMm,
      profile: profileId
    };
    if (over) {
      var fields = ["whiteWidthMm", "whiteLengthMm", "blackWidthMm", "blackLengthMm", "octaveWidthMm"];
      for (var i = 0; i < fields.length; i++) {
        if (over[fields[i]] != null) p[fields[i]] = over[fields[i]];
      }
      if (over.profile) p.profile = over.profile;
    }
    return p;
  }

  // Ratios for drawing. When an octave span is known, white width is that span / 7
  // (the key pitch), which matches how flush on-screen keys are laid out.
  function keyProportions(kb) {
    var p = mergedKeyData(kb);
    var pitch = p.octaveWidthMm ? p.octaveWidthMm / 7 : p.whiteWidthMm;
    return {
      profile: p.profile,
      whiteAspect: p.whiteLengthMm / pitch,
      blackWidthRatio: p.blackWidthMm / pitch,
      blackLengthRatio: p.blackLengthMm / p.whiteLengthMm
    };
  }

  function findKeyboard(name) {
    if (!name) return null;
    for (var i = 0; i < KEYBOARDS.length; i++) {
      var k = KEYBOARDS[i];
      if (!k.nameMatch) continue;
      try { if (new RegExp(k.nameMatch, "i").test(name)) return k; } catch (e) {}
    }
    return null;
  }

  function knownRange(name) {
    var k = findKeyboard(name);
    if (!k) return null;
    if (k.low != null && k.high != null) return { low: k.low, high: k.high, keys: k.keys, estimated: false };
    if (k.keys && ESTIMATE_BY_KEYS[k.keys] != null) {
      var lo = ESTIMATE_BY_KEYS[k.keys];
      return { low: lo, high: lo + whiteSpan(lo, k.keys), keys: k.keys, estimated: true };
    }
    return null;
  }

  // Semitone span covered by a run of `keys` keys starting on `low`.
  function whiteSpan(low, keys) { return keys - 1; }

  // Range to show for a device: its known range, adjusted by anything learned on this phone.
  function deviceRange(name) {
    var r = knownRange(name);
    var learned = name ? loadRanges()[name] : null;
    state.rangeEstimated = !!(r && r.estimated);
    state.rangeFixed = !!(r && !r.estimated);
    if (learned && r && r.estimated && learned.high - learned.low <= r.high - r.low) {
      // Slide the estimated window by octaves until it covers what was played.
      while (learned.low < r.low) { r.low -= 12; r.high -= 12; }
      while (learned.high > r.high) { r.low += 12; r.high += 12; }
      // Lowest and highest keys both played: the range is no longer a guess.
      if (learned.high - learned.low === r.high - r.low) { state.rangeEstimated = false; state.rangeFixed = true; }
    } else if (learned && !(r && !r.estimated)) {
      // Known ranges come from manuals and stay put; learning only fills in the rest.
      r = r ? { low: Math.min(r.low, learned.low), high: Math.max(r.high, learned.high) } : { low: learned.low, high: learned.high };
    }
    if (!r) return null;
    // Too few notes learned yet: keep at least the default octave in view.
    if (r.high - r.low < 12) r = { low: Math.min(r.low, DEFAULT_LOW), high: Math.max(r.high, DEFAULT_HIGH) };
    return { low: snapLow(r.low), high: snapHigh(r.high) };
  }

  // Slide the view by whole octaves so `note` is visible, and track the offset.
  function shiftToInclude(note) {
    var k = 0;
    if (note > state.visibleHigh) k = Math.ceil((note - state.visibleHigh) / 12);
    else if (note < state.visibleLow) k = -Math.ceil((state.visibleLow - note) / 12);
    if (!k) return false;
    var low = state.visibleLow + 12 * k, high = state.visibleHigh + 12 * k;
    if (low < 0 || high > 127) return extendRangeTo(note);
    state.octaveShift += k;
    state.visibleLow = low;
    state.visibleHigh = high;
    buildKeyboard();
    return true;
  }

  function setHomeRange(low, high) {
    state.octaveShift = 0;
    state.homeLow = low;
    state.homeHigh = high;
    state.visibleLow = low;
    state.visibleHigh = high;
    buildKeyboard();
    updateRangeLabel();
  }

  // Called when the set of connected inputs changes.
  function applyDeviceRange(names) {
    var name = names.length ? names[0] : null;
    if (name === state.rangeDevice) return;
    state.rangeDevice = name;
    var r = name ? deviceRange(name) : null;
    if (r) setHomeRange(r.low, r.high);
    else setHomeRange(DEFAULT_LOW, DEFAULT_HIGH);
  }

  function learnNote(name, note) {
    if (!name) return;
    var all = loadRanges();
    var r = all[name];
    if (!r) r = all[name] = { low: note, high: note };
    else if (note >= r.low && note <= r.high) return;
    else { r.low = Math.min(r.low, note); r.high = Math.max(r.high, note); }
    saveRanges(all);
    if (state.rangeEstimated && name === state.rangeDevice) {
      var nr = deviceRange(name);
      if (nr && (nr.low !== state.homeLow || nr.high !== state.homeHigh)) { setHomeRange(nr.low, nr.high); return; }
    }
    updateRangeLabel();
  }

  function resetRange() {
    // Forget what this phone learned for the device and go back to its starting range.
    if (state.rangeDevice) {
      var all = loadRanges();
      delete all[state.rangeDevice];
      saveRanges(all);
    }
    var r = state.rangeDevice ? deviceRange(state.rangeDevice) : null;
    if (r) setHomeRange(r.low, r.high);
    else setHomeRange(DEFAULT_LOW, DEFAULT_HIGH);
  }

  function updateRangeLabel() {
    var n = state.visibleHigh - state.visibleLow + 1;
    els.rangeLabel.textContent = "Visible " + noteName(state.visibleLow) + "–" + noteName(state.visibleHigh) + " · " + n + " keys" +
      (state.rangeEstimated && state.visibleLow === state.homeLow && state.visibleHigh === state.homeHigh ? " (estimated)" : "") +
      (state.octaveShift ? " · Octave " + (state.octaveShift > 0 ? "+" : "−") + Math.abs(state.octaveShift) : "");
    var learned = state.rangeDevice && loadRanges()[state.rangeDevice];
    els.btnResetRange.disabled = !learned && state.visibleLow === state.homeLow && state.visibleHigh === state.homeHigh;
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

    // Proportions come from data/key-proportions.json: mini before a keyboard
    // is connected, then the matched model's measurements or its key-type default.
    var prop = keyProportions(activeKeyboard());
    var KEY_RATIO = prop.whiteAspect;
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
    kb.style.setProperty("--black-len", (prop.blackLengthRatio * 100).toFixed(2) + "%");
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

    var blackW = Math.max(8, whiteW * prop.blackWidthRatio);
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
    if (source === "midi" && state.rangeFixed && state.rangeDevice) {
      // Known keyboard size: a note outside the view means the octave buttons moved.
      shiftToInclude(note);
      learnNote(state.lastDeviceName || state.rangeDevice, note - 12 * state.octaveShift);
    } else {
      extendRangeTo(note);
      if (source === "midi") learnNote(state.lastDeviceName || state.rangeDevice, note);
    }
    var entry = state.held[note] || { vel: vel, sources: {} };
    entry.vel = vel;
    entry.sources[source] = (source === "midi") ? ch : true;
    state.held[note] = entry;
    delete state.sustained[note];
    // On-screen taps count too, so the readout can be tried without a keyboard.
    state.last = { note: note, vel: vel, ch: ch, name: noteName(note) };
    if (state.seenLow == null || note < state.seenLow) state.seenLow = note;
    if (state.seenHigh == null || note > state.seenHigh) state.seenHigh = note;
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

  // Column form for the log: [event, note or controller, value, channel].
  function decodeParts(bytes) {
    if (!bytes || !bytes.length) return ["(empty)", "", "", ""];
    var st = bytes[0];
    if (st >= 0xF0) {
      var sys = decodeMessage(bytes);
      if (st === 0xF0) return ["SysEx", "", bytes.length + " B", ""];
      if (st === 0xF2 && bytes.length > 2) return ["Song pos", "", String((bytes[2] << 7) | bytes[1]), ""];
      return [sys, "", "", ""];
    }
    var type = st & 0xF0, ch = String((st & 0x0F) + 1);
    var d1 = bytes.length > 1 ? bytes[1] : 0;
    var d2 = bytes.length > 2 ? bytes[2] : 0;
    var note = noteName(d1) + " (" + d1 + ")";
    if (type === 0x90) return d2 === 0 ? ["Note on", note, "0 off", ch] : ["Note on", note, String(d2), ch];
    if (type === 0x80) return ["Note off", note, String(d2), ch];
    if (type === 0xA0) return ["Poly AT", note, String(d2), ch];
    if (type === 0xB0) return ["Control", d1 + (CC_NAMES[d1] ? " " + CC_NAMES[d1] : ""), String(d2), ch];
    if (type === 0xC0) return ["Program", String(d1), "", ch];
    if (type === 0xD0) return ["Aftertouch", "", String(d1), ch];
    if (type === 0xE0) return ["Pitch bend", "", String(((d2 << 7) | d1) - 8192), ch];
    return ["0x" + st.toString(16).toUpperCase(), "", "", ""];
  }

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
      // A note on at velocity 0 works as a note off but is a different message.
      if (d2 === 0) return "Note on " + noteName(d1) + " (" + d1 + ") vel 0 (off) ch " + ch;
      return "Note on " + noteName(d1) + " (" + d1 + ") vel " + d2 + " ch " + ch;
    }
    if (type === 0x80) return "Note off " + noteName(d1) + " (" + d1 + ") vel " + d2 + " ch " + ch;
    if (type === 0xA0) return "Poly aftertouch " + noteName(d1) + " (" + d1 + ") " + d2 + " ch " + ch;
    if (type === 0xB0) {
      var ccName = CC_NAMES[d1] ? " " + CC_NAMES[d1] : "";
      return "CC " + d1 + ccName + " " + d2 + " ch " + ch;
    }
    if (type === 0xC0) return "Program change " + d1 + " ch " + ch;
    if (type === 0xD0) return "Channel aftertouch " + d1 + " ch " + ch;
    if (type === 0xE0) {
      var bend = (d2 << 7) | d1;
      return "Pitch bend " + bend + " ch " + ch;
    }
    return "Status 0x" + st.toString(16).toUpperCase();
  }

  // Standard controller names (MIDI 1.0 spec), shown after the CC number.
  var CC_NAMES = {
    0: "Bank select", 1: "Mod wheel", 2: "Breath", 4: "Foot controller",
    5: "Portamento time", 7: "Volume", 8: "Balance", 10: "Pan", 11: "Expression",
    32: "Bank select LSB", 64: "Sustain", 65: "Portamento", 66: "Sostenuto",
    67: "Soft pedal", 68: "Legato", 120: "All sound off", 121: "Reset controllers",
    122: "Local control", 123: "All notes off"
  };

  // Gap since the previous log line, the way MIDI monitors show timing.
  function pushLog(row) {
    var prev = state.log.length ? state.log[state.log.length - 1].t : null;
    row.gap = prev === null ? null : Math.max(0, row.t - prev);
    state.log.push(row);
    if (state.log.length > MAX_LOG) state.log.shift();
    renderLog();
  }

  function fmtGap(g) {
    // Number and unit in separate spans so numbers right-align and units line up.
    var num, unit;
    if (g === null || g === undefined) return '<span class="gn">first</span><span class="gu"></span>';
    if (g >= 1000) { num = (g / 1000).toFixed(g >= 100000 ? 0 : 1); unit = "s"; }
    else { num = String(Math.round(g)); unit = "ms"; }
    return '<span class="gn">' + num + '</span><span class="gu">' + unit + "</span>";
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
      parts: decodeParts(bytes),
      source: source || "midi"
    };
    pushLog(row);
  }

  // Device connects and disconnects, shown in the log alongside messages.
  function logEvent(text) {
    pushLog({ t: performance.now(), event: text });
  }

  // Log an input only when its connected/disconnected state actually changes.
  function notePortState(port) {
    if (!port || port.type !== "input") return;
    state.portStates = state.portStates || {};
    var key = port.id || port.name;
    if (state.portStates[key] === port.state) return;
    state.portStates[key] = port.state;
    var name = port.name || port.id || "MIDI keyboard";
    logEvent((port.state === "connected" ? "Connected: " : "Disconnected: ") + name);
  }

  function cell(cls, text) {
    return '<span class="' + cls + '">' + escapeHtml(text) + "</span>";
  }

  function renderLog() {
    if (!state.log.length) {
      els.log.innerHTML = '<div class="empty">No messages yet.</div>';
      return;
    }
    // Header, then newest first (easier on a phone).
    var html = '<div class="row head">' + cell("t", "Time Gap") + cell("hex", "Bytes") +
      cell("ev", "Event") + cell("d", "Note / CC") + cell("val", "Value") + cell("c", "Ch") + "</div>";
    for (var i = state.log.length - 1; i >= 0; i--) {
      var r = state.log[i];
      if (r.event) {
        html += '<div class="row event' + (/blocked|not allowed$/.test(r.event) ? " err" : (/^Disconnected|not set$/.test(r.event) ? " off" : "")) + '">' +
          '<span class="t">' + fmtGap(r.gap) + '</span><span class="msg">' + escapeHtml(r.event) + "</span></div>";
        continue;
      }
      var p = r.parts || [r.decoded, "", "", ""];
      html += '<div class="row' + (r.source === "touch" ? " touch" : "") + '">' +
        '<span class="t">' + fmtGap(r.gap) + "</span>" +
        // On-screen taps send no MIDI bytes, so say so instead.
        (r.source === "touch" ? cell("hex", "tap") : '<span class="hex">' + r.hex + "</span>") +
        cell("ev", p[0]) + cell("d", p[1]) + cell("val", p[2]) + cell("c", p[3]) +
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
    var t = event.target || event.currentTarget;
    state.lastDeviceName = (t && t.name) || state.rangeDevice;
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

  function logNote(text) {
    try { setStatus("err", escapeHtml(text)); } catch (e) {}
  }

  function attachInputs(access) {
    access.inputs.forEach(function (input) {
      input.onmidimessage = onMIDIMessage;
      // Some Android browsers don't open the port just from setting the handler.
      if (input.open && input.connection !== "open") {
        input.open().catch(function (e) { logNote("Could not open " + (input.name || "input") + ": " + (e && e.message || e)); });
      }
    });
  }

  function updateConnectionStatus() {
    var access = state.access;
    if (!access) return;
    var names = listInputNames(access);
    applyDeviceRange(names);
    if (names.length) {
      var list = names.map(function (n) { return "<strong>" + escapeHtml(n) + "</strong>"; }).join(", ");
      var kb = names.length === 1 ? findKeyboard(names[0]) : null;
      setStatus("ok", "Connected: " + list + (kb && kb.keys ? " · " + kb.keys + " keys" : ""));
      document.body.classList.add("is-connected");
      els.btnConnect.textContent = names.length === 1 ? "Connected · " + names[0] : "Connected · " + names.length + " devices";
      els.btnConnect.classList.add("is-connected");
      requestWakeLock();
    } else {
      setStatus("warn", "No MIDI keyboard found.<br>Connect a MIDI keyboard with a USB cable.");
      document.body.classList.remove("is-connected");
      els.btnConnect.textContent = "Tap to connect MIDI keyboard";
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
      notePortState(e && e.port);
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
      // Keep the button tappable so a tap always explains what's wrong.
      setStatus("err", unsupportedReason());
      return;
    }
    // A tap always gets its own request. An earlier automatic request can hang
    // forever on some Android browsers, so it must never block a tap.
    if (!fromGesture && state.connecting) return;
    state.connecting = true;
    var attempt = (state.attempt = (state.attempt || 0) + 1);
    if (fromGesture) {
      els.btnConnect.textContent = "Asking the browser…";
      setStatus("warn", "Waiting for permission. Tap <strong>Allow</strong> if asked.");
      setTimeout(function () {
        if (state.attempt === attempt && state.connecting && !state.access) {
          els.btnConnect.textContent = "Tap to connect MIDI keyboard";
          setStatus("err", "No answer from the browser. Check its site permissions for MIDI, then tap again. Some browsers turn MIDI off.");
        }
      }, 8000);
    }

    var p;
    try {
      p = navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(function (access) {
      state.connecting = false;
      state.access = access;
      notePermission("granted");
      // Plugging and unplugging are picked up automatically from here on,
      // so the Connect button has nothing left to do.
      document.body.classList.add("has-access");
      access.inputs.forEach(function (input) { notePortState(input); });
      attachInputs(access);
      hookStateChange(access);
      updateConnectionStatus();
    }).catch(function (err) {
      state.connecting = false;
      if (!fromGesture) return; // a silent auto-try failing is not news
      els.btnConnect.classList.remove("is-connected");
      els.btnConnect.textContent = "Tap to connect MIDI keyboard";
      var name = (err && err.name) || "";
      var msg = (err && err.message) || String(err);
      if (name === "NotAllowedError" || name === "SecurityError") {
        notePermission("denied");
        showBlocked();
      } else {
        setStatus("err", "Couldn't open MIDI: " + escapeHtml(name + (msg ? (": " + msg) : "")) + ".");
      }
    });
  }

  // Tapping can't undo a block, so hide the button and say where to fix it.
  function showBlocked() {
    document.body.classList.add("blocked");
    els.btnConnect.textContent = "Tap to connect MIDI keyboard";
    setStatus("err", "MIDI permission is " + DENIED_WORD + " for this site.<br>Allow MIDI in " + BROWSER_POSSESSIVE + " site settings.");
  }

  // React to the MIDI permission: connect when it is (or becomes) granted,
  // explain when it is blocked, and offer the button again if it is reset.
  // Driven by the permission's change event, plus a re-check when the page
  // becomes visible again (coming back from settings), for browsers that
  // don't fire the change event. No polling.
  // Let go of MIDI completely, e.g. after the site's MIDI setting was removed
  // or blocked. The page then behaves as on a first visit.
  function dropAccess(reason) {
    var access = state.access;
    if (!access) return;
    access.onstatechange = null;
    access.inputs.forEach(function (input) {
      input.onmidimessage = null;
      if (input.close) { try { input.close(); } catch (e) {} }
    });
    Object.keys(state.held).forEach(function (n) { noteOff(parseInt(n, 10), 0, 1, "midi"); });
    state.access = null;
    state.portStates = {};
    document.body.classList.remove("has-access", "is-connected");
    els.btnConnect.classList.remove("is-connected");
    releaseWakeLock();
    if (reason) logEvent(reason);
  }

  function showFirstVisit() {
    document.body.classList.remove("blocked");
    els.btnConnect.textContent = "Tap to connect MIDI keyboard";
    document.body.classList.add("idle");
  }

  var BROWSER_NAME = (function () {
    if (navigator.brave && typeof navigator.brave.isBrave === "function") return "Brave";
    var ua = navigator.userAgent || "";
    var checks = [
      [/SamsungBrowser\//, "Samsung Internet"],
      [/EdgA?\/|EdgiOS\//, "Edge"],
      [/OPR\/|OPT\/|Opera/, "Opera"],
      [/Vivaldi\//, "Vivaldi"],
      [/YaBrowser\//, "Yandex"],
      [/DuckDuckGo\//, "DuckDuckGo"],
      [/Firefox\/|FxiOS\//, "Firefox"],
      [/Chrome\/|CriOS\//, "Chrome"],
      [/Safari\//, "Safari"]
    ];
    for (var i = 0; i < checks.length; i++) if (checks[i][0].test(ua)) return checks[i][1];
    return "";
  })();
  var BROWSER_POSSESSIVE = BROWSER_NAME ? BROWSER_NAME + "'s" : "the browser's";
  // Chromium browsers (Chrome 144+ on Android, desktop Page Info since ~94, and
  // Brave, Edge, Samsung Internet, Opera, Vivaldi) label a denied site
  // "Not allowed". Firefox still says "Blocked".
  var DENIED_WORD = BROWSER_NAME === "Firefox" ? "blocked" : "not allowed";

  var PERM_TEXT = {
    granted: "MIDI permission: allowed",
    denied: "MIDI permission: " + DENIED_WORD,
    prompt: "MIDI permission: not set"
  };

  // Log the permission only when it actually changes (the first reading counts).
  function notePermission(permState) {
    if (!PERM_TEXT[permState] || state.permState === permState) return;
    state.permState = permState;
    logEvent(PERM_TEXT[permState]);
  }

  function applyPermission(permState) {
    notePermission(permState);
    if (permState === "granted") {
      document.body.classList.remove("blocked");
      if (!state.access) requestMIDI(false);
    } else if (permState === "denied") {
      dropAccess();
      showBlocked();
    } else if (permState === "prompt") {
      // The setting was removed: start over with the connect button.
      if (state.access || document.body.classList.contains("blocked")) {
        dropAccess();
        showFirstVisit();
      }
    }
  }

  function checkPermission() {
    if (!navigator.permissions || !navigator.permissions.query) return;
    navigator.permissions.query({ name: "midi", sysex: false }).then(function (res) {
      if (!res) return;
      applyPermission(res.state);
      if (!state.permWatch) {
        state.permWatch = res;
        var onChange = function () { applyPermission(res.state); };
        if (res.addEventListener) res.addEventListener("change", onChange);
        else res.onchange = onChange;
      }
    }).catch(function () { /* unknown permission name: wait for a tap */ });
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
    if (document.visibilityState === "visible") checkPermission();
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
    event: function (text) { logEvent(text); },
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
        secureContext: isSecure(),
        keyProportions: keyProportions(activeKeyboard())
      };
    },
    previewProfile: function (id) {
      previewProfile = id || null;
      buildKeyboard();
    }
  };

  /* ---------- stable slot widths ----------
     Each readout slot is sized to the widest value it can ever show,
     measured in the font actually on screen, so neighbours never shift. */
  function fitSlots() {
    var nameEl = document.getElementById("last-name");
    if (nameEl) nameEl.style.fontSize = "";
    measureSlots();
    // On narrow screens, shrink the big note name until the Now card fits.
    var card = document.querySelector(".now-card");
    if (!card || !nameEl) return;
    var size = parseFloat(getComputedStyle(nameEl).fontSize), floor = size * 0.5;
    while (card.scrollWidth > card.clientWidth + 1 && size > floor) {
      size -= 2;
      nameEl.style.fontSize = size + "px";
      measureSlots();
    }
  }

  function measureSlots() {
    var names = [], nums = [], ranges = [], chans = [];
    for (var n = 0; n < 128; n++) {
      names.push(noteName(n));
      nums.push(String(n));
      ranges.push(noteName(n) + " (" + n + ")");
    }
    for (var c = 1; c <= 16; c++) chans.push(String(c));
    var slots = [
      ["last-name", names, "width"],
      ["last-num", nums], ["last-vel", nums], ["held-count", nums],
      ["seen-low", ranges], ["seen-high", ranges],
      ["last-ch", chans], ["sustain", ["on", "off"]]
    ];
    slots.forEach(function (s) {
      var el = document.getElementById(s[0]);
      if (!el) return;
      var prop = s[2] || "minWidth", keep = el.textContent;
      el.style.width = ""; el.style.minWidth = "";
      // Inline spans ignore widths, so they become inline-blocks for good.
      if (getComputedStyle(el).display === "inline") el.style.display = "inline-block";
      var w = 0;
      s[1].forEach(function (t) {
        el.textContent = t;
        w = Math.max(w, el.getBoundingClientRect().width);
      });
      el.textContent = keep;
      el.style[prop] = Math.ceil(w) + "px";
    });
  }

  /* ---------- boot ---------- */

  buildKeyboard();
  requestAnimationFrame(rebuildKeyboard);
  fitSlots();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitSlots);
  window.addEventListener("resize", fitSlots);
  if (!midiSupported() || !isSecure()) {
    setStatus("err", unsupportedReason());
    // Tapping can't help in a browser without MIDI.
    if (!midiSupported()) document.body.classList.add("no-midi");
  } else {
    // Nothing to report yet: the button alone invites the tap.
    document.body.classList.add("idle");
    loadKeyboards();
    checkPermission();
  }
})();
