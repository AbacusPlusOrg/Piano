/* A+Piano: MIDI Input Test (slice 1) */
(function () {
  "use strict";

  var NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  var BLACK_PC = { 1: true, 3: true, 6: true, 8: true, 10: true };
  var DEFAULT_LOW = 48; // C3 in the C4 = 60 convention (two octaves, middle C centered)
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
  var PANE_STORE_KEY = "aplus.pane.v1";
  var SOUND_STORE_KEY = "aplus.sound.v1";
  var DEFAULT_SOUND_VOLUME = 0.7;
  var SOUND_PROFILES = {
    "small-speaker": {
      label: "Small speaker",
      boostDb: 6, boostEnd: 72, shelfHz: 200,
      harmonics: [0.3, 0.18, 0.1],
      highpassHz: 120,
      compressor: { threshold: -18, knee: 12, ratio: 2.4, attack: 0.004, release: 0.16 },
      peak: 0.12
    },
    "full-range": {
      label: "Full range",
      boostDb: 2, boostEnd: 84, shelfHz: 180,
      harmonics: [0.16, 0, 0],
      highpassHz: 0,
      compressor: { threshold: -24, knee: 16, ratio: 1.8, attack: 0.008, release: 0.2 },
      peak: 0.15
    }
  };
  var PANE_IDS = ["stats", "log", "help"];
  var MAX_LOG = 50;
  var LATENCY_SAMPLES = 40;
  var MIDI_CHECK_TIMEOUT = 3000;

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
    pane: "stats",
    runningStatus: 0,
    latency: [],
    wakeLock: null,
    connecting: false
  };

  var els = {
    status: document.getElementById("status"),
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
    filterRt: document.getElementById("filter-rt"),
    btnClear: document.getElementById("btn-clear"),
    log: document.getElementById("log"),
    paneSwitch: document.getElementById("pane-switch"),
    paneStage: document.getElementById("pane-stage"),
    panelStats: document.getElementById("panel-stats"),
    panelLog: document.getElementById("panel-log"),
    panelHelp: document.getElementById("panel-help"),
    debugPanel: document.getElementById("debug-panel"),
    debugSummary: document.getElementById("debug-summary"),
    debugBody: document.getElementById("debug-body"),
    btnDebugScan: document.getElementById("btn-debug-scan"),
    btnDebugCopy: document.getElementById("btn-debug-copy"),
    soundControls: document.getElementById("sound-controls"),
    btnSound: document.getElementById("btn-sound"),
    soundVolume: document.getElementById("sound-volume")
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

  var statusRetry = false;
  var bootDecided = false;
  var bootTimer = null;
  function markBootDecided() {
    bootDecided = true;
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  }
  function clearConnectAction() {
    els.status.removeAttribute("tabindex");
    els.status.removeAttribute("aria-label");
    els.status.setAttribute("role", "status");
  }
  function showConnect() {
    // The status box itself becomes the connect control; same slot, same height.
    document.body.classList.remove("blocked");
    statusRetry = false;
    clearConnectAction();
    els.status.className = "status is-connect";
    els.status.querySelector(".msg").textContent = "Tap to connect MIDI keyboard";
    els.status.setAttribute("role", "button");
    els.status.setAttribute("tabindex", "0");
    els.status.setAttribute("aria-label", "Tap to connect MIDI keyboard");
    els.status.style.cursor = "pointer";
    syncPlayMidi();
  }
  function isConnectAction() {
    return els.status.classList.contains("is-connect");
  }
  function setStatus(kind, html, retry) {
    // Any real news uses this same box (not a second button).
    statusRetry = !!retry;
    var className = "status" + (kind ? " is-" + kind : "") + (statusRetry ? " is-retry" : "");
    var msg = els.status.querySelector(".msg");
    var cursor = statusRetry ? "pointer" : "";
    // Re-setting the same HTML would rebuild the node and can flicker the
    // message (or restart the scan-link) during silent auto-detect polls.
    if (els.status.className === className && msg && msg.innerHTML === html) {
      els.status.style.cursor = cursor;
      syncPlayMidi();
      return;
    }
    clearConnectAction();
    els.status.className = className;
    msg.innerHTML = html;
    els.status.style.cursor = cursor;
    syncPlayMidi();
  }

  // Compact Play-sheet line, driven by the same status box (no separate MIDI path).
  function syncPlayMidi() {
    var msg = document.getElementById("play-midi-msg");
    var btn = document.getElementById("play-midi-connect");
    var src = els.status && els.status.querySelector(".msg");
    if (!msg || !btn || !src) return;
    if (isConnectAction()) {
      msg.textContent = "No keyboard connected";
      btn.hidden = false;
    } else {
      msg.innerHTML = src.innerHTML;
      btn.hidden = !statusRetry;
    }
  }

  function midiSupported() {
    return typeof navigator.requestMIDIAccess === "function";
  }

  // In the A+Piano Android app, native MIDI arrives through window.AplusNative.
  // Present it as a minimal MIDIAccess so the browser code below runs unchanged.
  if (window.AplusNative) {
    var nativeAccess = { inputs: new Map(), onstatechange: null };
    // devices: [{id, name}] of every open keyboard; fires statechange per change.
    window.aplusMidiDevices = function (devices) {
      var ids = devices.map(function (d) { return String(d.id); });
      var changed = [];
      nativeAccess.inputs.forEach(function (port, id) {
        if (ids.indexOf(id) < 0) {
          port.state = "disconnected";
          nativeAccess.inputs.delete(id);
          changed.push(port);
        }
      });
      devices.forEach(function (d) {
        var id = String(d.id);
        if (nativeAccess.inputs.has(id)) return;
        var port = { id: id, name: d.name, type: "input", state: "connected", connection: "open", onmidimessage: null };
        nativeAccess.inputs.set(id, port);
        changed.push(port);
      });
      changed.forEach(function (port) {
        if (nativeAccess.onstatechange) nativeAccess.onstatechange({ port: port });
      });
      if (debugState.open) renderDebug(); // the app also calls this when only its own log changed
    };
    window.aplusMidiMessage = function (id, bytes) {
      var port = nativeAccess.inputs.get(String(id));
      if (port && port.onmidimessage) port.onmidimessage({ data: bytes, target: port, timeStamp: performance.now() });
    };
    navigator.requestMIDIAccess = function () {
      try {
        window.aplusMidiDevices(JSON.parse(window.AplusNative.inputs()));
      } catch (e) {
        return Promise.reject(e);
      }
      return Promise.resolve(nativeAccess);
    };
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
      if (isiOS) return "iPhone and iPad can't use MIDI.<br>Use an Android device or a computer.";
      if (BROWSER_NAME === "Safari") return "Safari doesn't support MIDI.<br>Use another browser.";
      // A Chromium browser without MIDI is usually old or has it turned off.
      if (/^(Chrome|Edge|Brave|Opera|Vivaldi|Samsung Internet|Yandex)$/.test(BROWSER_NAME)) {
        return "MIDI isn't available in this version of " + BROWSER_NAME + ".<br>Update " + BROWSER_NAME + ", then reload this page.";
      }
      var who = BROWSER_NAME ? BROWSER_NAME + (isAndroid ? " for Android" : "") : "This browser";
      return who + " doesn't support MIDI.<br>" + (isAndroid ? "Use another browser on this device." : "Use another browser.");
    }
    if (!isSecure()) return "MIDI needs a secure (https) page.<br>Open this page at an https:// address.";
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
    // Too few notes learned yet: keep at least the default two octaves in view.
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
    els.rangeLabel.textContent = noteName(state.visibleLow) + "–" + noteName(state.visibleHigh) + " · " + n + " keys" +
      (state.rangeEstimated && state.visibleLow === state.homeLow && state.visibleHigh === state.homeHigh ? " (estimated)" : "") +
      (state.octaveShift ? " · Octave " + (state.octaveShift > 0 ? "+" : "−") + Math.abs(state.octaveShift) : "");
    var learned = state.rangeDevice && loadRanges()[state.rangeDevice];
    els.btnResetRange.disabled = !learned && state.visibleLow === state.homeLow && state.visibleHigh === state.homeHigh;
  }

  function displayedRange() {
    if (play && document.body.classList.contains("mode-play") && play.rangeLow != null && play.rangeHigh != null) {
      return { low: play.rangeLow, high: play.rangeHigh };
    }
    return { low: state.visibleLow, high: state.visibleHigh };
  }

  function whiteNotesInRange() {
    var out = [], r = displayedRange();
    for (var n = r.low; n <= r.high; n++) {
      if (!isBlack(n)) out.push(n);
    }
    return out;
  }

  // Play keys that fill availW and show keyH tall on screen. Keys filling the width
  // at the front edge show ratio * availW / count * cos(tilt) tall (the perspective
  // widening cancels out), so solve for the tilt, up to the max; past that, shorten
  // the keys. Never fewer or more keys, never narrower.
  function playKeyFit(availW, whiteCount, keyH) {
    var unit = availW / Math.max(1, whiteCount);
    var flat = PLAY_KEY_RATIO * unit;
    if (!(flat > keyH + 0.5)) return { tilt: 0, ratio: PLAY_KEY_RATIO }; // within half a pixel: flat
    var deg = Math.ceil(Math.acos(Math.max(0, keyH) / flat) * 1800 / Math.PI) / 10;
    if (deg <= PLAY_TILT_MAX_DEG) return { tilt: deg, ratio: PLAY_KEY_RATIO };
    return { tilt: PLAY_TILT_MAX_DEG, ratio: keyH / (unit * Math.cos(PLAY_TILT_MAX_DEG * Math.PI / 180)) };
  }
  // Key height choices on screen: from a small strip up to flat full-width keys,
  // never more than PLAY_KEY_MAX of the screen.
  function playKeyHeightRange(availW, whiteCount, viewH) {
    var flat = PLAY_KEY_RATIO * availW / Math.max(1, whiteCount);
    var max = Math.min(flat, viewH * PLAY_KEY_MAX);
    var min = Math.min(max, Math.max(PLAY_KEY_MIN_PX, viewH * PLAY_KEY_MIN));
    return { min: min, max: max };
  }
  var playTiltDeg = 0;
  var playKeyH = { now: 0, min: 0, max: 0, view: 0, land: false };
  function placeKeyHeightHandle() {
    var h = document.getElementById("key-height");
    if (!h) return;
    var k = playKeyH, pct = function (v) { return Math.round(v / k.view * 100); };
    var wrap = h.parentElement.getBoundingClientRect();
    var top = els.keyboard.getBoundingClientRect().top - wrap.top;
    h.style.top = Math.round(top - h.offsetHeight - 2) + "px";
    h.setAttribute("aria-valuemin", String(pct(k.min)));
    h.setAttribute("aria-valuemax", String(pct(k.max)));
    h.setAttribute("aria-valuenow", String(pct(k.now)));
    h.setAttribute("aria-valuetext", pct(k.now) + "% of the screen");
  }
  function playKeyPref(land) {
    try {
      var v = JSON.parse(localStorage.getItem(KEY_HEIGHT_STORE_KEY) || "{}")[land ? "land" : "port"];
      return typeof v === "number" && v > 0 && v < 1 ? v : null;
    } catch (e) { return null; }
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
    var playMode = document.body.classList.contains("mode-play");
    var blackLen = prop.blackLengthRatio;
    var maxH;
    if (playMode) {
      // Play: fill the width for the song's range with real-looking keys
      // (white key length 4.5x its width, black keys 62% as long), capped so
      // the falling notes always get most of the height.
      // The keys' top edge is where the Key height handle puts it (default:
      // the height cap); the bottom sits on the screen's bottom edge.
      blackLen = PLAY_BLACK_LEN;
      var viewH = window.innerHeight;
      var kr = playKeyHeightRange(scrollW - inset * 2, whiteCount, viewH);
      var pref = playKeyPref(landscape);
      var keyH = (pref == null ? (landscape ? PLAY_KEY_CAP_LAND : PLAY_KEY_CAP_PORT) : pref) * viewH;
      keyH = Math.max(kr.min, Math.min(kr.max, keyH));
      playKeyH = { now: keyH, min: kr.min, max: kr.max, view: viewH, land: landscape };
      var fit = playKeyFit(scrollW - inset * 2, whiteCount, keyH);
      KEY_RATIO = fit.ratio;
      maxH = Infinity;
    } else if (landscape) {
      maxH = Math.max(90, els.kbScroll.clientHeight || 140);
    } else {
      maxH = Math.max(110, Math.round(window.innerHeight * 0.45));
    }
    // Play: the top edge (at the hit line) stays put and the front edge comes
    // toward the player, about tiltK wider, so size the top to fit.
    var tiltDeg = playMode ? fit.tilt : 0;
    playTiltDeg = tiltDeg;
    var tilt = tiltDeg > 0;
    var tiltK = tilt ? 4 / (4 - Math.sin(tiltDeg * Math.PI / 180)) : 1;
    var whiteW = Math.max(minWhite, (scrollW - inset * 2) / tiltK / whiteCount);
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
    kb.classList.toggle("kb-tilt", tilt);
    kb.style.transformOrigin = tilt ? "50% 0" : "";
    kb.style.transform = tilt ? "perspective(" + Math.round(height * 4) + "px) rotateX(" + tiltDeg + "deg)" : "";
    // A transform does not change layout, so give back the height the tilt hides.
    var hidden = tilt ? Math.round(height) * (1 - Math.cos(tiltDeg * Math.PI / 180) * tiltK) : 0;
    kb.style.marginBottom = hidden > 0 ? -hidden.toFixed(1) + "px" : "";
    kb.style.setProperty("--black-len", (blackLen * 100).toFixed(2) + "%");
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
    var range = displayedRange();
    for (var n = range.low; n <= range.high; n++) {
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
    // Play, C octave, Tight and Plus one: a black key just outside either end shows as a half silhouette (not a key).
    var keysM = playMode ? playKeysMode() : "";
    if (keysM === "coctave" || keysM === "tight" || keysM === "plus") {
      [[range.low - 1, 0, "left"], [range.high + 1, width - blackW / 2, "right"]].forEach(function (e) {
        if (e[0] < 0 || e[0] > 127 || !isBlack(e[0])) return;
        var sil = document.createElement("div");
        sil.className = "key-silhouette " + e[2];
        sil.setAttribute("aria-hidden", "true");
        sil.dataset.note = String(e[0]);
        sil.style.width = blackW / 2 + "px";
        sil.style.left = e[1] + "px";
        blacksEl.appendChild(sil);
      });
    }

    kb.appendChild(whitesEl);
    kb.appendChild(blacksEl);
    if (playMode) placeKeyHeightHandle();
    updateRangeLabel();
    refreshKeyLights();
    // Re-apply Wait-mode lights and falling-note columns after any rebuild.
    if (play) {
      play.lit = "";
      if (document.body.classList.contains("mode-play")) drawHighway();
    }
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
      el.style.setProperty("--vel", String(Math.max(0.55, h.vel / 127)));
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
    soundNoteOn(note, vel);
    playKey(note);
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
    if (!state.held[note] && !state.sustained[note]) soundNoteOff(note);
  }

  function setSustain(on) {
    state.sustainOn = on;
    if (!on) {
      Object.keys(state.sustained).forEach(function (n) {
        if (!state.held[n]) soundNoteOff(parseInt(n, 10));
      });
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
    if (type === 0x90) return d2 === 0 ? ["Note off", note, "0", ch] : ["Note on", note, String(d2), ch];
    if (type === 0x80) return ["Note off", note, String(d2), ch];
    if (type === 0xA0) return ["Poly AT", note, String(d2), ch];
    if (type === 0xB0) {
      // Pedals (sustain, sostenuto, soft): 64 and up is down, below is up.
      // The controller's name goes in Event. Pedals (64 and up is down) say down or up;
      // the portamento switch says on or off.
      var ev = CC_NAMES[d1] || "Control";
      if (d1 === 64 || d1 === 66 || d1 === 67) ev += d2 >= 64 ? " down" : " up";
      else if (d1 === 65) ev += d2 >= 64 ? " on" : " off";
      return [ev, "Ctrl (" + d1 + ")", String(d2), ch];
    }
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
    0: "Bank select", 1: "Mod wheel", 2: "Breath", 4: "Foot pedal",
    5: "Porta time", 7: "Volume", 8: "Balance", 10: "Pan", 11: "Expression",
    32: "Bank sel LSB", 64: "Sustain", 65: "Portamento", 66: "Sostenuto",
    67: "Soft pedal", 68: "Legato", 120: "All sound off", 121: "Reset ctrls",
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
    if (g === null || g === undefined) return '<span class="gn gs">start</span>';
    // ms, then s, m, h, d; one decimal below 10, whole numbers above, so it stays 3 digits.
    if (g < 999.5) { num = String(Math.round(g)); unit = "ms"; }
    else {
      var steps = [[1000, "s", 60], [60000, "m", 60], [3600000, "h", 24], [86400000, "d", Infinity]];
      for (var i = 0; i < steps.length; i++) {
        var v = g / steps[i][0];
        var txt = v < 9.95 ? v.toFixed(1) : String(Math.round(v));
        if (Number(txt) < steps[i][2] || i === steps.length - 1) { num = txt; unit = steps[i][1]; break; }
      }
    }
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

  // Note / CC # cell: name and "/ number" in separate slots so the slashes line up with the header.
  function dSplit(name, num) {
    return '<span class="d split"><span class="dn">' + name + '</span><span class="dc">/ ' + num + "</span></span>";
  }
  function dCell(text) {
    var m = /^(.*) \((\d+)\)$/.exec(text || "");
    if (!m) return cell("d", text);
    return dSplit(escapeHtml(m[1]), m[2]);
  }

  function renderLog() {
    if (!state.log.length) {
      els.log.innerHTML = '<div class="empty">No messages yet.</div>';
      return;
    }
    // Header, then newest first (easier on a phone).
    var html = '<div class="row head">' + cell("t", "Delta") + dSplit("Note", "#") +
      cell("ev", "Event") + cell("val", "Value") + cell("c", "Ch") + cell("hex", "Bytes") + "</div>";
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
        dCell(p[1]) + cell("ev", p[0]) + cell("val", p[2]) + cell("c", p[3]) +
        // On-screen taps send no MIDI bytes, so say so instead.
        (r.source === "touch" ? cell("hex", "tap") : '<span class="hex">' + r.hex + "</span>") +
        "</div>";
    }
    els.log.innerHTML = html;
  }

  /* ---------- incoming MIDI ---------- */

  function handleBytes(bytes, stamp, source) {
    source = source || "midi";
    if (!bytes || !bytes.length) return;
    if (source === "midi") noteDebugMidi(bytes);
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

  var STATUS_DOTS = "<span class=\"dots\"><span>.</span><span>.</span><span>.</span></span>";
  var NO_KEYBOARD_HTML = "No MIDI keyboard detected.<br>Plug one in, or <button type=\"button\" class=\"scan-link\" aria-label=\"scan again\">scan again</button>.";
  var STATE_CHANGE_DEBOUNCE = 200;
  var SCAN_MIN_MS = 400;
  var AUTO_ENUMERATE_MS = 2000;
  var AUTO_REFRESH_EVERY = 3;
  var HIDDEN_RECONNECT_MIN_MS = 1000;
  var attachedInputs = [];
  var stateChangeTimer = null;
  var pendingStatePorts = [];
  var stateChangeHandler = null;
  var hookedAccess = null;
  var scanInFlight = false;
  var autoDetectEnabled = true;
  var autoDetectTimer = null;
  var autoDetectWakeTimer = null;
  var autoDetectCycles = 0;
  var lastAccessAt = 0;
  var hiddenAt = 0;
  var pendingReconnect = false;

  function inputKey(input) {
    return (input && (input.id || input.name)) || input;
  }

  // Bind live inputs, open ports that are connected but not yet open, and
  // drop handlers on ports that have gone. Assigning onmidimessage (instead
  // of addEventListener) so a replug cannot stack handlers.
  function syncInputs(access) {
    var seen = {};
    if (access && access.inputs) {
      access.inputs.forEach(function (input) {
        seen[inputKey(input)] = true;
        notePortState(input);
        if (input.state === "disconnected") {
          if (input.onmidimessage) input.onmidimessage = null;
          return;
        }
        if (input.onmidimessage !== onMIDIMessage) {
          input.onmidimessage = onMIDIMessage;
        }
        // Some Android browsers leave a connected port in "closed" or "pending"
        // until open() is called.
        if (input.open && input.connection !== "open") {
          input.open().then(function () {
            updateConnectionStatus();
          }).catch(function (e) {
            logEvent("Could not open " + (input.name || "input") + ": " + (e && e.message || e));
          });
        }
      });
    }
    attachedInputs.forEach(function (input) {
      if (!seen[inputKey(input)] && input.onmidimessage) {
        input.onmidimessage = null;
      }
    });
    attachedInputs = [];
    if (access && access.inputs) {
      access.inputs.forEach(function (input) {
        if (input.onmidimessage === onMIDIMessage) attachedInputs.push(input);
      });
    }
  }

  function updateConnectionStatus() {
    var access = state.access;
    if (!access) return;
    // Keep the brief Scanning… state visible for its minimum time.
    if (scanInFlight) return;
    var names = listInputNames(access);
    applyDeviceRange(names);
    if (names.length) {
      var list = names.map(function (n) { return "<strong>" + escapeHtml(n) + "</strong>"; }).join(", ");
      setStatus("ok", "Connected: " + list);
      document.body.classList.add("is-connected");
      requestWakeLock();
      autoDetectCycles = 0;
      stopAutoDetect();
    } else {
      setStatus("warn", NO_KEYBOARD_HTML);
      document.body.classList.remove("is-connected");
      releaseWakeLock();
      scheduleAutoDetect();
    }
    if (debugState.open) renderDebug();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function unhookStateChange(access) {
    if (stateChangeTimer) {
      clearTimeout(stateChangeTimer);
      stateChangeTimer = null;
    }
    pendingStatePorts = [];
    if (!access && hookedAccess) access = hookedAccess;
    if (!access) return;
    if (access.removeEventListener && stateChangeHandler) {
      try { access.removeEventListener("statechange", stateChangeHandler); } catch (e) {}
    }
    if (access.onstatechange === stateChangeHandler) access.onstatechange = null;
    if (hookedAccess === access) hookedAccess = null;
    stateChangeHandler = null;
  }

  function hookStateChange(access) {
    if (!access) return;
    if (hookedAccess === access && stateChangeHandler) return;
    if (hookedAccess) unhookStateChange(hookedAccess);
    stateChangeHandler = function (e) {
      if (e && e.port) pendingStatePorts.push(e.port);
      if (stateChangeTimer) clearTimeout(stateChangeTimer);
      // Android often fires a burst of statechange events for one plug.
      stateChangeTimer = setTimeout(function () {
        stateChangeTimer = null;
        var ports = pendingStatePorts;
        pendingStatePorts = [];
        ports.forEach(function (port) {
          notePortState(port);
          noteDebugStateChange(port);
        });
        syncInputs(access);
        updateConnectionStatus();
        var lostLast = ports.some(function (p) {
          return p && p.type === "input" && p.state === "disconnected";
        }) && listInputNames(access).length === 0;
        if (lostLast) {
          Object.keys(state.held).forEach(function (n) { noteOff(parseInt(n, 10), 0, 1, "midi"); });
        }
      }, STATE_CHANGE_DEBOUNCE);
    };
    hookedAccess = access;
    // Prefer addEventListener when the access is an EventTarget; otherwise
    // the onstatechange property. Do not hook both, or one event would run twice
    // (the debounce would still fire once, but notePortState would see duplicates).
    if (typeof access.addEventListener === "function") {
      access.addEventListener("statechange", stateChangeHandler);
    } else {
      access.onstatechange = stateChangeHandler;
    }
  }

  // Let go of an old MIDIAccess: unhook statechange, drop midimessage
  // handlers, and close ports that are not the same object on `incoming`.
  // When incoming is null (dropAccess), every port is closed.
  function detachAccess(old, incoming) {
    if (!old) return;
    unhookStateChange(old);
    var keep = {};
    if (incoming && incoming.inputs) {
      incoming.inputs.forEach(function (input) { keep[inputKey(input)] = input; });
    }
    if (old.inputs) {
      old.inputs.forEach(function (input) {
        var same = !!(incoming && keep[inputKey(input)] === input);
        if (!same) {
          if (input.onmidimessage) input.onmidimessage = null;
          if (input.close) { try { input.close(); } catch (e) {} }
        }
      });
    }
    if (incoming !== old) {
      attachedInputs = attachedInputs.filter(function (input) {
        return !!(incoming && keep[inputKey(input)] === input);
      });
    }
  }

  // Clear on-screen held / sustained keys without logging. Notes released
  // while the tab is frozen would otherwise stay lit.
  function clearHeldVisuals() {
    var notes = {};
    Object.keys(state.held).forEach(function (n) { notes[n] = true; });
    Object.keys(state.sustained).forEach(function (n) { notes[n] = true; });
    state.held = {};
    state.sustained = {};
    state.sustainOn = false;
    Object.keys(notes).forEach(function (n) { setKeyVisual(parseInt(n, 10)); });
    if (Object.keys(notes).length) updateReadout();
    silenceAll(true);
  }

  function onPageHidden() {
    if (!hiddenAt) hiddenAt = performance.now();
    stopAutoDetect();
    clearHeldVisuals();
    debugEvent("Page hidden.");
  }

  // A new MIDIAccess when the current one looks empty/stale (common on Android).
  // Goes through the same single-flight guard. Never used from the prompt state,
  // so it cannot reintroduce auto-connect before the user taps.
  function refreshMIDIAccess(reason) {
    if (midiRequest) return midiRequest;
    if (!state.access || !midiSupported() || !isSecure()) {
      return Promise.resolve(state.access);
    }
    // Never re-ask from the prompt or denied states (would skip the tap,
    // or fight a block). Auto-detect and Scan again both go through here.
    if (state.permState === "prompt" || state.permState === "denied") {
      return Promise.resolve(state.access);
    }
    var old = state.access;
    var p;
    try {
      p = navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      p = Promise.reject(e);
    }
    midiRequest = p.then(function (access) {
      midiRequest = null;
      if (state.permState === "prompt" || state.permState === "denied") {
        if (access && access !== old) detachAccess(access, null);
        return state.access;
      }
      if (!access) return old;
      if (old && old !== access) detachAccess(old, access);
      state.access = access;
      lastAccessAt = performance.now();
      document.body.classList.add("has-access");
      access.inputs.forEach(function (input) { notePortState(input); });
      hookStateChange(access);
      syncInputs(access);
      debugState.refreshCount++;
      debugState.lastRefreshReason = reason || "refresh";
      debugState.lastRefreshAt = Date.now();
      debugEvent("MIDI access refreshed (" + debugState.lastRefreshReason + ").");
      return access;
    }, function (err) {
      midiRequest = null;
      var name = (err && err.name) || "error";
      debugEvent("MIDI access refresh failed (" + name + ").");
      return old;
    });
    return midiRequest;
  }

  function scanAgain() {
    if (scanInFlight) return;
    if (!state.access) return;
    scanInFlight = true;
    setStatus("warn", "Scanning" + STATUS_DOTS);
    var started = performance.now();
    function finish() {
      var wait = Math.max(0, SCAN_MIN_MS - (performance.now() - started));
      setTimeout(function () {
        scanInFlight = false;
        if (state.access) syncInputs(state.access);
        updateConnectionStatus();
      }, wait);
    }
    syncInputs(state.access);
    if (listInputNames(state.access).length) {
      finish();
      return;
    }
    // Still none: the current MIDIAccess may be stale; ask for a fresh one.
    refreshMIDIAccess("scan again").then(finish, finish);
  }

  function clearAutoDetectTimer() {
    if (autoDetectTimer) {
      clearTimeout(autoDetectTimer);
      autoDetectTimer = null;
    }
  }

  function clearWakeTimer() {
    if (autoDetectWakeTimer) {
      clearTimeout(autoDetectWakeTimer);
      autoDetectWakeTimer = null;
    }
  }

  function stopAutoDetect() {
    clearAutoDetectTimer();
    clearWakeTimer();
  }

  // Eligible to run the silent auto-detect loop (permission already granted,
  // we hold a MIDIAccess, the tab is visible). Does not look at inputs:
  // a device can appear on the current access without a statechange, and
  // the poll still has to attach it and move to Connected.
  function autoDetectEligible() {
    if (!autoDetectEnabled) return false;
    if (document.hidden) return false;
    if (!state.access) return false;
    if (document.body.classList.contains("blocked")) return false;
    if (state.permState === "prompt" || state.permState === "denied") return false;
    if (scanInFlight) return false;
    return true;
  }

  function canAutoDetect() {
    return autoDetectEligible() && listInputNames(state.access).length === 0;
  }

  function scheduleAutoDetect() {
    clearAutoDetectTimer();
    if (!canAutoDetect()) return;
    autoDetectTimer = setTimeout(runAutoDetect, AUTO_ENUMERATE_MS);
  }

  // Cheap re-enumerate of the current MIDIAccess. Every few cycles, ask
  // for a fresh MIDIAccess in case the current one is stale (common on
  // Android). Never shows Scanning… — only a tap on scan again does that.
  function runAutoDetect() {
    autoDetectTimer = null;
    if (!autoDetectEligible()) return;
    if (listInputNames(state.access).length) {
      syncInputs(state.access);
      noteDebugPoll(listInputNames(state.access).length);
      updateConnectionStatus();
      return;
    }
    autoDetectCycles++;
    var refresh = (autoDetectCycles % AUTO_REFRESH_EVERY === 0);
    function after() {
      if (state.access) syncInputs(state.access);
      noteDebugPoll(state.access ? listInputNames(state.access).length : 0);
      updateConnectionStatus();
    }
    if (refresh) refreshMIDIAccess("auto-detect").then(after, after);
    else after();
  }

  // Tab became visible, the page was shown, the window was focused, or
  // a frozen page resumed. Coalesce that burst into one refresh.
  // After a real background (>= 1s hidden, bfcache, or Page Lifecycle
  // resume), always request a fresh MIDIAccess even if the status still
  // says Connected — Android often leaves the old access stale. A
  // trivially short hide while already connected is left alone. An
  // empty access still refreshes so auto-detect can recover. Silent:
  // never shows Scanning….
  function wakeFromBackground() {
    if (document.hidden) {
      stopAutoDetect();
      return;
    }
    clearWakeTimer();
    autoDetectWakeTimer = setTimeout(function () {
      autoDetectWakeTimer = null;
      if (document.hidden) {
        stopAutoDetect();
        return;
      }
      if (state.permState === "prompt" || state.permState === "denied") return;
      if (document.body.classList.contains("blocked")) return;
      if (scanInFlight) return;
      if (!state.access) return;

      var hiddenFor = hiddenAt ? (performance.now() - hiddenAt) : 0;
      var empty = listInputNames(state.access).length === 0;
      var needRefresh;
      if (pendingReconnect) {
        needRefresh = true;
      } else if (!hiddenAt) {
        // Initial load / focus without a hide: don't tear down a live
        // access, and don't stack a refresh on the first requestMIDI.
        needRefresh = empty && (performance.now() - lastAccessAt >= 1000);
      } else if (empty) {
        needRefresh = true;
      } else if (hiddenFor >= HIDDEN_RECONNECT_MIN_MS) {
        needRefresh = true;
      } else {
        needRefresh = false;
      }
      hiddenAt = 0;
      pendingReconnect = false;

      if (!needRefresh) {
        syncInputs(state.access);
        updateConnectionStatus();
        return;
      }
      autoDetectCycles = 0;
      refreshMIDIAccess("returned to the tab").then(function () {
        if (state.access) syncInputs(state.access);
        updateConnectionStatus();
      }, function () {
        if (state.access) updateConnectionStatus();
        else scheduleAutoDetect();
      });
    }, 50);
  }

  // Only one requestMIDIAccess may be in flight. A tap and an automatic
  // connect (permission already granted) share this promise; it is cleared
  // when the request settles so a failure can be retried.
  var midiRequest = null;
  var midiRequestHadGesture = false;

  function requestMIDI(fromGesture) {
    if (!midiSupported() || !isSecure()) {
      // Keep the button tappable so a tap always explains what's wrong.
      setStatus("err", unsupportedReason());
      return;
    }
    // Already holding a MIDIAccess: nothing to ask for.
    if (state.access) return;
    if (fromGesture) {
      midiRequestHadGesture = true;
      var attempt = (state.attempt = (state.attempt || 0) + 1);
      setStatus("warn", "Waiting for permission<span class=\"dots\"><span>.</span><span>.</span><span>.</span></span><br>Tap <strong>Allow</strong> if asked.");
      setTimeout(function () {
        if (state.attempt === attempt && state.connecting && !state.access) {
          setStatus("err", "No answer from the browser.<br><button type=\"button\" class=\"reload-link\">Reload</button> to try again.");
        }
      }, 8000);
    }
    if (midiRequest) return midiRequest;

    state.connecting = true;
    var p;
    try {
      p = navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      p = Promise.reject(e);
    }
    debugEvent("MIDI access requested.");
    midiRequest = p.then(function (access) {
      midiRequest = null;
      midiRequestHadGesture = false;
      state.connecting = false;
      state.access = access;
      lastAccessAt = performance.now();
      if (!debugState.accessAt) debugState.accessAt = Date.now();
      debugEvent("MIDI access granted.");
      notePermission("granted");
      // Plugging and unplugging are picked up automatically from here on,
      // so the Connect button has nothing left to do.
      document.body.classList.add("has-access");
      access.inputs.forEach(function (input) { notePortState(input); });
      hookStateChange(access);
      syncInputs(access);
      updateConnectionStatus();
      return access;
    }, function (err) {
      var showedGesture = midiRequestHadGesture;
      midiRequest = null;
      midiRequestHadGesture = false;
      state.connecting = false;
      var failName = (err && err.name) || "error";
      debugEvent("MIDI access failed (" + failName + ").");
      if (!showedGesture) return; // a silent auto-try failing is not news
      var name = (err && err.name) || "";
      var msg = (err && err.message) || String(err);
      if (name === "NotAllowedError" || name === "SecurityError") {
        notePermission("denied");
        showBlocked();
      } else {
        setStatus("err", "Couldn't open MIDI: " + escapeHtml(name + (msg ? (": " + msg) : "")) + ".", true);
      }
    });
    return midiRequest;
  }

  // Tapping can't undo a block, so hide the button and say where to fix it.
  function showBlocked() {
    // Tapping can't undo a block, so this is a message, not a connect control.
    document.body.classList.add("blocked");
    setStatus("err", "MIDI " + (DENIED_WORD === "blocked" ? "is blocked" : "isn't allowed") + " for this site.<br>Allow MIDI in " + BROWSER_POSSESSIVE + " site settings.");
  }

  // React to the MIDI permission: connect when it is (or becomes) granted,
  // explain when it is blocked, and offer the button again if it is reset.
  // Driven by the permission's change event, plus a re-check when the page
  // becomes visible again (coming back from settings), for browsers that
  // don't fire the change event. Permission itself is not polled.
  // Let go of MIDI completely, e.g. after the site's MIDI setting was removed
  // or blocked. The page then behaves as on a first visit.
  function dropAccess(reason) {
    stopAutoDetect();
    autoDetectCycles = 0;
    var access = state.access;
    if (!access) return;
    detachAccess(access, null);
    attachedInputs = [];
    Object.keys(state.held).forEach(function (n) { noteOff(parseInt(n, 10), 0, 1, "midi"); });
    state.access = null;
    state.portStates = {};
    document.body.classList.remove("has-access", "is-connected");
    releaseWakeLock();
    if (reason) logEvent(reason);
    debugEvent("MIDI access dropped.");
  }

  function showFirstVisit() {
    showConnect();
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
      markBootDecided();
      document.body.classList.remove("blocked");
      if (!state.access) requestMIDI(false);
    } else if (permState === "denied") {
      markBootDecided();
      dropAccess();
      showBlocked();
    } else if (permState === "prompt") {
      // A tap is needed: first visit, or the setting was cleared.
      markBootDecided();
      if (state.access || document.body.classList.contains("blocked")) dropAccess();
      showFirstVisit();
    }
  }

  function checkPermission() {
    // The Android app needs no MIDI permission.
    if (window.AplusNative) {
      applyPermission("granted");
      return;
    }
    if (!navigator.permissions || !navigator.permissions.query) {
      // Can't tell whether MIDI is already allowed: a tap is needed.
      markBootDecided();
      showFirstVisit();
      return;
    }
    navigator.permissions.query({ name: "midi", sysex: false }).then(function (res) {
      if (!res) {
        markBootDecided();
        showFirstVisit();
        return;
      }
      applyPermission(res.state);
      if (!state.permWatch) {
        state.permWatch = res;
        var onChange = function () { applyPermission(res.state); };
        if (res.addEventListener) res.addEventListener("change", onChange);
        else res.onchange = onChange;
      }
    }).catch(function () {
      // Unknown permission name: wait for a tap, don't auto-request MIDI.
      markBootDecided();
      showFirstVisit();
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
    if (document.hidden) {
      onPageHidden();
    } else {
      debugState.lastReturnAt = Date.now();
      debugEvent("Page visible.");
      checkPermission();
      wakeFromBackground();
    }
    if (document.visibilityState === "visible" && state.access && listInputNames(state.access).length) {
      requestWakeLock();
    }
  });
  window.addEventListener("pageshow", function (e) {
    if (e && e.persisted) pendingReconnect = true;
    wakeFromBackground();
  });
  window.addEventListener("focus", function () { wakeFromBackground(); });
  // Page Lifecycle API: Android often freezes the tab without a long
  // visible hidden period; resume means the access may be stale.
  document.addEventListener("freeze", function () { onPageHidden(); });
  document.addEventListener("resume", function () {
    pendingReconnect = true;
    wakeFromBackground();
  });

  /* ---------- landscape: keep the keys sized to the first screen, let the page scroll ---------- */

  var landscapeMq = window.matchMedia("(orientation: landscape) and (max-height: 540px)");
  function fitLandscapeKeys() {
    var body = document.body;
    body.style.removeProperty("--kbh");
    if (!landscapeMq.matches) return;
    body.classList.add("measuring");
    var h = document.querySelector(".kb-wrap").getBoundingClientRect().height;
    body.classList.remove("measuring");
    body.style.setProperty("--kbh", Math.round(h) + "px");
  }
  fitLandscapeKeys();
  window.addEventListener("resize", fitLandscapeKeys);
  if (landscapeMq.addEventListener) landscapeMq.addEventListener("change", fitLandscapeKeys);


  /* ---------- sound output (Web Audio, local synth, no network) ---------- */

  var audio = {
    ctx: null,
    master: null,
    chain: null,
    profile: "full-range",
    enabled: false,
    volume: DEFAULT_SOUND_VOLUME,
    voices: {},
    supported: !!(window.AudioContext || window.webkitAudioContext)
  };

  function loadSoundPref() {
    try {
      var v = JSON.parse(localStorage.getItem(SOUND_STORE_KEY) || "null");
      if (v && typeof v === "object") {
        if (typeof v.on === "boolean") audio.enabled = v.on;
        if (typeof v.volume === "number" && isFinite(v.volume)) {
          audio.volume = Math.max(0, Math.min(1, v.volume));
        }
      }
    } catch (e) {}
  }

  function saveSoundPref() {
    try {
      localStorage.setItem(SOUND_STORE_KEY, JSON.stringify({ on: audio.enabled, volume: audio.volume }));
    } catch (e) {}
  }

  function midiToFreq(n) {
    return 440 * Math.pow(2, (n - 69) / 12);
  }

  function soundProfile(id) {
    return SOUND_PROFILES[id || audio.profile] || SOUND_PROFILES["full-range"];
  }

  function detectSoundProfileId() {
    var coarse = false;
    try {
      coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    } catch (e) {}
    var w = (window.screen && screen.width) || window.innerWidth || 0;
    var h = (window.screen && screen.height) || window.innerHeight || 0;
    var shortEdge = Math.min(w, h);
    var longEdge = Math.max(w, h);
    var small = shortEdge <= 600 || (shortEdge <= 1024 && longEdge <= 1366 && longEdge / shortEdge <= 1.45);
    return (coarse || small) ? "small-speaker" : "full-range";
  }

  // Taper low-note colour to 0 between C3 and boostEnd so mid/high notes stay even.
  function fadeLow(note, end) {
    if (note >= end) return 0;
    if (note <= 48) return 1;
    var t = (note - 48) / (end - 48);
    return 1 - t * t * (3 - 2 * t);
  }

  function mixNorm(note, profile) {
    var ref = 0.72 * 0.72 + 0.58 * 0.58;
    var power = ref;
    var fade = fadeLow(note, profile.boostEnd);
    var i;
    for (i = 0; i < 3; i++) {
      var a = (profile.harmonics[i] || 0) * fade;
      power += a * a;
    }
    return Math.sqrt(ref / Math.max(power, 1e-6));
  }

  function setChainParams(chain, profile, volume) {
    if (!chain) return;
    chain.highpass.frequency.value = profile.highpassHz || 20;
    var c = profile.compressor;
    chain.compressor.threshold.value = c.threshold;
    chain.compressor.knee.value = c.knee;
    chain.compressor.ratio.value = c.ratio;
    chain.compressor.attack.value = c.attack;
    chain.compressor.release.value = c.release;
    chain.master.gain.value = volume;
  }

  function buildMasterChain(ctx, profile, dest, volume) {
    var input = ctx.createGain();
    var highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.Q.value = 0.7;
    var compressor = ctx.createDynamicsCompressor();
    var master = ctx.createGain();
    input.connect(highpass);
    highpass.connect(compressor);
    compressor.connect(master);
    master.connect(dest);
    var chain = { input: input, highpass: highpass, compressor: compressor, master: master };
    setChainParams(chain, profile, volume);
    return chain;
  }

  function applySoundProfile(id) {
    audio.profile = SOUND_PROFILES[id] ? id : detectSoundProfileId();
    setChainParams(audio.chain, soundProfile(), audio.volume);
    return audio.profile;
  }

  function refreshSoundProfile() {
    var prev = audio.profile;
    applySoundProfile(detectSoundProfileId());
    if (audio.profile !== prev && debugState.open) renderDebug();
    return audio.profile;
  }

  function ensureAudio() {
    if (!audio.supported) return null;
    applySoundProfile();
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!audio.ctx) {
      try {
        audio.ctx = new AC({ latencyHint: "interactive" });
      } catch (e) {
        try { audio.ctx = new AC(); } catch (e2) { return null; }
      }
      try {
        audio.chain = buildMasterChain(audio.ctx, soundProfile(), audio.ctx.destination, audio.volume);
        audio.master = audio.chain.master;
      } catch (e) {
        audio.ctx = null;
        audio.master = null;
        audio.chain = null;
        return null;
      }
    } else if (!audio.chain) {
      try {
        audio.chain = buildMasterChain(audio.ctx, soundProfile(), audio.ctx.destination, audio.volume);
        audio.master = audio.chain.master;
      } catch (e) {
        return audio.ctx;
      }
    }
    if (audio.ctx.state === "suspended") {
      try {
        var p = audio.ctx.resume();
        if (p && typeof p.then === "function") {
          p.then(function () {
            if (audio.enabled && audio.ctx && audio.ctx.state === "running") startHeldVoices();
          }, function () {});
        }
      } catch (e) {}
    }
    if (audio.master) {
      try { audio.master.gain.setTargetAtTime(audio.volume, audio.ctx.currentTime, 0.02); } catch (e) {
        audio.master.gain.value = audio.volume;
      }
    }
    return audio.ctx;
  }

  function stopVoice(note, immediate) {
    var voice = audio.voices[note];
    if (!voice) return;
    delete audio.voices[note];
    var ctx = audio.ctx;
    var oscs = voice.oscs || [];
    var gain = voice.gain;
    try {
      if (!ctx || immediate) {
        if (gain) gain.gain.value = 0;
        oscs.forEach(function (o) { try { o.stop(); } catch (e) {} });
        if (gain) try { gain.disconnect(); } catch (e) {}
        if (voice.filter) try { voice.filter.disconnect(); } catch (e) {}
        if (voice.shelf) try { voice.shelf.disconnect(); } catch (e) {}
        return;
      }
      var t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      var cur = gain.gain.value;
      if (!(cur > 0.0001)) cur = 0.0001;
      gain.gain.setValueAtTime(cur, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      var stopAt = t + 0.22;
      oscs.forEach(function (o) { try { o.stop(stopAt); } catch (e) {} });
      setTimeout(function () {
        try { gain.disconnect(); } catch (e) {}
        try { if (voice.filter) voice.filter.disconnect(); } catch (e) {}
        try { if (voice.shelf) voice.shelf.disconnect(); } catch (e) {}
      }, 280);
    } catch (e) {
      oscs.forEach(function (o) { try { o.stop(); } catch (err) {} });
    }
  }

  function silenceAll(suspend) {
    Object.keys(audio.voices).forEach(function (n) { stopVoice(parseInt(n, 10), true); });
    audio.voices = {};
    if (suspend && audio.ctx && audio.ctx.state === "running") {
      try { audio.ctx.suspend(); } catch (e) {}
    }
  }

  function startVoiceOn(ctx, dest, note, vel, t, profile, track) {
    var v = Math.max(0.06, Math.min(1, (vel || 0) / 127));
    var freq = midiToFreq(note);
    var filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    var cutoff = 700 + v * 4800;
    filter.frequency.setValueAtTime(cutoff, t);
    try { filter.frequency.exponentialRampToValueAtTime(Math.max(400, cutoff * 0.42), t + 0.4); } catch (e) {}
    filter.Q.value = 0.85;
    var boostDb = profile.boostDb * fadeLow(note, profile.boostEnd);
    var shelf = null;
    var tail = filter;
    if (boostDb) {
      shelf = ctx.createBiquadFilter();
      shelf.type = "lowshelf";
      shelf.frequency.value = profile.shelfHz;
      shelf.gain.value = boostDb;
      filter.connect(shelf);
      tail = shelf;
    }
    var peak = profile.peak * v * mixNorm(note, profile) * Math.pow(10, -boostDb / 20);
    var gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.008);
    try {
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.67), t + 0.06);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.3), t + 1.6);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 7.5);
    } catch (e) {}
    tail.connect(gain);
    gain.connect(dest);
    function makeOsc(type, detune, level, mul) {
      if (!level) return null;
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq * (mul || 1);
      o.detune.value = detune;
      g.gain.value = level;
      o.connect(g);
      g.connect(filter);
      o.start(t);
      return o;
    }
    var oscs = [];
    var o = makeOsc("triangle", -7, 0.72, 1);
    if (o) oscs.push(o);
    o = makeOsc("triangle", 6, 0.58, 1);
    if (o) oscs.push(o);
    var fade = fadeLow(note, profile.boostEnd);
    var h;
    for (h = 0; h < 3; h++) {
      o = makeOsc("sine", 0, (profile.harmonics[h] || 0) * fade, h + 2);
      if (o) oscs.push(o);
    }
    var voice = { oscs: oscs, gain: gain, filter: filter, shelf: shelf };
    if (track) audio.voices[note] = voice;
    return voice;
  }

  function startVoice(note, vel) {
    if (!audio.enabled) return;
    var ctx = ensureAudio();
    if (!ctx || ctx.state === "closed") return;
    // A stored "on" preference still needs a user gesture to resume.
    if (ctx.state !== "running") return;
    if (!audio.chain) return;
    stopVoice(note, true);
    startVoiceOn(ctx, audio.chain.input, note, vel, ctx.currentTime, soundProfile(), true);
  }

  function soundNoteOn(note, vel) {
    startVoice(note, vel);
  }

  function soundNoteOff(note) {
    stopVoice(note, false);
  }

  function startHeldVoices() {
    if (!audio.enabled) return;
    Object.keys(state.held).forEach(function (n) {
      var e = state.held[n];
      startVoice(parseInt(n, 10), e && e.vel != null ? e.vel : 100);
    });
    Object.keys(state.sustained).forEach(function (n) {
      if (!state.held[n]) startVoice(parseInt(n, 10), 80);
    });
  }

  function syncSoundUI() {
    if (els.btnSound) {
      els.btnSound.setAttribute("aria-pressed", audio.enabled ? "true" : "false");
      els.btnSound.setAttribute("aria-label", audio.enabled ? "Sound on." : "Sound off.");
    }
    if (els.soundVolume) {
      var pct = Math.round(audio.volume * 100);
      els.soundVolume.value = String(pct);
      els.soundVolume.setAttribute("aria-valuetext", pct + " percent.");
    }
    if (els.soundControls) {
      els.soundControls.hidden = !audio.supported;
    }
  }

  function setSoundEnabled(on) {
    audio.enabled = !!on;
    if (audio.enabled) {
      ensureAudio();
      startHeldVoices();
    } else {
      silenceAll(true);
    }
    syncSoundUI();
    saveSoundPref();
  }

  function setSoundVolume(vol) {
    audio.volume = Math.max(0, Math.min(1, vol));
    if (audio.master && audio.ctx) {
      try { audio.master.gain.setTargetAtTime(audio.volume, audio.ctx.currentTime, 0.02); }
      catch (e) { audio.master.gain.value = audio.volume; }
    }
    syncSoundUI();
    saveSoundPref();
  }

  function maybeResumeAudio() {
    if (!audio.enabled) return;
    ensureAudio();
  }

  function analyzeSoundProfile(profileId) {
    var id = SOUND_PROFILES[profileId] ? profileId : detectSoundProfileId();
    var profile = soundProfile(id);
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return Promise.reject(new Error("OfflineAudioContext is not available."));
    var sr = 44100, dur = 1, notes = [48, 60, 72], names = ["C3", "C4", "C5"];
    function stats(buffer, t0, t1) {
      var data = buffer.getChannelData(0);
      var start = Math.max(0, Math.floor(t0 * sr));
      var end = Math.min(data.length, Math.floor(t1 * sr));
      var sum = 0, peak = 0, i;
      for (i = start; i < end; i++) {
        var a = data[i] < 0 ? -data[i] : data[i];
        if (a > peak) peak = a;
        sum += data[i] * data[i];
      }
      var n = end - start;
      return { rms: n > 0 ? Math.sqrt(sum / n) : 0, peak: peak, clipped: peak >= 0.999 };
    }
    function render(noteList, velocity) {
      var ctx = new Offline(1, Math.ceil(sr * dur), sr);
      var chain = buildMasterChain(ctx, profile, ctx.destination, 1);
      var i;
      for (i = 0; i < noteList.length; i++) {
        startVoiceOn(ctx, chain.input, noteList[i], velocity, 0, profile, false);
      }
      return ctx.startRendering().then(function (buffer) {
        var mid = stats(buffer, 0.08, 0.88);
        var all = stats(buffer, 0, dur);
        return { rms: mid.rms, peak: all.peak, clipped: all.clipped };
      });
    }
    return Promise.all(notes.map(function (n) { return render([n], 100); })).then(function (parts) {
      return render([48, 52, 55, 60, 64, 67], 127).then(function (chord) {
        var levels = {}, min = Infinity, max = 0, i;
        for (i = 0; i < notes.length; i++) {
          levels[names[i]] = { midi: notes[i], rms: parts[i].rms, peak: parts[i].peak, clipped: parts[i].clipped };
          if (parts[i].rms > 0 && parts[i].rms < min) min = parts[i].rms;
          if (parts[i].rms > max) max = parts[i].rms;
        }
        var spread = (min > 0 && max > 0) ? 20 * Math.log10(max / min) : Infinity;
        return { profile: id, label: profile.label, notes: levels, spreadDb: spread, even: spread <= 3.1, chord: chord };
      });
    });
  }

  function onSoundToggle(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setSoundEnabled(!audio.enabled);
  }

  loadSoundPref();
  audio.profile = detectSoundProfileId();
  syncSoundUI();
  window.addEventListener("resize", refreshSoundProfile);
  if (els.btnSound) {
    els.btnSound.addEventListener("click", onSoundToggle);
    els.btnSound.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
  }
  if (els.soundVolume) {
    els.soundVolume.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    els.soundVolume.addEventListener("click", function (e) { e.stopPropagation(); });
    els.soundVolume.addEventListener("input", function (e) {
      e.stopPropagation();
      setSoundVolume((parseInt(els.soundVolume.value, 10) || 0) / 100);
    });
  }
  if (els.soundControls) {
    els.soundControls.addEventListener("click", function (e) { e.stopPropagation(); });
    els.soundControls.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    els.soundControls.addEventListener("keydown", function (e) { e.stopPropagation(); });
  }
  document.addEventListener("pointerdown", maybeResumeAudio, true);
  document.addEventListener("keydown", maybeResumeAudio, true);

  /* ---------- UI events ---------- */

  els.status.addEventListener("click", function (e) {
    var t = e.target;
    if (t && t.closest && t.closest(".reload-link")) {
      e.preventDefault();
      location.reload();
      return;
    }
    if (t && t.closest && t.closest(".scan-link")) {
      e.preventDefault();
      scanAgain();
      return;
    }
    if (isConnectAction() || statusRetry) requestMIDI(true);
  });
  els.status.addEventListener("keydown", function (e) {
    if (!isConnectAction()) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      requestMIDI(true);
    }
  });
  els.btnResetRange.addEventListener("click", resetRange);
  els.filterRt.addEventListener("change", function () {
    state.filterRealtime = els.filterRt.checked;
  });
  els.btnClear.addEventListener("click", function () {
    state.log = [];
    renderLog();
  });
  if (els.paneSwitch) {
    els.paneSwitch.addEventListener("click", function (e) {
      var tab = e.target && e.target.closest && e.target.closest("[role='tab']");
      if (!tab || !els.paneSwitch.contains(tab)) return;
      var id = tab.id && tab.id.indexOf("tab-") === 0 ? tab.id.slice(4) : "";
      if (id) showPane(id);
    });
    els.paneSwitch.addEventListener("keydown", onPaneSwitchKey);
  }
  if (els.btnDebugScan) {
    els.btnDebugScan.addEventListener("click", function () {
      scanAgain();
      if (debugState.open) renderDebug();
    });
  }
  if (els.btnDebugCopy) els.btnDebugCopy.addEventListener("click", copyDebugReport);
  window.addEventListener("hashchange", function () {
    if (isDebugHash()) showPane("help", { remember: false });
    else if (state.pane === "help") showPane(loadPanePref() === "help" ? "stats" : loadPanePref(), { remember: false });
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

  /* ---------- Play: falling notes onto the keys, next keys lit ---------- */

  var MODE_STORE_KEY = "aplus.mode.v1";
  var LOOKAHEAD_BEATS = 5;   // beats visible above the keys
  var PLAY_KEY_RATIO = 4.5;  // white key visible length / width (real: ~150 / 23.5 mm, front part shown)
  var PLAY_BLACK_LEN = 0.62; // black key length / white key length
  var PLAY_KEY_CAP_PORT = 0.33; // key height cap, share of viewport height
  var PLAY_KEY_CAP_LAND = 0.40;
  var FAR_SCALE = 1;         // highway far end width / near end width (1 = straight lanes)
  var PLAY_TILT_MAX_DEG = 60; // most the Play keys tilt away to fit more on screen
  var PLAY_KEY_MAX = 0.6;    // Key height handle: highest key top, share of screen height
  var PLAY_KEY_MIN = 0.1;    // lowest, share of screen height (at least PLAY_KEY_MIN_PX)
  var PLAY_KEY_MIN_PX = 48;
  var KEY_HEIGHT_STORE_KEY = "aplus.keyheight.v1";
  var LEAD_IN_BEATS = 3;     // notes fall this long before the first one reaches the keys
  var EARLY_BEATS = 0.25;    // a key pressed this close before its note still counts
  var RUNG_FILES = [["rh", "rh_midi"], ["roots", "roots_midi"], ["full", "full_midi"]];
  var play = {
    index: null, song: null, rung: null, midi: null, steps: [], step: 0, hit: {},
    beat: 0, endBeat: 0, playing: false, wait: true, rate: 1, last: 0, raf: 0, drawn: 0, sounding: {}, lit: "",
    rangeLow: null, rangeHigh: null
  };
  var pe = {
    modeKeyboard: document.getElementById("mode-keyboard"),
    modePlay: document.getElementById("mode-play"),
    song: document.getElementById("play-song"),
    rung: document.getElementById("play-rung"),
    toggle: document.getElementById("play-toggle"),
    restart: document.getElementById("play-restart"),
    wait: document.getElementById("play-wait"),
    tempo: document.getElementById("play-tempo"),
    keys: document.getElementById("play-keys"),
    tempoOut: document.getElementById("play-tempo-out"),
    canvas: document.getElementById("highway"),
    sheet: document.getElementById("play-sheet"),
    pause: document.getElementById("play-pause"),
    keyHeight: document.getElementById("key-height"),
    midiMsg: document.getElementById("play-midi-msg"),
    midiConnect: document.getElementById("play-midi-connect"),
    toTest: document.getElementById("play-to-test")
  };

  // Standard MIDI file -> { ppq, bpm, beatsPerBar, notes: [{ note, start, end }] } with times in beats.
  function parseMidi(buf) {
    var d = new DataView(buf), ppq = d.getUint16(12), ntr = d.getUint16(10), p = 14;
    var tempo = 500000, bpb = 4, raw = [];
    function vlq() { var v = 0, b; do { b = d.getUint8(p++); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; }
    for (var tr = 0; tr < ntr; tr++) {
      var end = p + 8 + d.getUint32(p + 4), t = 0, run = 0, open = {};
      p += 8;
      while (p < end) {
        t += vlq();
        var st = d.getUint8(p);
        if (st & 0x80) p++; else st = run;
        if (st === 0xff) {
          var type = d.getUint8(p++), len = vlq();
          if (type === 0x51) tempo = (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2);
          if (type === 0x58) bpb = d.getUint8(p) * 4 / Math.pow(2, d.getUint8(p + 1));
          p += len;
          continue;
        }
        if (st === 0xf0 || st === 0xf7) { p += vlq(); continue; }
        run = st;
        var hi = st & 0xf0, a = d.getUint8(p++), v = (hi === 0xc0 || hi === 0xd0) ? 0 : d.getUint8(p++);
        if (hi === 0x90 && v > 0) open[a] = t;
        else if ((hi === 0x80 || hi === 0x90) && open[a] != null) { raw.push({ note: a, start: open[a] / ppq, end: t / ppq }); delete open[a]; }
      }
      p = end;
    }
    raw.sort(function (x, y) { return x.start - y.start || x.note - y.note; });
    return { ppq: ppq, bpm: 60000000 / tempo, beatsPerBar: bpb, notes: raw };
  }

  // Play "Keys" choices for a part whose notes run lo..hi (MIDI). Ends are always white keys.
  //   tight:  the white keys that cover every note (a black end note takes its outer white neighbour);
  //   plus:   one more white key on each side (past the adjacent black key, if any);
  //   groups: whole C-D-E and F-G-A-B groups holding any note (black keys count toward their group).
  // "octave" (the default, songKeyboardRange) pads to at least an octave.
  // C octave, Tight and Plus one draw a black key just outside either end as a half silhouette (see buildKeyboard).
  function playKeyRange(lo, hi, mode) {
    var low = snapLow(lo), high = snapHigh(hi);
    if (mode === "coctave") {
      // The C at or below the lowest note to the C at or above the highest, at least one octave.
      low = lo - lo % 12;
      high = Math.max(low + 12, hi + (12 - hi % 12) % 12);
    } else if (mode === "plus") {
      low = snapLow(low - 1);
      high = snapHigh(high + 1);
    } else if (mode === "groups") {
      var pl = lo % 12, ph = hi % 12;
      low = lo - pl + (pl >= 5 ? 5 : 0);
      high = hi - ph + (ph >= 5 ? 11 : 4);
    }
    return { low: Math.max(0, low), high: Math.min(127, high) };
  }
  var PLAY_KEYS_STORE_KEY = "aplus.playkeys.v1";
  var PLAY_KEYS_MODES = ["octave", "coctave", "tight", "plus", "groups"];
  function playKeysMode() {
    try { var m = localStorage.getItem(PLAY_KEYS_STORE_KEY); return PLAY_KEYS_MODES.indexOf(m) >= 0 ? m : "octave"; }
    catch (e) { return "octave"; }
  }
  function applyPlayRange() {
    var r = play.midi ? songKeyboardRange(play.midi.notes, playKeysMode()) : null;
    play.rangeLow = r ? r.low : null;
    play.rangeHigh = r ? r.high : null;
    if (document.body.classList.contains("mode-play")) rebuildKeyboard();
  }

  // Notes that start together form one step; wait mode holds at each step until all its keys are pressed.
  // Lowest–highest notes of the current rung, snapped to white keys and
  // padded to at least an octave so a short phrase doesn't make giant keys.
  function songKeyboardRange(notes, mode) {
    if (!notes || !notes.length) return null;
    var lo = Infinity, hi = -Infinity, i, n;
    for (i = 0; i < notes.length; i++) {
      n = notes[i].note;
      if (n < lo) lo = n;
      if (n > hi) hi = n;
    }
    if (mode && mode !== "octave") return playKeyRange(lo, hi, mode);
    lo = snapLow(Math.max(0, lo));
    hi = snapHigh(Math.min(127, hi));
    if (hi - lo < 12) {
      var need = 12 - (hi - lo);
      var down = Math.floor(need / 2);
      lo = snapLow(Math.max(0, lo - down));
      hi = snapHigh(Math.min(127, hi + (need - down)));
      while (hi - lo < 12 && (lo > 0 || hi < 127)) {
        if (lo > 0) lo = snapLow(lo - 1);
        if (hi - lo < 12 && hi < 127) hi = snapHigh(hi + 1);
      }
    }
    return { low: lo, high: hi };
  }

  function buildSteps(notes) {
    var steps = [];
    notes.forEach(function (n) {
      var last = steps[steps.length - 1];
      if (last && Math.abs(last.beat - n.start) < 1e-6) last.notes.push(n.note);
      else steps.push({ beat: n.start, notes: [n.note] });
    });
    return steps;
  }

  function songUrl(id, file) { return "songs/" + id + "/" + file + "?v=" + ASSET_VERSION; }
  function fetchJson(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + " " + r.status); return r.json(); }); }

  function option(sel, value, text) {
    var o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  }

  function loadSongIndex() {
    if (play.index) return Promise.resolve(play.index);
    return fetchJson("songs/index.json?v=" + ASSET_VERSION).then(function (idx) {
      // Easiest first by the catalog's 0-10 score, then by title; no level labels.
      play.index = (idx.songs || []).slice().sort(function (x, y) {
        return (x.score - y.score) || String(x.title).localeCompare(String(y.title));
      });
      pe.song.innerHTML = "";
      play.index.forEach(function (s) { option(pe.song, s.id, s.title + " · " + s.score.toFixed(1)); });
      return selectSong(pe.song.value);
    }).catch(function (e) { logEvent("Songs failed to load: " + e.message); });
  }

  function selectSong(id) {
    return fetchJson(songUrl(id, "song.json")).then(function (song) {
      play.song = song;
      pe.rung.innerHTML = "";
      RUNG_FILES.forEach(function (rf) {
        if (!song.files[rf[1]]) return;
        // Label and the rung's highest 0-10 score across the song's phrases.
        var label = rf[0], score = 0;
        (song.phrases || []).forEach(function (ph) {
          ph.ladder.forEach(function (r) { if (r.id === rf[0]) { label = r.label; score = Math.max(score, r.score); } });
        });
        option(pe.rung, rf[0], label + " · " + score.toFixed(1));
      });
      return selectRung(pe.rung.value);
    });
  }

  function selectRung(rungId) {
    var file = RUNG_FILES.filter(function (rf) { return rf[0] === rungId; })[0];
    var name = play.song.files[file[1]];
    return fetch(songUrl(play.song.id, name)).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
      play.rung = rungId;
      play.midi = parseMidi(buf);
      play.steps = buildSteps(play.midi.notes);
      play.endBeat = play.midi.notes.reduce(function (m, n) { return Math.max(m, n.end); }, 0);
      applyPlayRange();
      restartPlay();
    });
  }

  function canResume() {
    return !!play.midi && play.step < play.steps.length && play.beat > -LEAD_IN_BEATS;
  }

  function updateStartLabel() {
    if (pe.toggle) pe.toggle.textContent = canResume() ? "Resume" : "Start";
  }

  function focusEl(el) {
    if (!el || typeof el.focus !== "function") return;
    try { el.focus({ preventScroll: true }); }
    catch (err) { el.focus(); }
  }

  function syncPlayViewport() {
    var on = document.body.classList.contains("mode-play");
    document.documentElement.classList.toggle("mode-play", on);
    if (on && window.scrollTo) window.scrollTo(0, 0);
    if (on) requestAnimationFrame(function () { drawHighway(); });
  }

  function placeSoundControls(inPlay) {
    var sound = els.soundControls;
    var sheetTools = document.getElementById("play-sheet-tools");
    var topTools = document.querySelector(".top-tools");
    var tabs = document.getElementById("mode-switch");
    var testBtn = document.getElementById("play-to-test");
    if (!sound) return;
    if (inPlay && sheetTools) {
      sheetTools.insertBefore(sound, testBtn || null);
    } else if (!inPlay && topTools && tabs) {
      topTools.insertBefore(sound, tabs);
    }
  }

  function updatePlayChrome() {
    var inPlay = document.body.classList.contains("mode-play");
    var sheetOpen = !!(inPlay && pe.sheet && !pe.sheet.hidden);
    updateStartLabel();
    syncPlayViewport();
    if (!pe.pause) return;
    if (!inPlay) {
      pe.pause.hidden = true;
    } else if (play.playing) {
      pe.pause.hidden = false;
      pe.pause.textContent = "Pause";
      pe.pause.setAttribute("aria-label", "Pause.");
    } else if (!sheetOpen) {
      pe.pause.hidden = false;
      pe.pause.textContent = "Songs";
      pe.pause.setAttribute("aria-label", "Song options.");
    } else {
      pe.pause.hidden = true;
    }
  }

  function setPlaySheet(open) {
    if (!pe.sheet) return;
    if (!document.body.classList.contains("mode-play")) open = false;
    var opening = open && pe.sheet.hidden;
    var closing = !open && !pe.sheet.hidden;
    pe.sheet.hidden = !open;
    if (pe.canvas) pe.canvas.setAttribute("aria-hidden", open ? "true" : "false");
    if (els.kbScroll) els.kbScroll.setAttribute("aria-hidden", open ? "true" : "false");
    updatePlayChrome();
    if (opening && pe.toggle) focusEl(pe.toggle);
    else if (closing && pe.pause && !pe.pause.hidden) focusEl(pe.pause);
  }

  function pausePlay() {
    if (!play.playing) return;
    setPlaying(false);
    setPlaySheet(true);
  }

  function startPlay() {
    if (play.step >= play.steps.length) restartPlay();
    setPlaying(true);
    setPlaySheet(false);
  }

  function setPlaying(on) {
    play.playing = on && !!play.midi;
    if (!play.playing) stopPlayback();
    if (play.playing && !play.raf) { play.last = performance.now(); play.raf = requestAnimationFrame(playFrame); }
    updatePlayChrome();
    drawHighway();
  }

  function restartPlay() {
    stopPlayback();
    play.beat = -LEAD_IN_BEATS;
    play.step = 0;
    play.hit = {};
    setPlaying(false);
    if (document.body.classList.contains("mode-play")) setPlaySheet(true);
  }

  function stopPlayback() {
    Object.keys(play.sounding).forEach(function (n) { if (!state.held[n]) soundNoteOff(parseInt(n, 10)); });
    play.sounding = {};
  }

  function playFrame(now) {
    play.raf = 0;
    if (!play.playing) return;
    var dt = Math.min(0.1, (now - play.last) / 1000);
    play.last = now;
    var next = play.beat + dt * play.midi.bpm / 60 * play.rate;
    var s = play.steps[play.step];
    if (play.wait) {
      if (s && next > s.beat) next = s.beat;
    } else {
      // Play through: pass steps at tempo and sound them with the shared synth (if sound is on).
      while (s && s.beat <= next) {
        s.notes.forEach(function (n) { soundNoteOn(n, 80); play.sounding[n] = true; });
        play.step++;
        s = play.steps[play.step];
      }
      play.midi.notes.forEach(function (n) {
        if (play.sounding[n.note] && n.end <= next && n.end > play.beat && !state.held[n.note]) {
          soundNoteOff(n.note);
          delete play.sounding[n.note];
        }
      });
    }
    play.beat = next;
    if (play.step >= play.steps.length && play.beat >= play.endBeat) { setPlaying(false); setPlaySheet(true); return; }
    drawHighway();
    play.raf = requestAnimationFrame(playFrame);
  }

  // Called for every note-on (MIDI or on-screen tap).
  function playKey(note) {
    if (!play.playing || !play.wait) return;
    var s = play.steps[play.step];
    if (!s || s.notes.indexOf(note) < 0 || s.beat - play.beat > EARLY_BEATS) return;
    play.hit[note] = true;
    if (s.notes.every(function (n) { return play.hit[n]; })) {
      play.step++;
      play.hit = {};
      drawHighway();
    }
  }

  function nextNotes() {
    if (!play.midi || !document.body.classList.contains("mode-play")) return [];
    var s = play.steps[play.step];
    return s ? s.notes.filter(function (n) { return !play.hit[n]; }) : [];
  }

  function lightNextKeys() {
    var want = nextNotes();
    var r = displayedRange();
    var key = want.join(",") + "|" + els.keyboard.childElementCount + r.low + "-" + r.high;
    if (key === play.lit) return;
    play.lit = key;
    var keys = els.keyboard.querySelectorAll(".key");
    for (var i = 0; i < keys.length; i++) {
      keys[i].classList.toggle("next", want.indexOf(parseInt(keys[i].dataset.note, 10)) >= 0);
    }
  }

  // Perspective: d beats ahead maps to depth z; scale 1 at the keys, FAR_SCALE at the top.
  function depthScale(d) {
    var z = Math.max(0, Math.min(LOOKAHEAD_BEATS, d)) / LOOKAHEAD_BEATS * (1 / FAR_SCALE - 1);
    return 1 / (1 + z);
  }

  // Height above the hit line for a note d beats ahead (straight down when flat).
  function depthY(d, H) {
    if (FAR_SCALE >= 1) return H * (1 - Math.max(0, Math.min(LOOKAHEAD_BEATS, d)) / LOOKAHEAD_BEATS);
    return H * (depthScale(d) - FAR_SCALE) / (1 - FAR_SCALE);
  }

  function quadPath(g, xl0, xr0, yb, xl1, xr1, yt, rad) {
    g.beginPath();
    g.moveTo((xl0 + xr0) / 2, yb);
    g.arcTo(xr0, yb, xr1, yt, rad);
    g.arcTo(xr1, yt, xl1, yt, rad);
    g.arcTo(xl1, yt, xl0, yb, rad);
    g.arcTo(xl0, yb, xr0, yb, rad);
    g.closePath();
  }

  function drawHighway() {
    var cv = pe.canvas;
    lightNextKeys();
    if (!document.body.classList.contains("mode-play")) return;
    var dpr = window.devicePixelRatio || 1;
    var r = cv.getBoundingClientRect();
    var w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    var g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    play.drawn = 0;
    var H = r.height;
    // Key columns from the live keyboard, so notes land on the keys after any scroll or resize.
    var cols = {}, edges = [];
    var keys = els.keyboard.querySelectorAll(".key");
    // Layout offsets give the keys' top edge even when the keys are tilted.
    var sr = els.kbScroll.getBoundingClientRect();
    var kbX = sr.left - r.left + els.keyboard.offsetLeft - els.kbScroll.scrollLeft;
    for (var i = 0; i < keys.length; i++) {
      var black = keys[i].classList.contains("black");
      var kx = kbX + keys[i].offsetLeft;
      cols[keys[i].dataset.note] = { x: kx, w: keys[i].offsetWidth, black: black };
      if (!black) edges.push(kx);
    }
    var nearL = Math.max(0, kbX), nearR = Math.min(r.width, kbX + els.keyboard.offsetWidth);
    var cx = (nearL + nearR) / 2;
    function xAt(x, s) { return cx + (x - cx) * s; }

    if (nearR > nearL) {
      // Lane board: a trapezoid over the keyboard that narrows toward the top.
      var board = g.createLinearGradient(0, 0, 0, H);
      board.addColorStop(0, "rgba(244, 238, 228, 0.015)");
      board.addColorStop(1, "rgba(244, 238, 228, 0.06)");
      g.fillStyle = board;
      g.beginPath();
      g.moveTo(nearL, H); g.lineTo(nearR, H);
      g.lineTo(xAt(nearR, Math.min(1, FAR_SCALE)), 0); g.lineTo(xAt(nearL, Math.min(1, FAR_SCALE)), 0);
      g.closePath(); g.fill();
      g.lineWidth = 1;
      g.strokeStyle = "rgba(244, 238, 228, 0.06)";
      g.beginPath();
      for (var e = 1; e < edges.length; e++) {
        g.moveTo(edges[e], H); g.lineTo(xAt(edges[e], Math.min(1, FAR_SCALE)), 0);
      }
      g.stroke();
      g.strokeStyle = "rgba(244, 238, 228, 0.16)";
      g.beginPath();
      g.moveTo(nearL, H); g.lineTo(xAt(nearL, Math.min(1, FAR_SCALE)), 0);
      g.moveTo(nearR, H); g.lineTo(xAt(nearR, Math.min(1, FAR_SCALE)), 0);
      g.stroke();
    }
    if (play.midi) {
      g.strokeStyle = "rgba(244, 238, 228, 0.09)";
      g.lineWidth = 1;
      g.beginPath();
      for (var bar = Math.ceil(play.beat / play.midi.beatsPerBar) * play.midi.beatsPerBar; bar <= play.beat + LOOKAHEAD_BEATS; bar += play.midi.beatsPerBar) {
        var bs = depthScale(bar - play.beat), by = Math.round(depthY(bar - play.beat, H)) + 0.5;
        g.moveTo(xAt(nearL, bs), by); g.lineTo(xAt(nearR, bs), by);
      }
      g.stroke();
      var cur = play.steps[play.step];
      g.textAlign = "center";
      play.midi.notes.forEach(function (n) {
        var c = cols[n.note];
        var d0 = n.start - play.beat, d1 = n.end - play.beat;
        if (!c || d1 < 0 || d0 > LOOKAHEAD_BEATS) return;
        var s0 = depthScale(d0), s1 = depthScale(d1);
        var yb = depthY(d0, H) - 0.5, yt = depthY(d1, H) + 1;
        if (yb - yt <= 1) return;
        var done = n.end <= play.beat;
        var isNext = cur && Math.abs(n.start - cur.beat) < 1e-6 && !play.hit[n.note];
        var xl = c.x + 1.5, xr = c.x + Math.max(4.5, c.w - 1.5);
        var xl0 = xAt(xl, s0), xr0 = xAt(xr, s0), xl1 = xAt(xl, s1), xr1 = xAt(xr, s1);
        g.globalAlpha = done ? 0.25 : (isNext ? 1 : 0.8);
        g.fillStyle = n.note < 60 ? "#b98249" : "#e0a15a";
        quadPath(g, xl0, xr0, yb, xl1, xr1, yt, Math.min(4 * s0, (xr0 - xl0) / 3, (yb - yt) / 2));
        g.fill();
        if (isNext) { g.globalAlpha = 1; g.strokeStyle = "#ffb45a"; g.lineWidth = 2; g.stroke(); }
        var fs = Math.round(Math.max(9, Math.min(12, 12 * s0)));
        if (xr0 - xl0 >= 12 && yb - yt >= fs + 6) {
          g.globalAlpha = done ? 0.35 : 1;
          g.fillStyle = "#1a120a";
          g.font = "600 " + fs + "px system-ui, sans-serif";
          g.fillText(noteName(n.note).replace(/-?\d+$/, ""), (xl0 + xr0) / 2, yb - 5);
        }
        play.drawn++;
      });
      g.globalAlpha = 1;
    }
    if (nearR > nearL) {
      // Hit line along the top of the keys.
      g.strokeStyle = "rgba(244, 238, 228, 0.32)";
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(nearL, H - 0.5); g.lineTo(nearR, H - 0.5); g.stroke();
    }
    var msg = !play.midi ? "Loading song…" : (!play.playing && play.beat <= -LEAD_IN_BEATS ? "Press Start." :
      (!play.playing && play.step >= play.steps.length ? "Done. Press Start to play again." : ""));
    if (msg) {
      g.fillStyle = "#b5a89a";
      g.font = "500 14px system-ui, sans-serif";
      g.textAlign = "center";
      g.fillText(msg, r.width / 2, Math.round(H / 2));
    }
  }

  function setMode(mode, remember) {
    var on = mode === "play";
    document.body.classList.toggle("mode-play", on);
    document.documentElement.classList.toggle("mode-play", on);
    placeSoundControls(on);
    if (on && window.scrollTo) window.scrollTo(0, 0);
    pe.modeKeyboard.setAttribute("aria-selected", on ? "false" : "true");
    pe.modePlay.setAttribute("aria-selected", on ? "true" : "false");
    pe.modeKeyboard.tabIndex = on ? -1 : 0;
    pe.modePlay.tabIndex = on ? 0 : -1;
    if (remember !== false) { try { localStorage.setItem(MODE_STORE_KEY, mode); } catch (e) {} }
    if (!on) { setPlaying(false); setPlaySheet(false); }
    fitLandscapeKeys();
    rebuildKeyboard();
    if (on) { loadSongIndex(); setPlaySheet(true); }
    drawHighway();
  }

  pe.modeKeyboard.addEventListener("click", function () { setMode("keyboard"); });
  pe.modePlay.addEventListener("click", function () { setMode("play"); });
  if (pe.toTest) pe.toTest.addEventListener("click", function () { setMode("keyboard"); });
  pe.song.addEventListener("change", function () { selectSong(pe.song.value); });
  pe.rung.addEventListener("change", function () { selectRung(pe.rung.value); });
  pe.toggle.addEventListener("click", startPlay);
  pe.restart.addEventListener("click", restartPlay);
  // Key height handle: drag or arrow keys set where the keys' top edge sits.
  function setKeyHeight(px) {
    var k = playKeyH;
    if (!k.view) return;
    var v = Math.max(k.min, Math.min(k.max, px));
    try {
      var all = JSON.parse(localStorage.getItem(KEY_HEIGHT_STORE_KEY) || "{}");
      all[k.land ? "land" : "port"] = +(v / k.view).toFixed(4);
      localStorage.setItem(KEY_HEIGHT_STORE_KEY, JSON.stringify(all));
    } catch (e) {}
    rebuildKeyboard();
  }
  if (pe.keyHeight) {
    var khDrag = null, khRaf = 0;
    pe.keyHeight.addEventListener("pointerdown", function (e) {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      try { pe.keyHeight.setPointerCapture(e.pointerId); } catch (err) {}
      khDrag = { y: e.clientY, h: playKeyH.now };
      pe.keyHeight.classList.add("dragging");
    });
    pe.keyHeight.addEventListener("pointermove", function (e) {
      if (!khDrag) return;
      var want = khDrag.h + (khDrag.y - e.clientY);
      if (khRaf) cancelAnimationFrame(khRaf);
      khRaf = requestAnimationFrame(function () { khRaf = 0; setKeyHeight(want); });
    });
    var khEnd = function () { khDrag = null; pe.keyHeight.classList.remove("dragging"); };
    pe.keyHeight.addEventListener("pointerup", khEnd);
    pe.keyHeight.addEventListener("pointercancel", khEnd);
    pe.keyHeight.addEventListener("keydown", function (e) {
      var step = playKeyH.view * 0.02, k = playKeyH, to = null;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") to = k.now + step;
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") to = k.now - step;
      else if (e.key === "PageUp") to = k.now + step * 5;
      else if (e.key === "PageDown") to = k.now - step * 5;
      else if (e.key === "Home") to = k.min;
      else if (e.key === "End") to = k.max;
      if (to == null) return;
      e.preventDefault();
      e.stopPropagation();
      setKeyHeight(to);
    });
  }

  pe.pause.addEventListener("click", function () {
    if (play.playing) pausePlay();
    else setPlaySheet(true);
  });
  if (pe.midiConnect) {
    pe.midiConnect.addEventListener("click", function (e) {
      e.preventDefault();
      els.status.click();
    });
  }
  if (pe.midiMsg) {
    pe.midiMsg.addEventListener("click", function (e) {
      var link = e.target && e.target.closest && (e.target.closest(".reload-link") || e.target.closest(".scan-link"));
      if (!link) return;
      e.preventDefault();
      var orig = els.status.querySelector(link.classList.contains("reload-link") ? ".reload-link" : ".scan-link");
      if (orig) orig.click();
    });
  }
  syncPlayMidi();
  pe.wait.addEventListener("change", function () { play.wait = pe.wait.checked; play.hit = {}; stopPlayback(); });

  if (pe.keys) {
    var keysMode = playKeysMode();
    Array.prototype.forEach.call(pe.keys.querySelectorAll("input"), function (r) {
      r.checked = r.value === keysMode;
      r.addEventListener("change", function () {
        if (!r.checked) return;
        try { localStorage.setItem(PLAY_KEYS_STORE_KEY, r.value); } catch (e) {}
        applyPlayRange();
      });
    });
  }
  pe.tempo.addEventListener("input", function () {
    play.rate = parseInt(pe.tempo.value, 10) / 100;
    pe.tempoOut.textContent = pe.tempo.value + "%";
  });
  document.addEventListener("keydown", function (e) {
    if (!document.body.classList.contains("mode-play")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (play.playing) pausePlay();
      else if (pe.sheet && !pe.sheet.hidden) {
        if (canResume()) startPlay();
        else setPlaySheet(false);
      } else setPlaySheet(true);
      return;
    }
    if (e.key !== "Tab" || !pe.sheet || pe.sheet.hidden) return;
    var nodes = pe.sheet.querySelectorAll("button, select, input, textarea");
    var list = [], i, el;
    for (i = 0; i < nodes.length; i++) {
      el = nodes[i];
      if (!el.disabled && el.offsetParent !== null) list.push(el);
    }
    if (pe.keyHeight && pe.keyHeight.offsetParent !== null) list.push(pe.keyHeight);
    if (!list.length) return;
    var idx = list.indexOf(document.activeElement);
    if (e.shiftKey && (idx <= 0)) { e.preventDefault(); focusEl(list[list.length - 1]); }
    else if (!e.shiftKey && (idx === list.length - 1 || idx < 0)) { e.preventDefault(); focusEl(list[0]); }
  });
  if (typeof ResizeObserver !== "undefined") {
    var highwayArea = pe.canvas && pe.canvas.parentElement ? pe.canvas.parentElement : pe.canvas;
    new ResizeObserver(function () { drawHighway(); }).observe(highwayArea);
  }
  els.kbScroll.addEventListener("scroll", function () { if (!play.playing) drawHighway(); });
  try { if (localStorage.getItem(MODE_STORE_KEY) === "play") setMode("play", false); } catch (e) {}

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
        keyProportions: keyProportions(activeKeyboard()),
        autoDetectScheduled: !!autoDetectTimer,
        autoDetectCycles: autoDetectCycles,
        soundOn: audio.enabled,
        soundVolume: audio.volume,
        soundVoices: Object.keys(audio.voices).length
      };
    },
    autoDetect: function (opts) {
      if (!opts) {
        return {
          enabled: autoDetectEnabled,
          enumerateMs: AUTO_ENUMERATE_MS,
          refreshEvery: AUTO_REFRESH_EVERY,
          cycles: autoDetectCycles,
          scheduled: !!autoDetectTimer
        };
      }
      if (typeof opts.enabled === "boolean") autoDetectEnabled = opts.enabled;
      if (typeof opts.enumerateMs === "number" && opts.enumerateMs > 0) {
        AUTO_ENUMERATE_MS = opts.enumerateMs;
      }
      if (typeof opts.refreshEvery === "number" && opts.refreshEvery > 0) {
        AUTO_REFRESH_EVERY = opts.refreshEvery;
      }
      if (autoDetectEnabled) scheduleAutoDetect();
      else stopAutoDetect();
      return window.__pfTest.autoDetect();
    },
    previewProfile: function (id) {
      previewProfile = id || null;
      buildKeyboard();
    },
    sound: {
      enabled: function () { return audio.enabled; },
      volume: function () { return audio.volume; },
      voices: function () { return Object.keys(audio.voices).length; },
      supported: function () { return audio.supported; },
      setEnabled: function (on) { setSoundEnabled(!!on); },
      setVolume: function (v) { setSoundVolume(v); },
      analyze: function (id) { return analyzeSoundProfile(id); }
    },
    play: {
      state: function () {
        return { song: play.song && play.song.id, rung: play.rung, steps: play.steps.length, step: play.step,
          beat: play.beat, playing: play.playing, wait: play.wait, drawn: play.drawn, next: nextNotes(),
          stepNotes: play.steps.map(function (s) { return s.notes; }),
          lit: Array.prototype.map.call(els.keyboard.querySelectorAll(".key.next"), function (k) { return +k.dataset.note; }),
          rangeLow: play.rangeLow, rangeHigh: play.rangeHigh,
          farScale: FAR_SCALE, tilt: playTiltDeg,
          sheetOpen: !!(pe.sheet && !pe.sheet.hidden) };
      },
      parse: function (buf) { return parseMidi(buf); },
      keyFit: function (w, n, h) { return playKeyFit(w, n, h); },
      keysRange: function (lo, hi, mode) { return songKeyboardRange([{ note: lo }, { note: hi }], mode); },
      keysMode: function () { return playKeysMode(); },
      keyRange: function (w, n, v) { return playKeyHeightRange(w, n, v); },
      keyHeight: function () { return { now: playKeyH.now, min: playKeyH.min, max: playKeyH.max, land: playKeyH.land }; },
      drawMs: function (n) {
        n = n || 60;
        var t = performance.now();
        for (var i = 0; i < n; i++) drawHighway();
        return (performance.now() - t) / n;
      }
    },
    debug: {
      open: function () { openDebug(); },
      close: function () { closeDebug(); },
      isOpen: function () { return state.pane === "help"; },
      report: function () { return buildDebugReport(); },
      snapshot: function () { return debugSnapshot(); },
      pane: function (id) {
        if (id) showPane(id);
        return state.pane;
      }
    }
  };

  /* ---------- stable slot widths ----------
     Each readout slot is sized to the widest value it can ever show,
     measured in the font actually on screen, so neighbours never shift. */
  function fitSlots() {
    var nameEl = document.getElementById("last-name");
    if (nameEl) nameEl.style.fontSize = "";
    if (els.panelStats && els.panelStats.hidden) {
      measureSlots();
      sizePaneStage();
      return;
    }
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
    sizePaneStage();
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


  /* ---------- troubleshooting panel ---------- */

  var DEBUG_EVENT_MAX = 20;
  var debugState = {
    open: false,
    accessAt: 0,
    refreshCount: 0,
    lastRefreshReason: "",
    lastRefreshAt: 0,
    lastStateChange: null,
    lastMidi: null,
    lastPollAt: 0,
    lastPollResult: "",
    lastReturnAt: 0,
    events: []
  };
  var copyResetTimer = null;

  function fmtDebugTime(ms) {
    if (!ms) return "—";
    var d = new Date(ms);
    try {
      return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
    } catch (e) {
      return d.toISOString();
    }
  }

  function debugEvent(text) {
    debugState.events.push({ t: Date.now(), text: text });
    if (debugState.events.length > DEBUG_EVENT_MAX) {
      debugState.events = debugState.events.slice(-DEBUG_EVENT_MAX);
    }
    if (debugState.open) renderDebug();
  }

  function noteDebugPoll(count) {
    debugState.lastPollAt = Date.now();
    debugState.lastPollResult = count ? "found" : "none";
    if (count) {
      debugEvent("Poll found " + count + " input" + (count === 1 ? "" : "s") + ".");
    } else {
      debugEvent("Poll found no inputs.");
    }
  }

  function noteDebugStateChange(port) {
    if (!port) return;
    var rec = {
      t: Date.now(),
      name: port.name || port.id || "MIDI port",
      type: port.type || "",
      state: port.state || "",
      connection: port.connection || "",
      id: port.id || ""
    };
    debugState.lastStateChange = rec;
    var label = rec.name + (rec.type ? " (" + rec.type + ")" : "");
    debugEvent("State change: " + label + " is " + (rec.state || "unknown") + ".");
  }

  function noteDebugMidi(bytes) {
    debugState.lastMidi = { t: Date.now(), bytes: Array.prototype.slice.call(bytes) };
    if (debugState.open) renderDebug();
  }

  function listDebugPorts(map) {
    var list = [];
    if (!map || !map.forEach) return list;
    map.forEach(function (port) {
      list.push({
        name: port.name || "Unnamed device",
        manufacturer: port.manufacturer || "",
        state: port.state || "unknown",
        connection: port.connection || "unknown",
        id: port.id || "",
        type: port.type || ""
      });
    });
    return list;
  }

  function permLabel() {
    if (state.permState === "granted" || state.permState === "prompt" || state.permState === "denied") {
      return state.permState;
    }
    return "unknown";
  }

  function debugSnapshot() {
    var inputs = state.access ? listDebugPorts(state.access.inputs) : [];
    var outputs = state.access ? listDebugPorts(state.access.outputs) : [];
    var polling = !!(autoDetectTimer && canAutoDetect());
    return {
      midiSupported: midiSupported(),
      browser: BROWSER_NAME || "Unknown",
      userAgent: navigator.userAgent || "",
      secure: isSecure(),
      permission: permLabel(),
      hasAccess: !!state.access,
      accessAt: debugState.accessAt,
      refreshCount: debugState.refreshCount,
      lastRefreshReason: debugState.lastRefreshReason,
      lastRefreshAt: debugState.lastRefreshAt,
      inputs: inputs,
      outputs: outputs,
      lastStateChange: debugState.lastStateChange,
      lastMidi: debugState.lastMidi,
      polling: polling,
      lastPollAt: debugState.lastPollAt,
      lastPollResult: debugState.lastPollResult,
      pageHidden: !!document.hidden,
      lastReturnAt: debugState.lastReturnAt,
      soundProfile: audio.profile,
      events: debugState.events.slice()
    };
  }

  function connectedInputs(snap) {
    return snap.inputs.filter(function (p) { return p.state === "connected"; });
  }

  function debugVerdict(snap) {
    if (!snap.midiSupported) return "This browser has no Web MIDI.";
    if (!snap.secure) return "This page is not in a secure context, so MIDI is unavailable.";
    if (snap.permission === "denied") return "MIDI permission denied.";
    if (snap.permission === "prompt" && !snap.hasAccess) {
      return "MIDI permission has not been granted.";
    }
    var live = connectedInputs(snap);
    if (live.length === 1) return "Keyboard connected: " + live[0].name + ".";
    if (live.length > 1) {
      return "Keyboards connected: " + live.map(function (p) { return p.name; }).join(", ") + ".";
    }
    if (snap.hasAccess) return "Browser sees no MIDI keyboard.";
    return "MIDI access has not been obtained.";
  }

  function describeAccess(snap) {
    if (!snap.hasAccess) return "Not obtained.";
    return "Obtained at " + fmtDebugTime(snap.accessAt) + ".";
  }

  function describeRefresh(snap) {
    var s = String(snap.refreshCount) + " time" + (snap.refreshCount === 1 ? "" : "s");
    return s + ".";
  }

  function describeLastRefresh(snap) {
    if (!snap.lastRefreshReason) return "—";
    return snap.lastRefreshReason + " (" + fmtDebugTime(snap.lastRefreshAt) + ").";
  }

  function describeAuto(snap) {
    var s = "Polling " + (snap.polling ? "on" : "off");
    if (snap.lastPollAt) {
      s += ", last poll " + fmtDebugTime(snap.lastPollAt);
      if (snap.lastPollResult === "found") s += " (found a device)";
      else if (snap.lastPollResult === "none") s += " (none)";
    }
    return s + ".";
  }

  function describePage(snap) {
    var s = snap.pageHidden ? "Hidden" : "Visible";
    if (snap.lastReturnAt) s += ", last returned " + fmtDebugTime(snap.lastReturnAt);
    return s + ".";
  }

  function describeStateChange(rec) {
    if (!rec) return "—";
    return fmtDebugTime(rec.t) + ", " + rec.name + (rec.type ? " (" + rec.type + ")" : "") + ", " + (rec.state || "unknown") + ".";
  }

  function describeMidi(rec) {
    if (!rec) return "—";
    return fmtDebugTime(rec.t) + ", " + hexBytes(rec.bytes) + ".";
  }

  function renderPort(p) {
    var meta = [];
    if (p.manufacturer) meta.push(p.manufacturer);
    meta.push((p.state || "unknown") + ", " + (p.connection || "unknown"));
    return "<div class=\"debug-port\">" +
      "<div class=\"debug-port-name\">" + escapeHtml(p.name) + "</div>" +
      "<div class=\"debug-port-meta\">" + escapeHtml(meta.join(" · ")) + "</div>" +
      (p.id ? "<div class=\"debug-port-id\">Id: " + escapeHtml(p.id) + "</div>" : "") +
      "</div>";
  }

  function renderPortGroup(label, ports) {
    var html = "<div class=\"debug-sub\">" + escapeHtml(label) + "</div>";
    if (!ports.length) return html + "<p class=\"debug-none\">None.</p>";
    return html + "<div class=\"debug-ports\">" + ports.map(renderPort).join("") + "</div>";
  }

  function gridRow(label, value, extraClass) {
    return "<div class=\"k\">" + escapeHtml(label) + "</div>" +
      "<div class=\"v" + (extraClass ? " " + extraClass : "") + "\">" + escapeHtml(value) + "</div>";
  }

  function section(title, inner) {
    return "<section class=\"debug-section\"><h3 class=\"debug-h\">" + escapeHtml(title) + "</h3>" + inner + "</section>";
  }

  // Android app only: the phone's own USB and MIDI view, as label/value rows.
  function nativeDiagRows() {
    if (!window.AplusNative || typeof window.AplusNative.diag !== "function") return null;
    var d;
    try { d = JSON.parse(window.AplusNative.diag()); } catch (e) { return [["Native diagnostics", "Unreadable: " + e]]; }
    var yn = function (v) { return v ? "Yes." : "No."; };
    var usbMidi = (d.usb || []).filter(function (u) {
      return (u.interfaces || []).some(function (i) { return i[0] === 1 && i[1] === 3; });
    });
    var rows = [
      ["Android", "API " + d.sdk],
      ["MIDI feature", yn(d.featureMidi)],
      ["USB host", yn(d.featureUsbHost)],
      ["MidiManager", yn(d.midiManager)]
    ];
    if (usbMidi.length && !(d.midi || []).length) {
      rows.push(["Verdict", "Android sees a USB MIDI device, but its MIDI service lists none."]);
    } else if (!(d.usb || []).length) {
      rows.push(["Verdict", "Android sees no USB device. Check the cable, the OTG adapter and the USB-C port setting."]);
    }
    (d.midi || []).forEach(function (m) {
      rows.push(["MIDI device " + (m.id == null ? "" : "#" + m.id),
        m.name + " · in " + m.inputs + ", out " + m.outputs + " · " + m.open]);
    });
    (d.usb || []).forEach(function (u) {
      rows.push(["USB device", u.name + " · " + u.vendorId + ":" + u.productId +
        " · permission " + (u.permission ? "yes" : "no") + " · interfaces " +
        (u.interfaces || []).map(function (i) { return i[0] + "/" + i[1] + (i[0] === 1 && i[1] === 3 ? " (MIDI)" : ""); }).join(", ")]);
    });
    (d.events || []).slice().reverse().forEach(function (e) { rows.push(["App event", e]); });
    return rows;
  }

  function buildDebugReport() {
    var snap = debugSnapshot();
    var lines = [];
    lines.push("A+Piano troubleshooting report");
    lines.push("Time: " + new Date().toLocaleString());
    lines.push("");
    lines.push(debugVerdict(snap));
    lines.push("");
    lines.push("Devices");
    lines.push("  Inputs (" + snap.inputs.length + ")");
    if (!snap.inputs.length) {
      lines.push("    None.");
    } else {
      snap.inputs.forEach(function (p) {
        var meta = [];
        if (p.manufacturer) meta.push(p.manufacturer);
        meta.push((p.state || "unknown") + ", " + (p.connection || "unknown"));
        lines.push("    " + p.name);
        lines.push("      " + meta.join(" · "));
        if (p.id) lines.push("      Id: " + p.id);
      });
    }
    lines.push("  Outputs (" + snap.outputs.length + ")");
    if (!snap.outputs.length) {
      lines.push("    None.");
    } else {
      snap.outputs.forEach(function (p) {
        var meta = [];
        if (p.manufacturer) meta.push(p.manufacturer);
        meta.push((p.state || "unknown") + ", " + (p.connection || "unknown"));
        lines.push("    " + p.name);
        lines.push("      " + meta.join(" · "));
        if (p.id) lines.push("      Id: " + p.id);
      });
    }
    lines.push("");
    lines.push("Connection");
    lines.push("  Permission: " + snap.permission + ".");
    lines.push("  MIDI access: " + describeAccess(snap));
    lines.push("  Refreshed: " + describeRefresh(snap));
    if (snap.lastRefreshReason) lines.push("  Last refresh: " + describeLastRefresh(snap));
    lines.push("  Auto-detect: " + describeAuto(snap));
    lines.push("  Last statechange: " + describeStateChange(snap.lastStateChange));
    lines.push("  Last MIDI message: " + describeMidi(snap.lastMidi));
    lines.push("");
    lines.push("Browser");
    lines.push("  Web MIDI support: " + (snap.midiSupported ? "yes" : "no"));
    lines.push("  Secure context: " + (snap.secure ? "yes" : "no"));
    lines.push("  Page: " + describePage(snap));
    lines.push("  Browser: " + snap.browser);
    lines.push("  Sound profile: " + soundProfile(snap.soundProfile).label + ".");
    lines.push("  User agent: " + (snap.userAgent || "—"));
    lines.push("");
    var nrows = nativeDiagRows();
    if (nrows) {
      lines.push("Native USB/MIDI");
      nrows.forEach(function (r) { lines.push("  " + r[0] + ": " + r[1]); });
      lines.push("");
    }
    lines.push("Event log");
    if (!snap.events.length) {
      lines.push("  (none)");
    } else {
      snap.events.slice().reverse().forEach(function (e) {
        lines.push("  " + fmtDebugTime(e.t) + "  " + e.text);
      });
    }
    lines.push("");
    return lines.join("\n");
  }

  function renderDebug() {
    if (!debugState.open) return;
    var snap = debugSnapshot();
    if (els.debugSummary) els.debugSummary.textContent = debugVerdict(snap);
    if (!els.debugBody) return;
    var ev = snap.events.slice().reverse().map(function (e) {
      return "<li><span class=\"t\">" + escapeHtml(fmtDebugTime(e.t)) + "</span>" +
        "<span class=\"m\">" + escapeHtml(e.text) + "</span></li>";
    }).join("");
    var conn = "<div class=\"debug-grid\">" +
      gridRow("Permission", snap.permission + ".") +
      gridRow("MIDI access", describeAccess(snap)) +
      gridRow("Refreshed", describeRefresh(snap)) +
      (snap.lastRefreshReason ? gridRow("Last refresh", describeLastRefresh(snap)) : "") +
      gridRow("Auto-detect", describeAuto(snap)) +
      gridRow("Last statechange", describeStateChange(snap.lastStateChange)) +
      gridRow("Last MIDI message", describeMidi(snap.lastMidi)) +
      "</div>";
    var browser = "<div class=\"debug-grid\">" +
      gridRow("Web MIDI", snap.midiSupported ? "Yes." : "No.") +
      gridRow("Secure context", snap.secure ? "Yes." : "No.") +
      gridRow("Page", describePage(snap)) +
      gridRow("Browser", snap.browser + ".") +
      gridRow("Sound profile", soundProfile(snap.soundProfile).label + ".") +
      gridRow("User agent", snap.userAgent || "—", "debug-ua") +
      "</div>";
    var nrows = nativeDiagRows();
    var events = ev
      ? "<ul class=\"debug-events\">" + ev + "</ul>"
      : "<p class=\"debug-none\">No events yet.</p>";
    els.debugBody.innerHTML =
      section("Devices", renderPortGroup("Inputs", snap.inputs) + renderPortGroup("Outputs", snap.outputs)) +
      section("Connection", conn) +
      section("Browser", browser) +
      (nrows ? section("Native USB/MIDI", "<div class=\"debug-grid\">" + nrows.map(function (r) { return gridRow(r[0], r[1]); }).join("") + "</div>") : "") +
      section("Event log", events);
  }

  function isDebugHash() {
    return /^#debug$/i.test(location.hash || "");
  }

  function setDebugHash(open) {
    if (open) {
      if (!isDebugHash()) {
        if (history.replaceState) history.replaceState(null, "", "#debug");
        else location.hash = "debug";
      }
    } else if (isDebugHash()) {
      if (history.replaceState) {
        history.replaceState(null, "", location.pathname + location.search);
      } else {
        location.hash = "";
      }
    }
  }

  function loadPanePref() {
    try {
      var v = localStorage.getItem(PANE_STORE_KEY);
      if (PANE_IDS.indexOf(v) !== -1) return v;
    } catch (e) {}
    return "stats";
  }

  function savePanePref(id) {
    try { localStorage.setItem(PANE_STORE_KEY, id); } catch (e) {}
  }

  function sizePaneStage() {
    var stage = els.paneStage, stats = els.panelStats;
    if (!stage || !stats) return;
    var hideAgain = false;
    var prevVis = stats.style.visibility;
    var prevPos = stats.style.position;
    var prevWidth = stats.style.width;
    var prevInset = stats.style.inset;
    if (stats.hidden) {
      hideAgain = true;
      stats.hidden = false;
      stats.style.visibility = "hidden";
      stats.style.position = "absolute";
      stats.style.inset = "0 auto auto 0";
      stats.style.width = "100%";
    }
    var h = Math.ceil(stats.getBoundingClientRect().height);
    if (hideAgain) {
      stats.hidden = true;
      stats.style.visibility = prevVis;
      stats.style.position = prevPos;
      stats.style.width = prevWidth;
      stats.style.inset = prevInset;
    }
    if (h > 0) stage.style.setProperty("--pane-h", h + "px");
  }

  function showPane(id, opts) {
    if (PANE_IDS.indexOf(id) === -1) id = "stats";
    state.pane = id;
    debugState.open = id === "help";
    var i;
    for (i = 0; i < PANE_IDS.length; i++) {
      var name = PANE_IDS[i];
      var tab = document.getElementById("tab-" + name);
      var panel = document.getElementById("panel-" + name);
      var on = name === id;
      if (tab) {
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.tabIndex = on ? 0 : -1;
      }
      if (panel) panel.hidden = !on;
    }
    if (id === "help") {
      setDebugHash(true);
      renderDebug();
    } else {
      setDebugHash(false);
    }
    if (id === "stats") fitSlots();
    else sizePaneStage();
    if (!opts || opts.remember !== false) savePanePref(id);
  }

  function onPaneSwitchKey(e) {
    var dir = 0;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") dir = 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") dir = -1;
    else if (e.key === "Home") dir = "start";
    else if (e.key === "End") dir = "end";
    else return;
    e.preventDefault();
    var idx = PANE_IDS.indexOf(state.pane);
    if (idx < 0) idx = 0;
    if (dir === "start") idx = 0;
    else if (dir === "end") idx = PANE_IDS.length - 1;
    else idx = (idx + dir + PANE_IDS.length) % PANE_IDS.length;
    showPane(PANE_IDS[idx]);
    var tab = document.getElementById("tab-" + PANE_IDS[idx]);
    if (tab) focusEl(tab);
  }

  function openDebug() { showPane("help"); }

  function closeDebug() { showPane("stats"); }

  function toggleDebug() {
    if (state.pane === "help") showPane("stats");
    else showPane("help");
  }

  function copyDebugReport() {
    var text = buildDebugReport();
    function ok() {
      if (!els.btnDebugCopy) return;
      els.btnDebugCopy.textContent = "Copied";
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(function () {
        if (els.btnDebugCopy) els.btnDebugCopy.textContent = "Copy report";
      }, 1500);
    }
    function fallback() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        var worked = document.execCommand("copy");
        document.body.removeChild(ta);
        if (worked) ok();
      } catch (e) {}
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(ok, fallback);
    } else {
      fallback();
    }
    return text;
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
    // Stay on the checking status until the permission check resolves.
    // Do not show the tap-to-connect state here: that would flash the button.
    loadKeyboards();
    checkPermission();
    bootTimer = setTimeout(function () {
      bootTimer = null;
      if (!bootDecided) showFirstVisit();
    }, MIDI_CHECK_TIMEOUT);
  }
  if (isDebugHash()) showPane("help", { remember: false });
  else showPane(loadPanePref(), { remember: false });
  sizePaneStage();
})();
