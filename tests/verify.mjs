import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";
import { runSongsChecks } from "./songs-catalog.mjs";

const URL = "http://127.0.0.1:8766/";
const SCREEN_DIR = "/workspace/pianoflow/app/screens";
const chromePath = process.env.CHROME || "/usr/bin/google-chrome";

const results = { ok: true, checks: [], errors: [] };
const jsErrors = [];

function check(name, cond, detail) {
  const item = { name, pass: !!cond, detail: detail ?? "" };
  results.checks.push(item);
  if (!cond) results.ok = false;
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? " — " + detail : ""));
}

function ignoreConsoleError(text) {
  return /favicon\.ico/.test(text);
}

async function shot(page, name, w, h) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await new Promise((r) => setTimeout(r, 250));
  const dest = path.join(SCREEN_DIR, name);
  await page.screenshot({ path: dest, fullPage: false, type: "png" });
  const st = fs.statSync(dest);
  console.log("SHOT  " + dest + "  (" + st.size + " bytes, " + w + "x" + h + ")");
  return dest;
}

async function layoutInfo(page) {
  return page.evaluate(() => {
    const kb = document.getElementById("keyboard");
    const scroll = document.getElementById("kb-scroll");
    const blacks = kb.querySelectorAll(".key.black");
    const whites = kb.querySelectorAll(".key.white");
    const br = kb.getBoundingClientRect();
    const sr = scroll.getBoundingClientRect();
    const sampleBlack = blacks[0] ? blacks[0].getBoundingClientRect() : null;
    const sampleWhite = whites[0] ? whites[0].getBoundingClientRect() : null;
    return {
      kb: { w: br.width, h: br.height },
      scroll: { w: sr.width, h: sr.height },
      whiteCount: whites.length,
      blackCount: blacks.length,
      whiteH: sampleWhite ? sampleWhite.height : 0,
      blackH: sampleBlack ? sampleBlack.height : 0,
      blackW: sampleBlack ? sampleBlack.width : 0,
    };
  });
}

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (err) => {
    jsErrors.push(String(err));
    console.error("PAGEERROR", err);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const t = msg.text();
      if (ignoreConsoleError(t)) return;
      jsErrors.push("console.error: " + t);
      console.error("CONSOLEERROR", t);
    }
  });

  await page.evaluateOnNewDocument(() => { try { localStorage.removeItem("aplus.pane.v1"); localStorage.removeItem("aplus.sound.v1"); } catch (e) {} });
  const resp = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  await new Promise((r) => setTimeout(r, 200));
  check("page HTTP status", resp && resp.ok(), resp ? String(resp.status()) : "no response");
  check("title", (await page.title()) === "A+Piano — MIDI Input Test", await page.title());

  const hasHook = await page.evaluate(() => typeof window.__pfTest?.feed === "function");
  check("__pfTest.feed exposed", hasHook);

  const boot = await page.evaluate(() => window.__pfTest.getState());
  check("secure context on localhost", boot.secureContext === true);
  check("midiSupported flag is boolean", typeof boot.midiSupported === "boolean", String(boot.midiSupported));
  check("default visible range C3-C5 (48-72)", boot.visibleLow === 48 && boot.visibleHigh === 72,
    JSON.stringify({ low: boot.visibleLow, high: boot.visibleHigh }));
  const keyCount = await page.evaluate(() => document.querySelectorAll(".key").length);
  check("25 white+black keys in DOM (C3-C5)", keyCount === 25, String(keyCount));

  const kbHeader = await page.evaluate(() => {
    const label = document.getElementById("range-label");
    const hint = document.querySelector(".kb-tap-hint");
    const btn = document.getElementById("btn-reset-range");
    const bar = document.querySelector(".kb-bar");
    const bottom = document.querySelector(".hint");
    const lr = label.getBoundingClientRect();
    const hr = hint.getBoundingClientRect();
    const btr = btn.getBoundingClientRect();
    const barR = bar.getBoundingClientRect();
    const mid = (r) => (r.top + r.bottom) / 2;
    return {
      label: label.textContent,
      hint: hint ? hint.textContent.trim() : "",
      hintVisible: !!(hint && hr.height > 0 && getComputedStyle(hint).display !== "none"),
      bottom: ((bottom && bottom.innerText) || "").replace(/\s+/g, " ").trim(),
      barH: Math.round(barR.height),
      sameRow: Math.abs(mid(lr) - mid(btr)) < 3 && Math.abs(mid(hr) - mid(btr)) < 3
        && lr.bottom <= barR.bottom + 1 && hr.bottom <= barR.bottom + 1,
      hintBetween: hr.left >= lr.right - 0.5 && btr.left >= hr.right - 0.5
    };
  });
  check("range label drops Visible and shows the fallback C3–C5 range",
    kbHeader.label === "C3–C5 · 25 keys" && !/^Visible\b/.test(kbHeader.label),
    kbHeader.label);
  check("keyboard header has a muted tap hint between the range and Reset range",
    kbHeader.hint === "Tap keys to test." && kbHeader.hintVisible === true
      && kbHeader.sameRow === true && kbHeader.hintBetween === true && kbHeader.barH > 0,
    JSON.stringify(kbHeader));
  const pageCopy = await page.evaluate(() => {
    const bottom = document.querySelector(".hint");
    const body = (document.body.innerText || "").replace(/\s+/g, " ");
    return { hasHint: !!bottom, hintText: bottom ? bottom.innerText : "", bodyHasDisclaimer: /No sound is played/.test(body) };
  });
  check("the no-sound disclaimer is gone",
    pageCopy.hasHint === false && pageCopy.bodyHasDisclaimer === false,
    JSON.stringify(pageCopy));

  const soundBefore = await page.evaluate(() => {
    const st = document.getElementById("status");
    const kb = document.querySelector(".kb-wrap");
    const top = document.querySelector(".top");
    const h1 = document.querySelector("h1");
    const tabs = document.getElementById("mode-switch");
    const btn = document.getElementById("btn-sound");
    const vol = document.getElementById("sound-volume");
    const wrap = document.querySelector(".sound-controls");
    const stR = st.getBoundingClientRect();
    const kbR = kb.getBoundingClientRect();
    const topR = top.getBoundingClientRect();
    const h1R = h1.getBoundingClientRect();
    const tabsR = tabs.getBoundingClientRect();
    const btnR = btn.getBoundingClientRect();
    const mid = (r) => (r.top + r.bottom) / 2;
    return {
      statusTop: Math.round(stR.top),
      statusH: Math.round(stR.height),
      kbTop: Math.round(kbR.top),
      hasToggle: !!(btn && btnR.height > 0 && getComputedStyle(btn).display !== "none"),
      hasSlider: !!(vol && vol.getBoundingClientRect().height > 0 && getComputedStyle(vol).display !== "none"),
      pressed: btn ? btn.getAttribute("aria-pressed") : null,
      label: btn ? btn.getAttribute("aria-label") : null,
      volLabel: vol ? vol.getAttribute("aria-label") : null,
      inHeader: !!(top && top.contains(wrap) && wrap.contains(btn)),
      inStatus: !!(st.contains(wrap) || st.contains(btn)),
      sameRow: Math.abs(mid(btnR) - mid(h1R)) < 8 && Math.abs(mid(btnR) - mid(tabsR)) < 8
        && btnR.bottom <= topR.bottom + 1 && btnR.top >= topR.top - 1,
      afterTitle: btnR.left >= h1R.right - 0.5,
      beforeTabs: tabsR.left >= btnR.right - 0.5,
      hookOff: window.__pfTest.sound.enabled() === false
    };
  });
  check("sound controls sit in the header, not the status bar",
    soundBefore.hasToggle === true && soundBefore.hasSlider === true
      && soundBefore.pressed === "false" && /Sound off\.?/.test(soundBefore.label || "")
      && /Volume\.?/.test(soundBefore.volLabel || "")
      && soundBefore.statusH === 61 && soundBefore.inHeader === true
      && soundBefore.inStatus === false
      && soundBefore.sameRow === true && soundBefore.afterTitle === true && soundBefore.beforeTabs === true
      && soundBefore.hookOff === true && soundBefore.kbTop > soundBefore.statusTop,
    JSON.stringify(soundBefore));

  await page.evaluate(() => document.getElementById("btn-sound").click());
  await new Promise((r) => setTimeout(r, 40));
  const soundAfter = await page.evaluate(() => {
    const st = document.getElementById("status");
    const kb = document.querySelector(".kb-wrap");
    const btn = document.getElementById("btn-sound");
    return {
      statusTop: Math.round(st.getBoundingClientRect().top),
      statusH: Math.round(st.getBoundingClientRect().height),
      kbTop: Math.round(kb.getBoundingClientRect().top),
      pressed: btn.getAttribute("aria-pressed"),
      label: btn.getAttribute("aria-label"),
      enabled: window.__pfTest.sound.enabled(),
      stored: (function () { try { return JSON.parse(localStorage.getItem("aplus.sound.v1")); } catch (e) { return null; } })()
    };
  });
  check("sound toggle flips aria-pressed and does not move the status box or keyboard",
    soundAfter.pressed === "true" && /Sound on\.?/.test(soundAfter.label || "")
      && soundAfter.enabled === true
      && soundAfter.statusTop === soundBefore.statusTop
      && soundAfter.statusH === soundBefore.statusH
      && soundAfter.kbTop === soundBefore.kbTop,
    JSON.stringify({ before: soundBefore, after: soundAfter }));

  const pSound = await browser.newPage();
  pSound.on("pageerror", (err) => jsErrors.push(String(err)));
  // Keep the stored "on" preference to verify it persists; still reset the pane.
  await pSound.evaluateOnNewDocument(() => { try { localStorage.removeItem("aplus.pane.v1"); } catch (e) {} });
  await pSound.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  await new Promise((r) => setTimeout(r, 300));
  const soundPersisted = await pSound.evaluate(() => {
    const btn = document.getElementById("btn-sound");
    return {
      pressed: btn ? btn.getAttribute("aria-pressed") : null,
      label: btn ? btn.getAttribute("aria-label") : null,
      enabled: window.__pfTest.sound.enabled(),
      stored: (function () { try { return JSON.parse(localStorage.getItem("aplus.sound.v1")); } catch (e) { return null; } })()
    };
  });
  await pSound.close();
  check("sound on/off preference persists",
    soundPersisted.pressed === "true" && soundPersisted.enabled === true
      && soundPersisted.stored && soundPersisted.stored.on === true,
    JSON.stringify(soundPersisted));
  // Leave the shared page and storage in the default off state for later tests.
  await page.evaluate(() => window.__pfTest.sound.setEnabled(false));

  const pLandSound = await browser.newPage();
  pLandSound.on("pageerror", (err) => jsErrors.push(String(err)));
  await pLandSound.setViewport({
    width: 915, height: 412, deviceScaleFactor: 1,
    isMobile: true, hasTouch: true, isLandscape: true
  });
  await pLandSound.evaluateOnNewDocument(() => {
    try { localStorage.removeItem("aplus.pane.v1"); localStorage.removeItem("aplus.sound.v1"); } catch (e) {}
  });
  await pLandSound.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  await new Promise((r) => setTimeout(r, 300));
  const landSound = await pLandSound.evaluate(() => {
    const st = document.getElementById("status");
    const kb = document.querySelector(".kb-wrap");
    const top = document.querySelector(".top");
    const h1 = document.querySelector("h1");
    const tabs = document.getElementById("mode-switch");
    const btn = document.getElementById("btn-sound");
    const vol = document.getElementById("sound-volume");
    const wrap = document.querySelector(".sound-controls");
    const stR = st.getBoundingClientRect();
    const topR = top.getBoundingClientRect();
    const h1R = h1.getBoundingClientRect();
    const tabsR = tabs.getBoundingClientRect();
    const btnR = btn.getBoundingClientRect();
    const volR = vol.getBoundingClientRect();
    const mid = (r) => (r.top + r.bottom) / 2;
    return {
      statusH: Math.round(stR.height),
      statusTop: Math.round(stR.top),
      kbTop: Math.round(kb.getBoundingClientRect().top),
      sliderVisible: !!(vol && volR.height > 0 && getComputedStyle(vol).display !== "none"),
      toggleVisible: !!(btn && btnR.height > 0 && getComputedStyle(btn).display !== "none"),
      inHeader: !!(top && top.contains(wrap) && wrap.contains(btn)),
      inStatus: !!(st.contains(wrap) || st.contains(btn)),
      sameRow: Math.abs(mid(btnR) - mid(h1R)) < 8 && Math.abs(mid(btnR) - mid(tabsR)) < 8
        && btnR.bottom <= topR.bottom + 1 && volR.bottom <= topR.bottom + 1,
      afterTitle: btnR.left >= h1R.right - 0.5,
      beforeTabs: tabsR.left >= volR.right - 0.5,
      beside: volR.left >= btnR.right - 0.5
    };
  });
  await pLandSound.close();
  check("volume slider is visible in the landscape header and the status box stays 45px",
    landSound.sliderVisible === true && landSound.toggleVisible === true
      && landSound.statusH === 45
      && landSound.inHeader === true && landSound.inStatus === false
      && landSound.sameRow === true && landSound.beside === true
      && landSound.afterTitle === true && landSound.beforeTabs === true
      && landSound.kbTop > landSound.statusTop,
    JSON.stringify(landSound));

  async function soundHeaderAndStatusFit(p) {
    return p.evaluate(() => {
      const st = document.getElementById("status");
      const msg = st.querySelector(".msg");
      const top = document.querySelector(".top");
      const wrap = document.querySelector(".sound-controls");
      const btn = document.getElementById("btn-sound");
      const vol = document.getElementById("sound-volume");
      const tabs = document.getElementById("mode-switch");
      const prev = { cls: st.className, html: msg.innerHTML, role: st.getAttribute("role"), tab: st.getAttribute("tabindex") };
      st.className = "status is-connect";
      st.setAttribute("role", "button");
      st.setAttribute("tabindex", "0");
      msg.textContent = "Tap to connect MIDI keyboard";
      const msgOverflow = msg.scrollWidth <= msg.clientWidth;
      const stOverflow = st.scrollWidth <= st.clientWidth;
      const btnR = btn.getBoundingClientRect();
      const volR = vol.getBoundingClientRect();
      const topR = top.getBoundingClientRect();
      const visible = (el, r) => !!(el && r.height > 0 && getComputedStyle(el).display !== "none");
      const out = {
        inHeader: !!(top && top.contains(wrap) && wrap.contains(btn)),
        inStatus: !!(st.contains(wrap) || st.contains(btn)),
        toggleVisible: visible(btn, btnR),
        sliderVisible: visible(vol, volR),
        label: btn ? btn.getAttribute("aria-label") : null,
        volLabel: vol ? vol.getAttribute("aria-label") : null,
        msgOverflow,
        stOverflow,
        msgScroll: msg.scrollWidth,
        msgClient: msg.clientWidth,
        text: msg.textContent,
        inTopRow: btnR.top >= topR.top - 1 && btnR.bottom <= topR.bottom + 1
          && tabs.getBoundingClientRect().left >= (volR.width ? volR.right : btnR.right) - 0.5,
        playMode: document.body.classList.contains("mode-play"),
        statusHidden: (function () {
          const wrap = document.querySelector(".status-wrap");
          const r = wrap.getBoundingClientRect();
          return getComputedStyle(wrap).display === "none" || r.height === 0;
        })(),
        headerVisible: topR.height > 0 && getComputedStyle(top).display !== "none",
        inSheet: !!(document.getElementById("play-sheet") && document.getElementById("play-sheet").contains(wrap)),
        testSwitch: (function () {
          const btn = document.getElementById("play-to-test");
          const r = btn && btn.getBoundingClientRect();
          return !!(btn && r && r.height > 0 && getComputedStyle(btn).display !== "none");
        })()
      };
      st.className = prev.cls;
      msg.innerHTML = prev.html;
      if (prev.role) st.setAttribute("role", prev.role); else st.removeAttribute("role");
      if (prev.tab) st.setAttribute("tabindex", prev.tab); else st.removeAttribute("tabindex");
      return out;
    });
  }
  const phoneSoundPages = [];
  for (const [name, w, h, land] of [
    ["portrait-390", 390, 844, false],
    ["portrait-360", 360, 800, false],
    ["portrait-320", 320, 680, false],
    ["landscape-915x412", 915, 412, true]
  ]) {
    const pFit = await browser.newPage();
    pFit.on("pageerror", (err) => jsErrors.push(String(err)));
    await pFit.setViewport({
      width: w, height: h, deviceScaleFactor: 1,
      isMobile: true, hasTouch: true, isLandscape: !!land
    });
    await pFit.evaluateOnNewDocument(() => {
      try {
        localStorage.removeItem("aplus.pane.v1");
        localStorage.removeItem("aplus.sound.v1");
        localStorage.removeItem("aplus.mode.v1");
      } catch (e) {}
    });
    await pFit.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 200));
    const testMode = await soundHeaderAndStatusFit(pFit);
    await pFit.evaluate(() => document.getElementById("mode-play").click());
    await new Promise((r) => setTimeout(r, 40));
    const playMode = await soundHeaderAndStatusFit(pFit);
    await pFit.evaluate(() => { try { localStorage.removeItem("aplus.mode.v1"); } catch (e) {} });
    await pFit.close();
    phoneSoundPages.push({ name, testMode, playMode });
    const headerOk = (info) =>
      info.inHeader === true && info.inStatus === false
      && info.toggleVisible === true && info.sliderVisible === true
      && /Sound off\.?/.test(info.label || "") && /Volume\.?/.test(info.volLabel || "")
      && info.inTopRow === true;
    check("sound controls live in the header and status text is not truncated at " + name + " in Test",
      headerOk(testMode) && testMode.playMode === false && testMode.statusHidden === false
        && testMode.msgOverflow === true && testMode.stOverflow === true
        && testMode.text === "Tap to connect MIDI keyboard",
      JSON.stringify(testMode));
    check("status bar and header are hidden in Play and sound controls are in the sheet at " + name,
      playMode.playMode === true && playMode.statusHidden === true
        && playMode.headerVisible === false && playMode.inHeader === false
        && playMode.inSheet === true && playMode.inStatus === false
        && playMode.toggleVisible === true && playMode.sliderVisible === true
        && /Sound off\.?/.test(playMode.label || "") && /Volume\.?/.test(playMode.volLabel || "")
        && playMode.testSwitch === true,
      JSON.stringify(playMode));
  }
  await page.evaluate(() => { try { localStorage.removeItem("aplus.mode.v1"); } catch (e) {} });

  const soundLevels = await page.evaluate(async () => {
    const out = {};
    for (const id of ["small-speaker", "full-range"]) {
      out[id] = await window.__pfTest.sound.analyze(id);
    }
    return out;
  });
  console.log("SOUND LEVELS " + JSON.stringify(soundLevels));
  function profileEven(id) {
    const r = soundLevels[id];
    return r && r.even === true && r.spreadDb <= 3.1
      && r.notes.C3 && r.notes.C4 && r.notes.C5
      && r.notes.C3.clipped !== true && r.notes.C4.clipped !== true && r.notes.C5.clipped !== true
      && r.chord && r.chord.clipped !== true;
  }
  check("small-speaker profile keeps C3–C5 within 3 dB and a 6-note chord does not clip",
    profileEven("small-speaker"),
    JSON.stringify(soundLevels["small-speaker"]));
  check("full-range profile keeps C3–C5 within 3 dB and a 6-note chord does not clip",
    profileEven("full-range"),
    JSON.stringify(soundLevels["full-range"]));

  const statusText = await page.evaluate(() => document.querySelector("#status .msg").innerText);
  console.log("STATUS  " + statusText.replace(/\s+/g, " "));
  check("status mentions connect or MIDI", /midi|connect|allow|device|permission/i.test(statusText), statusText.slice(0, 180));

  const statusHeights = await page.evaluate(() => {
    const body = document.body;
    const st = document.getElementById("status");
    const msg = st.querySelector(".msg");
    const prev = { body: body.className, status: st.className, html: msg.innerHTML, cursor: st.style.cursor };
    body.classList.remove("idle");
    body.classList.add("has-access");
    const samples = [
      ["ok", "Connected: <strong>Digital Piano</strong>"],
      ["warn", "No MIDI keyboard detected.<br>Plug one in, or <button type=\"button\" class=\"scan-link\" aria-label=\"scan again\">scan again</button>."],
      ["err", "MIDI isn't allowed for this site.<br>Allow MIDI in the browser's site settings."],
      ["warn", "Checking for MIDI<span class=\"dots\"><span>.</span><span>.</span><span>.</span></span>"],
      ["warn", "Scanning<span class=\"dots\"><span>.</span><span>.</span><span>.</span></span>"],
      ["warn", "Waiting for permission<span class=\"dots\"><span>.</span><span>.</span><span>.</span></span><br>Tap <strong>Allow</strong> if asked."],
      ["err", "No answer from the browser.<br><button type=\"button\" class=\"reload-link\">Reload</button> to try again."],
      ["connect", "Tap to connect MIDI keyboard"]
    ];
    const hs = samples.map(function (s) {
      st.className = "status is-" + s[0];
      msg.innerHTML = s[1];
      return Math.round(st.getBoundingClientRect().height);
    });
    body.className = prev.body;
    st.className = prev.status;
    msg.innerHTML = prev.html;
    st.style.cursor = prev.cursor;
    return hs;
  });
  check("status box height is the same across states",
    statusHeights.length > 1 && statusHeights.every((h) => h === statusHeights[0] && h > 0),
    JSON.stringify(statusHeights));

  async function loadChecking() {
    const p = await browser.newPage();
    p.on("pageerror", (err) => jsErrors.push(String(err)));
    await p.evaluateOnNewDocument(() => {
      if (navigator.permissions && navigator.permissions.query) {
        const q = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (d) =>
          d && d.name === "midi" ? new Promise(() => {}) : q(d);
      }
    });
    await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 300));
    const info = await p.evaluate(() => {
      const msg = document.querySelector("#status .msg");
      return {
        text: msg ? msg.textContent.replace(/\s+/g, " ").trim() : "",
        hasDots: !!(msg && msg.querySelector(".dots")),
        dotCount: msg ? msg.querySelectorAll(".dots span").length : 0
      };
    });
    await p.close();
    return info;
  }
  const checking = await loadChecking();
  check("checking status has animated dots",
    checking.hasDots && checking.dotCount === 3 && checking.text === "Checking for MIDI...",
    JSON.stringify(checking));

  function fakeMidiPerm(state) {
    const inputs = new Map();
    inputs.set("in1", {
      id: "in1", name: "Digital Piano", type: "input", state: "connected",
      connection: "open", onmidimessage: null,
      open() { return Promise.resolve(this); }, close() {}
    });
    const access = { inputs, outputs: new Map(), onstatechange: null, sysexEnabled: false };
    navigator.requestMIDIAccess = () => Promise.resolve(access);
    const q = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (d) =>
      d && d.name === "midi"
        ? Promise.resolve({ state: state, onchange: null, addEventListener() {}, removeEventListener() {} })
        : q(d);
    window.__pfBtnSeen = false;
    window.__pfBtnStop = false;
    function visibleConnect() {
      const st = document.getElementById("status");
      if (!st || !st.classList.contains("is-connect")) return false;
      const cs = getComputedStyle(st);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const r = st.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function sample() {
      if (visibleConnect()) window.__pfBtnSeen = true;
    }
    function startWatch() {
      if (!document.documentElement) { requestAnimationFrame(startWatch); return; }
      new MutationObserver(sample).observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"]
      });
      (function tick() { sample(); if (!window.__pfBtnStop) requestAnimationFrame(tick); })();
    }
    startWatch();
  }

  async function loadWithPerm(perm) {
    const p = await browser.newPage();
    p.on("pageerror", (err) => jsErrors.push(String(err)));
    await p.evaluateOnNewDocument(fakeMidiPerm, perm);
    await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 800));
    const info = await p.evaluate(() => {
      const st = document.getElementById("status");
      const visible = !!(st && st.classList.contains("is-connect") &&
        getComputedStyle(st).display !== "none" && st.getBoundingClientRect().width > 0);
      return {
        seen: !!window.__pfBtnSeen,
        nowVisible: visible,
        role: st ? st.getAttribute("role") : "",
        body: document.body.className,
        status: (document.querySelector("#status .msg") || {}).innerText || ""
      };
    });
    await p.evaluate(() => { window.__pfBtnStop = true; });
    await p.close();
    return info;
  }

  const grantedLoad = await loadWithPerm("granted");
  console.log("LOAD granted", JSON.stringify(grantedLoad));
  check("connect button never appears when permission is already granted",
    grantedLoad.seen === false && grantedLoad.nowVisible === false,
    JSON.stringify(grantedLoad));

  const promptLoad = await loadWithPerm("prompt");
  console.log("LOAD prompt", JSON.stringify(promptLoad));
  check("connect button appears when permission is prompt",
    promptLoad.seen === true && promptLoad.nowVisible === true,
    JSON.stringify(promptLoad));

  // (c) + (a): stalled permission query, then granted after the 3s timeout,
  // with a click in between. requestMIDIAccess is delayed so the click and
  // the auto-connect overlap.
  async function loadGuardRace() {
    const p = await browser.newPage();
    p.on("pageerror", (err) => jsErrors.push(String(err)));
    await p.evaluateOnNewDocument(() => {
      window.__midiCalls = 0;
      navigator.requestMIDIAccess = () => {
        window.__midiCalls++;
        return new Promise((resolve) => {
          setTimeout(() => resolve({
            inputs: (() => {
              const inputs = new Map();
              inputs.set("in1", {
                id: "in1", name: "Digital Piano", type: "input", state: "connected",
                connection: "open", onmidimessage: null,
                open() { return Promise.resolve(this); }, close() {}
              });
              return inputs;
            })(),
            outputs: new Map(), onstatechange: null, sysexEnabled: false
          }), 800);
        });
      };
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) =>
        d && d.name === "midi"
          ? new Promise((resolve) => {
              setTimeout(() => {
                resolve({ state: "granted", onchange: null, addEventListener() {}, removeEventListener() {} });
              }, 3600);
            })
          : q(d);
    });
    await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 2000));
    const at2s = await p.evaluate(() => {
      const st = document.getElementById("status");
      const msg = st && st.querySelector(".msg");
      const visible = !!(st && st.classList.contains("is-connect") &&
        getComputedStyle(st).display !== "none" && st.getBoundingClientRect().width > 0);
      return {
        visible,
        body: document.body.className,
        status: msg ? msg.textContent.replace(/\s+/g, " ").trim() : ""
      };
    });
    await new Promise((r) => setTimeout(r, 1100));
    const at31 = await p.evaluate(() => {
      const st = document.getElementById("status");
      const visible = !!(st && st.classList.contains("is-connect") &&
        getComputedStyle(st).display !== "none" && st.getBoundingClientRect().width > 0);
      return { visible, body: document.body.className, status: (st.querySelector(".msg") || {}).innerText || "" };
    });
    if (at31.visible) {
      await p.evaluate(() => document.getElementById("status").click());
    }
    await new Promise((r) => setTimeout(r, 1500));
    const after = await p.evaluate(() => {
      const st = document.getElementById("status");
      const visible = !!(st && st.classList.contains("is-connect") &&
        getComputedStyle(st).display !== "none" && st.getBoundingClientRect().width > 0);
      return {
        calls: window.__midiCalls,
        hasAccess: document.body.classList.contains("has-access"),
        isConnected: document.body.classList.contains("is-connected"),
        btnVisible: visible,
        status: (document.querySelector("#status .msg") || {}).innerText || ""
      };
    });
    await p.close();
    return { at2s, at31, after };
  }
  const race = await loadGuardRace();
  console.log("GUARD race", JSON.stringify(race));
  check("connect button hidden at 2s while permission check is stalled",
    race.at2s.visible === false && /Checking for MIDI/.test(race.at2s.status),
    JSON.stringify(race.at2s));
  check("connect button visible after 3s safety timeout",
    race.at31.visible === true,
    JSON.stringify(race.at31));
  check("click then granted auto-connect calls requestMIDIAccess once and connects",
    race.after.calls === 1 && race.after.hasAccess === true && race.after.isConnected === true && race.after.btnVisible === false,
    JSON.stringify(race.after));

  async function loadDoubleClick() {
    const p = await browser.newPage();
    p.on("pageerror", (err) => jsErrors.push(String(err)));
    await p.evaluateOnNewDocument(() => {
      window.__midiCalls = 0;
      navigator.requestMIDIAccess = () => {
        window.__midiCalls++;
        return new Promise((resolve) => {
          setTimeout(() => resolve({
            inputs: (() => {
              const inputs = new Map();
              inputs.set("in1", {
                id: "in1", name: "Digital Piano", type: "input", state: "connected",
                connection: "open", onmidimessage: null,
                open() { return Promise.resolve(this); }, close() {}
              });
              return inputs;
            })(),
            outputs: new Map(), onstatechange: null, sysexEnabled: false
          }), 400);
        });
      };
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) =>
        d && d.name === "midi"
          ? Promise.resolve({ state: "prompt", onchange: null, addEventListener() {}, removeEventListener() {} })
          : q(d);
    });
    await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 300));
    await p.waitForFunction(() => {
      const st = document.getElementById("status");
      return st && st.classList.contains("is-connect");
    }, { timeout: 3000 });
    await p.evaluate(() => {
      const st = document.getElementById("status");
      st.click();
      st.click();
    });
    await new Promise((r) => setTimeout(r, 700));
    const info = await p.evaluate(() => ({
      calls: window.__midiCalls,
      hasAccess: document.body.classList.contains("has-access"),
      isConnected: document.body.classList.contains("is-connected")
    }));
    await p.close();
    return info;
  }
  const dbl = await loadDoubleClick();
  console.log("GUARD double-click", JSON.stringify(dbl));
  check("double-click on connect calls requestMIDIAccess once",
    dbl.calls === 1 && dbl.hasAccess === true,
    JSON.stringify(dbl));

  async function loadNoAnswer() {
    const p = await browser.newPage();
    p.on("pageerror", (err) => jsErrors.push(String(err)));
    await p.evaluateOnNewDocument(() => {
      navigator.requestMIDIAccess = () => new Promise(() => {});
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) =>
        d && d.name === "midi"
          ? Promise.resolve({ state: "prompt", onchange: null, addEventListener() {}, removeEventListener() {} })
          : q(d);
      const orig = window.setTimeout;
      window.setTimeout = function (fn, ms, ...args) {
        if (ms === 8000) ms = 40;
        return orig.call(this, fn, ms, ...args);
      };
    });
    await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 300));
    await p.waitForFunction(() => {
      const st = document.getElementById("status");
      return st && st.classList.contains("is-connect");
    }, { timeout: 3000 });
    await p.evaluate(() => document.getElementById("status").click());
    await p.waitForFunction(() => {
      const msg = document.querySelector("#status .msg");
      return msg && /Waiting for permission/.test(msg.textContent);
    }, { timeout: 3000 });
    const waiting = await p.evaluate(() => {
      const st = document.getElementById("status");
      const msg = st.querySelector(".msg");
      return {
        text: msg.innerText.replace(/\s+/g, " ").trim(),
        hasDots: !!(msg.querySelector(".dots")),
        dotCount: msg.querySelectorAll(".dots span").length,
        isConnect: st.classList.contains("is-connect"),
        role: st.getAttribute("role"),
        statusH: Math.round(st.getBoundingClientRect().height)
      };
    });
    await p.waitForFunction(() => {
      const msg = document.querySelector("#status .msg");
      return msg && /No answer from the browser/.test(msg.textContent);
    }, { timeout: 3000 });
    const info = await p.evaluate(() => {
      const st = document.getElementById("status");
      const msg = st.querySelector(".msg");
      const link = msg.querySelector(".reload-link");
      const noAnswerH = Math.round(st.getBoundingClientRect().height);
      const prev = { html: msg.innerHTML, cls: st.className };
      st.className = "status is-ok";
      msg.innerHTML = "Connected: <strong>Digital Piano</strong>";
      const connectedH = Math.round(st.getBoundingClientRect().height);
      st.className = "status is-warn";
      msg.innerHTML = "No MIDI keyboard detected.<br>Plug one in, or <button type=\"button\" class=\"scan-link\" aria-label=\"scan again\">scan again</button>.";
      const warnH = Math.round(st.getBoundingClientRect().height);
      st.className = prev.cls;
      msg.innerHTML = prev.html;
      const restoredLink = msg.querySelector(".reload-link");
      return {
        text: msg.innerText.replace(/\s+/g, " ").trim(),
        hasLink: !!(link && link.textContent.trim() === "Reload"),
        tag: link ? link.tagName.toLowerCase() : "",
        type: link ? link.getAttribute("type") : "",
        noAnswerH,
        connectedH,
        warnH,
        restoredHasLink: !!(restoredLink && restoredLink.textContent.trim() === "Reload"),
        isConnect: st.classList.contains("is-connect"),
        role: st.getAttribute("role")
      };
    });
    await p.close();
    return { waiting, after: info, ...info };
  }
  const noAnswer = await loadNoAnswer();
  console.log("WAITING", JSON.stringify(noAnswer.waiting));
  console.log("NO-ANSWER", JSON.stringify(noAnswer.after));
  const wait = noAnswer.waiting;
  check("waiting status has animated dots",
    wait.hasDots === true && wait.dotCount === 3 && wait.text === "Waiting for permission... Tap Allow if asked.",
    JSON.stringify(wait));
  check("waiting status is not a connect button while the request is pending",
    wait.isConnect === false && wait.role === "status",
    JSON.stringify(wait));
  check("no-answer status says Reload to try again",
    noAnswer.text === "No answer from the browser. Reload to try again.",
    noAnswer.text);
  check("no-answer status has a Reload link",
    noAnswer.hasLink === true && noAnswer.tag === "button" && noAnswer.type === "button",
    JSON.stringify(noAnswer.after));
  check("no-answer status box height matches other states",
    noAnswer.noAnswerH > 0 && noAnswer.noAnswerH === noAnswer.connectedH && noAnswer.noAnswerH === noAnswer.warnH && noAnswer.noAnswerH === wait.statusH,
    JSON.stringify({ noAnswerH: noAnswer.noAnswerH, connectedH: noAnswer.connectedH, warnH: noAnswer.warnH, waitingH: wait.statusH }));
  check("no-answer status is not a connect button",
    noAnswer.isConnect === false && noAnswer.role === "status" && noAnswer.hasLink === true,
    JSON.stringify(noAnswer.after));

  async function loadDenied() {
    const p = await browser.newPage();
    p.on("pageerror", (err) => jsErrors.push(String(err)));
    await p.evaluateOnNewDocument(() => {
      navigator.requestMIDIAccess = () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) =>
        d && d.name === "midi"
          ? Promise.resolve({ state: "prompt", onchange: null, addEventListener() {}, removeEventListener() {} })
          : q(d);
    });
    await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 300));
    await p.waitForFunction(() => {
      const st = document.getElementById("status");
      return st && st.classList.contains("is-connect");
    }, { timeout: 3000 });
    await p.evaluate(() => document.getElementById("status").click());
    await p.waitForFunction(() => document.body.classList.contains("blocked"), { timeout: 3000 });
    const info = await p.evaluate(() => {
      const st = document.getElementById("status");
      return {
        isConnect: st.classList.contains("is-connect"),
        role: st.getAttribute("role"),
        blocked: document.body.classList.contains("blocked"),
        status: (document.querySelector("#status .msg") || {}).innerText || ""
      };
    });
    await p.close();
    return info;
  }
  const denied = await loadDenied();
  console.log("DENIED", JSON.stringify(denied));
  check("denied status is a message, not a connect button",
    denied.isConnect === false && denied.role === "status" && denied.blocked === true && /isn't allowed|is blocked/.test(denied.status),
    JSON.stringify(denied));

  async function loadHotplug() {
    const p = await browser.newPage();
    p.on("pageerror", (err) => jsErrors.push(String(err)));
    await p.evaluateOnNewDocument(() => {
      function makeInput(id, name, state) {
        const input = {
          id, name, type: "input",
          state: state || "connected",
          connection: "closed",
          _handler: null,
          _sets: 0,
          _messages: 0,
          get onmidimessage() { return this._handler; },
          set onmidimessage(fn) {
            this._sets++;
            this._handler = fn;
          },
          open() {
            this.connection = "open";
            this._opened = (this._opened || 0) + 1;
            return Promise.resolve(this);
          },
          close() { this.connection = "closed"; },
          fire(bytes) {
            if (typeof this._handler === "function") {
              this._messages++;
              this._handler({
                data: bytes,
                timeStamp: performance.now(),
                target: this
              });
            }
          }
        };
        return input;
      }
      function makeAccess() {
        const inputs = new Map();
        const access = {
          inputs,
          outputs: new Map(),
          onstatechange: null,
          sysexEnabled: false,
          _listeners: [],
          addEventListener(type, fn) {
            if (type === "statechange") this._listeners.push(fn);
          },
          removeEventListener(type, fn) {
            this._listeners = this._listeners.filter((f) => f !== fn);
          },
          dispatch(port) {
            const ev = { port, type: "statechange" };
            if (typeof this.onstatechange === "function") this.onstatechange(ev);
            this._listeners.slice().forEach((fn) => fn(ev));
          }
        };
        return access;
      }
      window.__fakeMidi = {
        requestCount: 0,
        access: makeAccess(),
        makeInput,
        makeAccess
      };
      navigator.requestMIDIAccess = () => {
        window.__fakeMidi.requestCount++;
        return Promise.resolve(window.__fakeMidi.access);
      };
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) =>
        d && d.name === "midi"
          ? Promise.resolve({ state: "granted", onchange: null, addEventListener() {}, removeEventListener() {} })
          : q(d);
    });
    await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    // Existing hotplug steps (statechange, Scan again) must not race the
    // silent auto-detect poll. Coverage for that poll is in loadAutoDetect.
    await p.evaluate(() => {
      if (window.__pfTest && window.__pfTest.autoDetect) {
        window.__pfTest.autoDetect({ enabled: false });
      }
    });
    await new Promise((r) => setTimeout(r, 400));

    const empty = await p.evaluate(() => {
      const st = document.getElementById("status");
      const msg = st.querySelector(".msg");
      const link = msg.querySelector(".scan-link");
      return {
        text: msg.innerText.replace(/\s+/g, " ").trim(),
        hasScan: !!(link && link.textContent.trim() === "scan again"),
        hasAccess: document.body.classList.contains("has-access"),
        isConnected: document.body.classList.contains("is-connected"),
        statusH: Math.round(st.getBoundingClientRect().height),
        kbTop: Math.round(document.querySelector(".kb-wrap").getBoundingClientRect().top),
        requests: window.__fakeMidi.requestCount
      };
    });

    // Burst of statechange events for one plug; status should update after the debounce, not immediately.
    await p.evaluate(() => {
      const input = window.__fakeMidi.makeInput("in1", "GarageKey Mini", "connected");
      window.__fakeMidi.input = input;
      window.__fakeMidi.access.inputs.set("in1", input);
      window.__fakeMidi.access.dispatch(input);
      window.__fakeMidi.access.dispatch(input);
      window.__fakeMidi.access.dispatch(input);
    });
    const duringDebounce = await p.evaluate(() => {
      const msg = document.querySelector("#status .msg");
      return {
        text: msg.innerText.replace(/\s+/g, " ").trim(),
        isConnected: document.body.classList.contains("is-connected")
      };
    });
    await new Promise((r) => setTimeout(r, 300));
    const plugged = await p.evaluate(() => {
      const input = window.__fakeMidi.input;
      const msg = document.querySelector("#status .msg");
      const st = document.getElementById("status");
      return {
        text: msg.innerText.replace(/\s+/g, " ").trim(),
        isConnected: document.body.classList.contains("is-connected"),
        opened: input._opened || 0,
        connection: input.connection,
        handlerBound: typeof input.onmidimessage === "function",
        sets: input._sets,
        statusH: Math.round(st.getBoundingClientRect().height),
        kbTop: Math.round(document.querySelector(".kb-wrap").getBoundingClientRect().top)
      };
    });

    // Unplug.
    await p.evaluate(() => {
      const input = window.__fakeMidi.input;
      input.state = "disconnected";
      input.connection = "closed";
      window.__fakeMidi.access.dispatch(input);
    });
    await new Promise((r) => setTimeout(r, 300));
    const unplugged = await p.evaluate(() => {
      const input = window.__fakeMidi.input;
      const msg = document.querySelector("#status .msg");
      const st = document.getElementById("status");
      return {
        text: msg.innerText.replace(/\s+/g, " ").trim(),
        hasScan: !!(msg.querySelector(".scan-link")),
        isConnected: document.body.classList.contains("is-connected"),
        handlerCleared: input.onmidimessage == null,
        sets: input._sets,
        statusH: Math.round(st.getBoundingClientRect().height),
        kbTop: Math.round(document.querySelector(".kb-wrap").getBoundingClientRect().top)
      };
    });

    // Replug the same input; handler should be a single function, one message => one log row.
    await p.evaluate(() => {
      const input = window.__fakeMidi.input;
      input.state = "connected";
      input.connection = "closed";
      window.__fakeMidi.access.dispatch(input);
    });
    await new Promise((r) => setTimeout(r, 300));
    const replugged = await p.evaluate(() => {
      const input = window.__fakeMidi.input;
      const before = window.__pfTest.getState().logLength;
      input.fire(new Uint8Array([0x90, 60, 100]));
      const after = window.__pfTest.getState().logLength;
      return {
        text: document.querySelector("#status .msg").innerText.replace(/\s+/g, " ").trim(),
        isConnected: document.body.classList.contains("is-connected"),
        handlerBound: typeof input.onmidimessage === "function",
        sets: input._sets,
        messages: input._messages,
        logBefore: before,
        logAfter: after,
        held: !!window.__pfTest.getState().held["60"]
      };
    });

    // Unplug again, then add a *new* input without a statechange and tap Scan again.
    await p.evaluate(() => {
      const input = window.__fakeMidi.input;
      input.state = "disconnected";
      window.__fakeMidi.access.inputs.delete("in1");
      window.__fakeMidi.access.dispatch(input);
    });
    await new Promise((r) => setTimeout(r, 300));
    await p.evaluate(() => {
      const next = window.__fakeMidi.makeInput("in2", "Digital Piano", "connected");
      window.__fakeMidi.input2 = next;
      window.__fakeMidi.access.inputs.set("in2", next);
    });
    const beforeScan = await p.evaluate(() => ({
      text: document.querySelector("#status .msg").innerText.replace(/\s+/g, " ").trim(),
      hasScan: !!document.querySelector(".scan-link"),
      requests: window.__fakeMidi.requestCount,
      kbTop: Math.round(document.querySelector(".kb-wrap").getBoundingClientRect().top)
    }));
    const scanning = await p.evaluate(() => {
      document.querySelector(".scan-link").click();
      const st = document.getElementById("status");
      const msg = st.querySelector(".msg");
      return {
        text: msg.innerText.replace(/\s+/g, " ").trim(),
        hasDots: !!msg.querySelector(".dots"),
        statusH: Math.round(st.getBoundingClientRect().height),
        kbTop: Math.round(document.querySelector(".kb-wrap").getBoundingClientRect().top)
      };
    });
    await new Promise((r) => setTimeout(r, 500));
    const afterScan = await p.evaluate(() => {
      const st = document.getElementById("status");
      const msg = st.querySelector(".msg");
      return {
        text: msg.innerText.replace(/\s+/g, " ").trim(),
        isConnected: document.body.classList.contains("is-connected"),
        opened: window.__fakeMidi.input2._opened || 0,
        requests: window.__fakeMidi.requestCount,
        statusH: Math.round(st.getBoundingClientRect().height),
        kbTop: Math.round(document.querySelector(".kb-wrap").getBoundingClientRect().top)
      };
    });

    await p.close();
    return { empty, duringDebounce, plugged, unplugged, replugged, beforeScan, scanning, afterScan };
  }
  // Android app: native MIDI through window.AplusNative replaces Web MIDI.
  async function loadNativeBridge() {
    const p = await browser.newPage();
    p.on("pageerror", (err) => jsErrors.push(String(err)));
    await p.evaluateOnNewDocument(() => {
      window.AplusNative = {
        inputs: () => JSON.stringify([{ id: 7, name: "Garagekey Mini" }]),
        diag: () => JSON.stringify({ sdk: 34, featureMidi: true, featureUsbHost: true, midiManager: true, midi: [],
          usb: [{ name: "Garagekey Mini", vendorId: 1, productId: 2, permission: false, interfaces: [[1, 1], [1, 3]] }],
          events: ["10:00:00 started"] })
      };
    });
    await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 400));
    const statusText = () => document.querySelector("#status .msg").innerText.replace(/\s+/g, " ").trim();
    const plugged = await p.evaluate(statusText);
    const held = await p.evaluate(() => {
      window.aplusMidiMessage(7, [0x90, 60, 100]);
      const on = !!window.__pfTest.getState().held[60];
      window.aplusMidiMessage(7, [0x80, 60, 0]);
      return { on, off: !window.__pfTest.getState().held[60] };
    });
    await p.evaluate(() => window.aplusMidiDevices([]));
    await new Promise((r) => setTimeout(r, 400));
    const unplugged = await p.evaluate(statusText);
    const help = await p.evaluate(() => {
      window.__pfTest.debug.open();
      return { panel: document.getElementById("debug-body").innerText, report: window.__pfTest.debug.report() };
    });
    await p.close();
    return { plugged, held, unplugged, help };
  }
  const native = await loadNativeBridge();
  check("Android native bridge connects, plays notes and sees the unplug",
    native.plugged === "Connected: Garagekey Mini" && native.held.on && native.held.off &&
      /No MIDI keyboard detected/.test(native.unplugged),
    JSON.stringify(native));
  check("Help tab shows native USB/MIDI diagnostics and the report includes them",
    /Native USB\/MIDI/i.test(native.help.panel) && /Android sees a USB MIDI device, but its MIDI service lists none/i.test(native.help.panel) &&
      /1\/3 \(MIDI\)/i.test(native.help.panel) && /Native USB\/MIDI[\s\S]*API 34/.test(native.help.report),
    native.help.panel.slice(native.help.panel.indexOf("NATIVE"), native.help.panel.indexOf("EVENT LOG")));

  const hotplug = await loadHotplug();
  console.log("HOTPLUG", JSON.stringify(hotplug));
  check("no-keyboard status offers Scan again",
    hotplug.empty.hasScan === true && hotplug.empty.hasAccess === true && hotplug.empty.isConnected === false
      && hotplug.empty.text === "No MIDI keyboard detected. Plug one in, or scan again.",
    JSON.stringify(hotplug.empty));
  check("hotplug statechange burst is debounced before connecting",
    hotplug.duringDebounce.isConnected === false && /No MIDI keyboard detected/.test(hotplug.duringDebounce.text)
      && hotplug.plugged.isConnected === true && /Connected: GarageKey Mini/.test(hotplug.plugged.text)
      && hotplug.plugged.opened >= 1 && hotplug.plugged.handlerBound === true,
    JSON.stringify({ duringDebounce: hotplug.duringDebounce, plugged: hotplug.plugged }));
  check("unplug returns to no-keyboard and clears the handler",
    hotplug.unplugged.isConnected === false && hotplug.unplugged.hasScan === true
      && hotplug.unplugged.handlerCleared === true
      && hotplug.unplugged.text === "No MIDI keyboard detected. Plug one in, or scan again.",
    JSON.stringify(hotplug.unplugged));
  check("replug binds a single midimessage handler",
    hotplug.replugged.isConnected === true && hotplug.replugged.handlerBound === true
      && hotplug.replugged.messages === 1
      && hotplug.replugged.logAfter === hotplug.replugged.logBefore + 1
      && hotplug.replugged.held === true,
    JSON.stringify(hotplug.replugged));
  check("Scan again shows scanning dots then finds a newly added input",
    /Scanning/.test(hotplug.scanning.text) && hotplug.scanning.hasDots === true
      && hotplug.afterScan.isConnected === true && /Connected: Digital Piano/.test(hotplug.afterScan.text)
      && hotplug.afterScan.opened >= 1 && hotplug.beforeScan.hasScan === true,
    JSON.stringify({ beforeScan: hotplug.beforeScan, scanning: hotplug.scanning, afterScan: hotplug.afterScan }));
  const hotplugTops = [hotplug.empty.kbTop, hotplug.plugged.kbTop, hotplug.unplugged.kbTop, hotplug.beforeScan.kbTop, hotplug.scanning.kbTop, hotplug.afterScan.kbTop];
  const hotplugHeights = [hotplug.empty.statusH, hotplug.plugged.statusH, hotplug.unplugged.statusH, hotplug.scanning.statusH, hotplug.afterScan.statusH];
  check("hotplug and Scan again keep status height and range-card top constant",
    hotplugTops.every((v) => v === hotplugTops[0] && v > 0)
      && hotplugHeights.every((v) => v === hotplugHeights[0] && v > 0),
    JSON.stringify({ tops: hotplugTops, heights: hotplugHeights }));

  async function loadAutoDetect() {
    function fakeMidiBootstrap(mode) {
      function makeInput(id, name, state) {
        const input = {
          id, name, type: "input",
          state: state || "connected",
          connection: "closed",
          _handler: null,
          _sets: 0,
          _messages: 0,
          get onmidimessage() { return this._handler; },
          set onmidimessage(fn) {
            this._sets++;
            this._handler = fn;
          },
          open() {
            this.connection = "open";
            this._opened = (this._opened || 0) + 1;
            return Promise.resolve(this);
          },
          close() { this.connection = "closed"; },
          fire(bytes) {
            if (typeof this._handler === "function") {
              this._messages++;
              this._handler({
                data: bytes,
                timeStamp: performance.now(),
                target: this
              });
            }
          }
        };
        return input;
      }
      function makeAccess() {
        const inputs = new Map();
        const access = {
          inputs,
          outputs: new Map(),
          onstatechange: null,
          sysexEnabled: false,
          _listeners: [],
          addEventListener(type, fn) {
            if (type === "statechange") this._listeners.push(fn);
          },
          removeEventListener(type, fn) {
            this._listeners = this._listeners.filter((f) => f !== fn);
          },
          dispatch(port) {
            const ev = { port, type: "statechange" };
            if (typeof this.onstatechange === "function") this.onstatechange(ev);
            this._listeners.slice().forEach((fn) => fn(ev));
          }
        };
        return access;
      }
      window.__fakeMidi = {
        requestCount: 0,
        accesses: [],
        handlers: [],
        makeInput,
        makeAccess,
        access: null,
        mode
      };
      if (mode === "fresh-on-refresh") {
        navigator.requestMIDIAccess = () => {
          window.__fakeMidi.requestCount++;
          const a = makeAccess();
          if (window.__fakeMidi.requestCount >= 2 && window.__fakeMidi.pendingInput) {
            a.inputs.set(window.__fakeMidi.pendingInput.id, window.__fakeMidi.pendingInput);
          }
          window.__fakeMidi.access = a;
          window.__fakeMidi.accesses.push(a);
          return Promise.resolve(a);
        };
      } else if (mode === "count-all") {
        window.__fakeMidi.access = makeAccess();
        navigator.requestMIDIAccess = () => {
          window.__fakeMidi.requestCount++;
          return Promise.resolve(window.__fakeMidi.access);
        };
      } else if (mode === "prompt") {
        navigator.requestMIDIAccess = () => {
          window.__fakeMidi.requestCount++;
          const a = makeAccess();
          window.__fakeMidi.access = a;
          return Promise.resolve(a);
        };
      } else {
        window.__fakeMidi.access = makeAccess();
        navigator.requestMIDIAccess = () => {
          window.__fakeMidi.requestCount++;
          return Promise.resolve(window.__fakeMidi.access);
        };
      }
      const perm = mode === "prompt" ? "prompt" : "granted";
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) =>
        d && d.name === "midi"
          ? Promise.resolve({ state: perm, onchange: null, addEventListener() {}, removeEventListener() {} })
          : q(d);
    }

    async function openPage(mode) {
      const p = await browser.newPage();
      p.on("pageerror", (err) => jsErrors.push(String(err)));
      await p.evaluateOnNewDocument(fakeMidiBootstrap, mode || "same-access");
      await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
      await new Promise((r) => setTimeout(r, 400));
      return p;
    }

    function snap(page) {
      return page.evaluate(() => {
        const st = document.getElementById("status");
        const msg = st.querySelector(".msg");
        const input = window.__fakeMidi && (window.__fakeMidi.input || window.__fakeMidi.pendingInput);
        return {
          text: msg.innerText.replace(/\s+/g, " ").trim(),
          hasScan: !!msg.querySelector(".scan-link"),
          scanning: /Scanning/.test(msg.innerText),
          hasDots: !!msg.querySelector(".dots"),
          isConnected: document.body.classList.contains("is-connected"),
          hasAccess: document.body.classList.contains("has-access"),
          isConnect: st.classList.contains("is-connect"),
          role: st.getAttribute("role"),
          requests: window.__fakeMidi.requestCount,
          opened: input && (input._opened || 0),
          sets: input && input._sets,
          messages: input && input._messages,
          handlerBound: !!(input && typeof input.onmidimessage === "function"),
          statusH: Math.round(st.getBoundingClientRect().height),
          kbTop: Math.round(document.querySelector(".kb-wrap").getBoundingClientRect().top),
          auto: window.__pfTest.autoDetect(),
          logLength: window.__pfTest.getState().logLength
        };
      });
    }

    // 1) Device appears on the current MIDIAccess with no statechange.
    const pSilent = await openPage("same-access");
    const silentEmpty = await snap(pSilent);
    await pSilent.evaluate(() => {
      window.__statusTexts = [];
      const msg = document.querySelector("#status .msg");
      const rec = () => window.__statusTexts.push(msg.innerText.replace(/\s+/g, " ").trim());
      rec();
      new MutationObserver(rec).observe(msg, { childList: true, subtree: true, characterData: true });
      const input = window.__fakeMidi.makeInput("in1", "GarageKey Mini", "connected");
      window.__fakeMidi.input = input;
      window.__fakeMidi.access.inputs.set("in1", input);
    });
    await new Promise((r) => setTimeout(r, 2500));
    const silentFound = await snap(pSilent);
    const silentTexts = await pSilent.evaluate(() => window.__statusTexts);
    await pSilent.close();

    // 2) Device only appears on a fresh MIDIAccess (refresh every ~6s).
    const pFresh = await openPage("fresh-on-refresh");
    await pFresh.evaluate(() => {
      window.__statusTexts = [];
      const msg = document.querySelector("#status .msg");
      const rec = () => window.__statusTexts.push(msg.innerText.replace(/\s+/g, " ").trim());
      rec();
      new MutationObserver(rec).observe(msg, { childList: true, subtree: true, characterData: true });
      window.__fakeMidi.pendingInput = window.__fakeMidi.makeInput("in1", "GarageKey Mini", "connected");
    });
    const freshEmpty = await snap(pFresh);
    await new Promise((r) => setTimeout(r, 6500));
    const freshFound = await snap(pFresh);
    const freshTexts = await pFresh.evaluate(() => window.__statusTexts);
    await pFresh.close();

    // 3–4) Pause while hidden, refresh on visible, stop once connected.
    // Shorter intervals so the pause/stop checks don't take many seconds.
    const pPause = await openPage("same-access");
    await pPause.evaluate(() => {
      window.__pfTest.autoDetect({ enumerateMs: 150, refreshEvery: 3 });
    });
    await new Promise((r) => setTimeout(r, 550));
    const pauseBeforeHide = await snap(pPause);
    await pPause.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hiddenSnap = await snap(pPause);
    await new Promise((r) => setTimeout(r, 700));
    const stillHidden = await snap(pPause);
    await pPause.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await new Promise((r) => setTimeout(r, 200));
    const afterShow = await snap(pPause);
    await pPause.evaluate(() => {
      const input = window.__fakeMidi.makeInput("in1", "GarageKey Mini", "connected");
      window.__fakeMidi.input = input;
      window.__fakeMidi.access.inputs.set("in1", input);
    });
    await new Promise((r) => setTimeout(r, 250));
    const pauseConnected = await snap(pPause);
    const reqAfterConnect = pauseConnected.requests;
    await new Promise((r) => setTimeout(r, 700));
    const stillConnected = await snap(pPause);
    await pPause.close();

    // 5) Many poll/refresh cycles must not stack onmidimessage handlers.
    const pDup = await openPage("same-access");
    await pDup.evaluate(() => {
      window.__fakeMidi.input = window.__fakeMidi.makeInput("in1", "GarageKey Mini", "connected");
      window.__pfTest.autoDetect({ enumerateMs: 50, refreshEvery: 2 });
    });
    await new Promise((r) => setTimeout(r, 550));
    const dupBefore = await snap(pDup);
    await pDup.evaluate(() => {
      window.__fakeMidi.access.inputs.set("in1", window.__fakeMidi.input);
    });
    await new Promise((r) => setTimeout(r, 150));
    const dupAfter = await pDup.evaluate(() => {
      const input = window.__fakeMidi.input;
      const before = window.__pfTest.getState().logLength;
      input.fire(new Uint8Array([0x90, 60, 100]));
      const after = window.__pfTest.getState().logLength;
      return {
        text: document.querySelector("#status .msg").innerText.replace(/\s+/g, " ").trim(),
        isConnected: document.body.classList.contains("is-connected"),
        sets: input._sets,
        messages: input._messages,
        logBefore: before,
        logAfter: after,
        held: !!window.__pfTest.getState().held["60"],
        handlerBound: typeof input.onmidimessage === "function",
        opened: input._opened || 0,
        requests: window.__fakeMidi.requestCount,
        cycles: window.__pfTest.autoDetect().cycles,
        kbTop: Math.round(document.querySelector(".kb-wrap").getBoundingClientRect().top)
      };
    });
    await pDup.close();

    // 6) Auto-rescan must never call requestMIDIAccess in the prompt state.
    const pPrompt = await openPage("prompt");
    const promptStart = await snap(pPrompt);
    await pPrompt.evaluate(() => {
      if (window.__pfTest && window.__pfTest.autoDetect) {
        window.__pfTest.autoDetect({ enabled: true, enumerateMs: 50, refreshEvery: 2 });
      }
    });
    await new Promise((r) => setTimeout(r, 800));
    const promptLater = await snap(pPrompt);
    await pPrompt.close();

    return {
      silentEmpty, silentFound, silentTexts,
      freshEmpty, freshFound, freshTexts,
      pauseBeforeHide, hiddenSnap, stillHidden, afterShow, pauseConnected, stillConnected, reqAfterConnect,
      dupBefore, dupAfter,
      promptStart, promptLater
    };
  }
  const auto = await loadAutoDetect();
  console.log("AUTODETECT", JSON.stringify({
    silentEmpty: auto.silentEmpty,
    silentFound: auto.silentFound,
    silentTexts: auto.silentTexts,
    freshEmpty: auto.freshEmpty,
    freshFound: auto.freshFound,
    freshTexts: auto.freshTexts,
    pauseBeforeHide: auto.pauseBeforeHide,
    hiddenSnap: auto.hiddenSnap,
    stillHidden: auto.stillHidden,
    afterShow: auto.afterShow,
    pauseConnected: auto.pauseConnected,
    stillConnected: auto.stillConnected,
    dupBefore: auto.dupBefore,
    dupAfter: auto.dupAfter,
    promptStart: auto.promptStart,
    promptLater: auto.promptLater
  }));
  const silentFlicker = (auto.silentTexts || []).some((t) => /Scanning/.test(t));
  const freshFlicker = (auto.freshTexts || []).some((t) => /Scanning/.test(t));
  check("auto-detect finds a device that appears without a statechange, with no Scanning flicker",
    auto.silentEmpty.hasAccess === true && auto.silentEmpty.isConnected === false
      && auto.silentEmpty.hasScan === true && /No MIDI keyboard detected/.test(auto.silentEmpty.text)
      && auto.silentFound.isConnected === true && /Connected: GarageKey Mini/.test(auto.silentFound.text)
      && auto.silentFound.scanning !== true && silentFlicker === false
      && (auto.silentFound.opened || 0) >= 1 && auto.silentFound.handlerBound === true,
    JSON.stringify({ empty: auto.silentEmpty, found: auto.silentFound, texts: auto.silentTexts }));
  check("auto-detect finds a device that only appears on a fresh MIDIAccess, with no Scanning flicker",
    auto.freshEmpty.isConnected === false && /No MIDI keyboard detected/.test(auto.freshEmpty.text)
      && auto.freshFound.isConnected === true && /Connected: GarageKey Mini/.test(auto.freshFound.text)
      && auto.freshFound.requests >= 2 && freshFlicker === false
      && (auto.freshFound.opened || 0) >= 1,
    JSON.stringify({ empty: auto.freshEmpty, found: auto.freshFound, texts: auto.freshTexts }));
  check("auto-detect polling pauses while the document is hidden and refreshes when visible",
    auto.stillHidden.requests === auto.hiddenSnap.requests
      && auto.afterShow.requests > auto.stillHidden.requests
      && auto.hiddenSnap.auto.scheduled === false
      && auto.stillHidden.isConnected === false,
    JSON.stringify({
      beforeHide: auto.pauseBeforeHide,
      hidden: auto.hiddenSnap,
      stillHidden: auto.stillHidden,
      afterShow: auto.afterShow
    }));
  check("auto-detect polling stops once a keyboard is connected",
    auto.pauseConnected.isConnected === true && /Connected: GarageKey Mini/.test(auto.pauseConnected.text)
      && auto.stillConnected.isConnected === true
      && auto.stillConnected.requests === auto.reqAfterConnect
      && auto.stillConnected.auto.scheduled === false,
    JSON.stringify({ connected: auto.pauseConnected, later: auto.stillConnected }));
  check("auto-detect does not stack midimessage handlers after many poll cycles",
    auto.dupAfter.isConnected === true && auto.dupAfter.handlerBound === true
      && auto.dupAfter.sets === 1 && auto.dupAfter.messages === 1
      && auto.dupAfter.logAfter === auto.dupAfter.logBefore + 1
      && auto.dupAfter.held === true
      && (auto.dupBefore.auto.cycles || 0) >= 4,
    JSON.stringify({ before: auto.dupBefore, after: auto.dupAfter }));
  check("auto-detect never calls requestMIDIAccess while permission is prompt",
    auto.promptStart.requests === 0 && auto.promptLater.requests === 0
      && auto.promptLater.isConnect === true && auto.promptLater.role === "button"
      && auto.promptLater.hasAccess === false,
    JSON.stringify({ start: auto.promptStart, later: auto.promptLater }));
  const autoTops = [
    auto.silentEmpty.kbTop, auto.silentFound.kbTop,
    auto.freshEmpty.kbTop, auto.freshFound.kbTop,
    auto.pauseConnected.kbTop, auto.stillConnected.kbTop
  ];
  const autoHeights = [
    auto.silentEmpty.statusH, auto.silentFound.statusH,
    auto.freshEmpty.statusH, auto.freshFound.statusH,
    auto.pauseConnected.statusH, auto.stillConnected.statusH
  ];
  check("auto-detect keeps status height and range-card top constant",
    autoTops.every((v) => v === autoTops[0] && v > 0)
      && autoHeights.every((v) => v === autoHeights[0] && v > 0),
    JSON.stringify({ tops: autoTops, heights: autoHeights }));

  async function loadResume() {
    function fakeMidiBootstrap(mode) {
      function makeInput(id, name, state) {
        const input = {
          id, name, type: "input",
          state: state || "connected",
          connection: "closed",
          _handler: null,
          _sets: 0,
          _messages: 0,
          get onmidimessage() { return this._handler; },
          set onmidimessage(fn) {
            this._sets++;
            this._handler = fn;
          },
          open() {
            this.connection = "open";
            this._opened = (this._opened || 0) + 1;
            return Promise.resolve(this);
          },
          close() { this.connection = "closed"; this._closed = (this._closed || 0) + 1; },
          fire(bytes) {
            if (typeof this._handler === "function") {
              this._messages++;
              this._handler({
                data: bytes,
                timeStamp: performance.now(),
                target: this
              });
            }
          }
        };
        return input;
      }
      function makeAccess() {
        const inputs = new Map();
        const access = {
          inputs,
          outputs: new Map(),
          onstatechange: null,
          sysexEnabled: false,
          _listeners: [],
          addEventListener(type, fn) {
            if (type === "statechange") this._listeners.push(fn);
          },
          removeEventListener(type, fn) {
            this._listeners = this._listeners.filter((f) => f !== fn);
          },
          dispatch(port) {
            const ev = { port, type: "statechange" };
            if (typeof this.onstatechange === "function") this.onstatechange(ev);
            this._listeners.slice().forEach((fn) => fn(ev));
          }
        };
        return access;
      }
      window.__fakeMidi = { requestCount: 0, makeInput, makeAccess, mode, accesses: [] };
      const perm = mode === "prompt" ? "prompt" : mode === "denied" ? "denied" : "granted";
      if (mode === "stale-on-resume") {
        const first = makeAccess();
        const input1 = makeInput("in1", "GarageKey Mini", "connected");
        first.inputs.set("in1", input1);
        window.__fakeMidi.access = first;
        window.__fakeMidi.input1 = input1;
        window.__fakeMidi.accesses.push(first);
        navigator.requestMIDIAccess = () => {
          window.__fakeMidi.requestCount++;
          if (window.__fakeMidi.requestCount === 1) {
            return Promise.resolve(window.__fakeMidi.access);
          }
          const next = makeAccess();
          const input2 = makeInput("in1", "GarageKey Mini", "connected");
          next.inputs.set("in1", input2);
          window.__fakeMidi.newAccess = next;
          window.__fakeMidi.input2 = input2;
          window.__fakeMidi.access = next;
          window.__fakeMidi.accesses.push(next);
          return Promise.resolve(next);
        };
      } else {
        window.__fakeMidi.access = makeAccess();
        navigator.requestMIDIAccess = () => {
          window.__fakeMidi.requestCount++;
          return Promise.resolve(window.__fakeMidi.access);
        };
      }
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) =>
        d && d.name === "midi"
          ? Promise.resolve({ state: perm, onchange: null, addEventListener() {}, removeEventListener() {} })
          : q(d);
    }

    async function openPage(mode) {
      const p = await browser.newPage();
      p.on("pageerror", (err) => jsErrors.push(String(err)));
      await p.evaluateOnNewDocument(fakeMidiBootstrap, mode);
      await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
      await new Promise((r) => setTimeout(r, 400));
      return p;
    }

    function hidePage(page, opts) {
      const freeze = !!(opts && opts.freeze);
      return page.evaluate((freeze) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        if (freeze) document.dispatchEvent(new Event("freeze"));
      }, freeze);
    }
    function showBurst(page, opts) {
      const resume = !!(opts && opts.resume);
      const persisted = !!(opts && opts.persisted);
      return page.evaluate((resume, persisted) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("pageshow"));
        if (persisted) {
          try { window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); }
          catch (e) { window.dispatchEvent(new Event("pageshow")); }
        }
        if (resume) document.dispatchEvent(new Event("resume"));
      }, resume, persisted);
    }

    // 1) Connected, hide long enough, old access goes stale, new access works.
    const pStale = await openPage("stale-on-resume");
    const before = await pStale.evaluate(() => {
      const input = window.__fakeMidi.input1;
      const beforeLog = window.__pfTest.getState().logLength;
      input.fire(new Uint8Array([0x90, 60, 100]));
      window.__statusTexts = [];
      const msg = document.querySelector("#status .msg");
      const rec = () => window.__statusTexts.push(msg.innerText.replace(/\s+/g, " ").trim());
      rec();
      new MutationObserver(rec).observe(msg, { childList: true, subtree: true, characterData: true });
      return {
        text: msg.innerText.replace(/\s+/g, " ").trim(),
        isConnected: document.body.classList.contains("is-connected"),
        requests: window.__fakeMidi.requestCount,
        opened: input._opened || 0,
        sets: input._sets,
        messages: input._messages,
        logAfter: window.__pfTest.getState().logLength,
        logBefore: beforeLog,
        held: !!window.__pfTest.getState().held["60"],
        listeners: window.__fakeMidi.accesses[0]._listeners.length
      };
    });
    await hidePage(pStale, { freeze: true });
    const hiddenHeld = await pStale.evaluate(() => {
      const el = document.querySelector("[data-note='60']");
      const st = window.__pfTest.getState();
      return {
        heldClass: el ? el.classList.contains("held") : null,
        heldCount: st.heldCount,
        sustainOn: st.sustainOn,
        sustained: st.sustained.slice(),
        requests: window.__fakeMidi.requestCount,
        oldHandler: typeof window.__fakeMidi.input1.onmidimessage === "function"
      };
    });
    await new Promise((r) => setTimeout(r, 1100));
    await showBurst(pStale, { resume: true });
    await new Promise((r) => setTimeout(r, 200));
    const after = await pStale.evaluate(() => {
      const oldInput = window.__fakeMidi.input1;
      const newInput = window.__fakeMidi.input2;
      const logBeforeFire = window.__pfTest.getState().logLength;
      const oldLogBefore = logBeforeFire;
      oldInput.fire(new Uint8Array([0x90, 64, 100]));
      const afterOldFire = window.__pfTest.getState().logLength;
      const beforeNew = window.__pfTest.getState().logLength;
      if (newInput) newInput.fire(new Uint8Array([0x90, 67, 100]));
      const afterNew = window.__pfTest.getState().logLength;
      const msg = document.querySelector("#status .msg");
      return {
        text: msg.innerText.replace(/\s+/g, " ").trim(),
        isConnected: document.body.classList.contains("is-connected"),
        scanning: /Scanning/.test(msg.innerText),
        texts: window.__statusTexts.slice(),
        requests: window.__fakeMidi.requestCount,
        accessCount: window.__fakeMidi.accesses.length,
        oldHandler: typeof oldInput.onmidimessage === "function",
        oldClosed: oldInput._closed || 0,
        oldConnection: oldInput.connection,
        oldListeners: window.__fakeMidi.accesses[0]._listeners.length,
        oldMessagesAfter: oldInput._messages,
        newBound: !!(newInput && typeof newInput.onmidimessage === "function"),
        newSets: newInput && newInput._sets,
        newOpened: newInput && (newInput._opened || 0),
        newMessages: newInput && newInput._messages,
        logBeforeNew: beforeNew,
        logAfterOldFire: afterOldFire,
        logAfterNew: afterNew,
        held67: !!window.__pfTest.getState().held["67"],
        held64: !!window.__pfTest.getState().held["64"]
      };
    });
    await pStale.close();

    // 2) Short hide while connected must not refresh (clearly safe).
    const pShort = await openPage("stale-on-resume");
    const shortBefore = await pShort.evaluate(() => window.__fakeMidi.requestCount);
    await hidePage(pShort);
    await new Promise((r) => setTimeout(r, 200));
    await showBurst(pShort);
    await new Promise((r) => setTimeout(r, 200));
    const shortAfter = await pShort.evaluate(() => ({
      requests: window.__fakeMidi.requestCount,
      isConnected: document.body.classList.contains("is-connected"),
      sameInput: !!window.__fakeMidi.input1 && !window.__fakeMidi.input2,
      handler: typeof window.__fakeMidi.input1.onmidimessage === "function"
    }));
    await pShort.close();

    // 3) prompt and denied must not request MIDI on a hide/show burst.
    const pPrompt = await openPage("prompt");
    const promptStart = await pPrompt.evaluate(() => window.__fakeMidi.requestCount);
    await hidePage(pPrompt, { freeze: true });
    await new Promise((r) => setTimeout(r, 1100));
    await showBurst(pPrompt, { resume: true });
    await new Promise((r) => setTimeout(r, 200));
    const promptAfter = await pPrompt.evaluate(() => ({
      requests: window.__fakeMidi.requestCount,
      isConnect: document.getElementById("status").classList.contains("is-connect"),
      hasAccess: document.body.classList.contains("has-access")
    }));
    await pPrompt.close();

    const pDenied = await openPage("denied");
    const deniedStart = await pDenied.evaluate(() => window.__fakeMidi.requestCount);
    await hidePage(pDenied, { freeze: true });
    await new Promise((r) => setTimeout(r, 1100));
    await showBurst(pDenied, { resume: true });
    await new Promise((r) => setTimeout(r, 200));
    const deniedAfter = await pDenied.evaluate(() => ({
      requests: window.__fakeMidi.requestCount,
      blocked: document.body.classList.contains("blocked")
    }));
    await pDenied.close();

    return {
      before, hiddenHeld, after,
      shortBefore, shortAfter,
      promptStart, promptAfter,
      deniedStart, deniedAfter
    };
  }
  const resume = await loadResume();
  console.log("RESUME", JSON.stringify(resume));
  const resumeFlicker = (resume.after.texts || []).some((t) => /Scanning/.test(t));
  check("returning to the tab replaces a stale MIDIAccess and receives notes on the new input",
    resume.before.isConnected === true && /Connected: GarageKey Mini/.test(resume.before.text)
      && resume.before.messages === 1 && resume.before.held === true
      && resume.after.isConnected === true && /Connected: GarageKey Mini/.test(resume.after.text)
      && resume.after.scanning !== true && resumeFlicker === false
      && resume.after.newBound === true && (resume.after.newOpened || 0) >= 1
      && resume.after.newMessages === 1
      && resume.after.logAfterNew === resume.after.logBeforeNew + 1
      && resume.after.held67 === true && resume.after.held64 !== true,
    JSON.stringify({ before: resume.before, after: resume.after }));
  check("returning to the tab requests MIDIAccess once per visibility burst",
    resume.after.requests === resume.before.requests + 1
      && resume.after.accessCount === 2,
    JSON.stringify({ before: resume.before.requests, after: resume.after.requests, accesses: resume.after.accessCount }));
  check("returning to the tab detaches the old MIDIAccess handlers",
    resume.after.oldHandler === false
      && resume.after.oldListeners === 0
      && (resume.after.oldClosed || 0) >= 1
      && resume.after.oldConnection === "closed"
      && resume.after.logAfterOldFire === resume.after.logBeforeNew
      && resume.after.newSets === 1,
    JSON.stringify(resume.after));
  check("held keys and sustain are cleared when the tab is hidden",
    resume.before.held === true
      && resume.hiddenHeld.heldClass === false
      && resume.hiddenHeld.heldCount === 0
      && resume.hiddenHeld.sustainOn === false
      && resume.hiddenHeld.sustained.length === 0,
    JSON.stringify({ before: resume.before, hidden: resume.hiddenHeld }));
  check("a trivially short hide while connected does not refresh MIDIAccess",
    resume.shortAfter.requests === resume.shortBefore
      && resume.shortAfter.isConnected === true
      && resume.shortAfter.sameInput === true
      && resume.shortAfter.handler === true,
    JSON.stringify({ before: resume.shortBefore, after: resume.shortAfter }));
  check("returning to the tab never calls requestMIDIAccess while permission is prompt or denied",
    resume.promptStart === 0 && resume.promptAfter.requests === 0
      && resume.promptAfter.isConnect === true && resume.promptAfter.hasAccess === false
      && resume.deniedStart === 0 && resume.deniedAfter.requests === 0
      && resume.deniedAfter.blocked === true,
    JSON.stringify({ promptStart: resume.promptStart, promptAfter: resume.promptAfter, deniedStart: resume.deniedStart, deniedAfter: resume.deniedAfter }));

  async function loadDebug() {
    function fakeMidiBootstrap(mode) {
      function makeInput(id, name, manufacturer, state) {
        return {
          id, name, manufacturer: manufacturer || "", type: "input",
          state: state || "connected",
          connection: "closed",
          _handler: null,
          get onmidimessage() { return this._handler; },
          set onmidimessage(fn) { this._handler = fn; },
          open() { this.connection = "open"; return Promise.resolve(this); },
          close() { this.connection = "closed"; }
        };
      }
      function makeOutput(id, name) {
        return { id, name, type: "output", state: "connected", connection: "closed", manufacturer: "" };
      }
      function makeAccess() {
        const inputs = new Map();
        const outputs = new Map();
        const access = {
          inputs, outputs, onstatechange: null, sysexEnabled: false, _listeners: [],
          addEventListener(type, fn) { if (type === "statechange") this._listeners.push(fn); },
          removeEventListener(type, fn) { this._listeners = this._listeners.filter((f) => f !== fn); },
          dispatch(port) {
            const ev = { port, type: "statechange" };
            if (typeof this.onstatechange === "function") this.onstatechange(ev);
            this._listeners.slice().forEach((fn) => fn(ev));
          }
        };
        return access;
      }
      const access = makeAccess();
      window.__fakeMidi = { requestCount: 0, access, makeInput, makeOutput };
      if (mode === "with-input") {
        const input = makeInput("in1", "GarageKey Mini", "Miditech", "connected");
        access.inputs.set("in1", input);
        const output = makeOutput("out1", "GarageKey Mini");
        access.outputs.set("out1", output);
        window.__fakeMidi.input = input;
      }
      navigator.requestMIDIAccess = () => {
        window.__fakeMidi.requestCount++;
        return Promise.resolve(window.__fakeMidi.access);
      };
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) =>
        d && d.name === "midi"
          ? Promise.resolve({ state: "granted", onchange: null, addEventListener() {}, removeEventListener() {} })
          : q(d);
    }
    async function openPage(mode, hash) {
      const p = await browser.newPage();
      p.on("pageerror", (err) => jsErrors.push(String(err)));
      await p.evaluateOnNewDocument(() => { try { localStorage.removeItem("aplus.pane.v1"); localStorage.removeItem("aplus.sound.v1"); } catch (e) {} });
      await p.evaluateOnNewDocument(fakeMidiBootstrap, mode || "empty");
      await p.goto(URL + (hash || ""), { waitUntil: "domcontentloaded", timeout: 15000 });
      await new Promise((r) => setTimeout(r, 400));
      return p;
    }
    function panelInfo(page) {
      return page.evaluate(() => {
        const panel = document.getElementById("debug-panel");
        const help = document.getElementById("panel-help");
        const stats = document.getElementById("panel-stats");
        const log = document.getElementById("panel-log");
        const sw = document.getElementById("pane-switch");
        const st = document.getElementById("status");
        const kb = document.querySelector(".kb-wrap");
        const body = document.getElementById("debug-body");
        const summary = document.getElementById("debug-summary");
        const lastNote = document.querySelector(".now-card");
        const midiLog = document.getElementById("log");
        const text = ((summary && summary.innerText || "") + " " + (body && body.innerText || "")).replace(/\s+/g, " ").trim();
        const selected = sw && [...sw.querySelectorAll('[role="tab"]')].find((t) => t.getAttribute("aria-selected") === "true");
        const visible = (el) => !!(el && !el.hidden && el.getBoundingClientRect().height > 0);
        return {
          pane: window.__pfTest.debug.pane(),
          selected: selected ? selected.textContent.trim() : "",
          switchVisible: visible(sw),
          switchRole: sw ? sw.getAttribute("role") : null,
          tabCount: sw ? sw.querySelectorAll('[role="tab"]').length : 0,
          linkVisible: !!document.getElementById("btn-troubleshoot"),
          showLogVisible: !!document.getElementById("btn-log"),
          open: window.__pfTest.debug.isOpen(),
          statsVisible: visible(stats),
          logVisible: visible(log),
          helpVisible: visible(help),
          lastNoteVisible: !!(lastNote && lastNote.getBoundingClientRect().height > 0 && !stats.hidden),
          logControls: !!(log && !log.hidden && document.getElementById("filter-rt") && document.getElementById("btn-clear")),
          midiLogVisible: !!(midiLog && midiLog.getBoundingClientRect().height > 0 && !log.hidden),
          panelVisible: visible(help) && visible(panel),
          text,
          statusTop: Math.round(st.getBoundingClientRect().top),
          statusH: Math.round(st.getBoundingClientRect().height),
          kbTop: Math.round(kb.getBoundingClientRect().top),
          kbBottom: Math.round(kb.getBoundingClientRect().bottom),
          switchTop: sw ? Math.round(sw.getBoundingClientRect().top) : null,
          panelTop: help && !help.hidden ? Math.round(help.getBoundingClientRect().top) : null,
          stageH: Math.round(document.getElementById("pane-stage").getBoundingClientRect().height),
          report: window.__pfTest.debug.report()
        };
      });
    }

    // Default is Stats. Switching to Help, Log, then back must not move status, keyboard, or the switch.
    const pLink = await openPage("empty");
    const before = await panelInfo(pLink);
    await pLink.evaluate(() => document.getElementById("tab-help").click());
    await new Promise((r) => setTimeout(r, 50));
    const opened = await panelInfo(pLink);
    // Phone portrait (the browser's default viewport is 412×915, touch): the report must scroll inside the pane.
    const helpScroll = await pLink.evaluate(() => {
      const el = document.getElementById("debug-body");
      const start = el.scrollTop;
      el.scrollTop = start + Math.min(80, Math.max(1, el.scrollHeight - el.clientHeight));
      const after = el.scrollTop;
      el.scrollTop = start;
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, start, after };
    });
    await pLink.evaluate(() => document.getElementById("tab-log").click());
    await new Promise((r) => setTimeout(r, 50));
    const onLog = await panelInfo(pLink);
    await pLink.evaluate(() => {
      const ev = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true });
      document.getElementById("pane-switch").dispatchEvent(ev);
    });
    await new Promise((r) => setTimeout(r, 50));
    const afterArrow = await panelInfo(pLink);
    await pLink.close();

    // #debug opens the panel with a connected device and lists inputs.
    const pHash = await openPage("with-input", "#debug");
    const hashed = await panelInfo(pHash);
    await pHash.close();

    // Copy report includes the inputs count; statechange updates the open panel.
    const pLive = await openPage("empty");
    await pLive.evaluate(() => window.__pfTest.debug.open());
    await new Promise((r) => setTimeout(r, 50));
    const emptyOpen = await panelInfo(pLive);
    const copied = await pLive.evaluate(() => {
      window.__copied = null;
      if (navigator.clipboard) {
        navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); };
      }
      document.getElementById("btn-debug-copy").click();
      return window.__copied || window.__pfTest.debug.report();
    });
    await pLive.evaluate(() => {
      const input = window.__fakeMidi.makeInput("in1", "GarageKey Mini", "Miditech", "connected");
      window.__fakeMidi.input = input;
      window.__fakeMidi.access.inputs.set("in1", input);
      window.__fakeMidi.access.dispatch(input);
    });
    await new Promise((r) => setTimeout(r, 300)); // statechange debounce 200ms
    const afterChange = await panelInfo(pLive);
    await pLive.close();

    return { before, opened, onLog, afterArrow, hashed, emptyOpen, copied, afterChange, helpScroll };
  }
  const dbg = await loadDebug();
  console.log("DEBUG", JSON.stringify({
    before: { ...dbg.before, report: undefined, text: (dbg.before.text || "").slice(0, 80) },
    opened: { ...dbg.opened, report: undefined, text: (dbg.opened.text || "").slice(0, 200) },
    hashed: { ...dbg.hashed, report: undefined, text: (dbg.hashed.text || "").slice(0, 200) },
    emptyOpen: { ...dbg.emptyOpen, report: undefined, text: (dbg.emptyOpen.text || "").slice(0, 160) },
    copiedHead: (dbg.copied || "").split("\\n").slice(0, 12).join(" | "),
    afterChange: { ...dbg.afterChange, report: undefined, text: (dbg.afterChange.text || "").slice(0, 200) }
  }));
  check("Stats is the default section of the switch",
    dbg.before.pane === "stats" && dbg.before.selected === "Stats"
      && dbg.before.switchVisible === true && dbg.before.switchRole === "tablist"
      && dbg.before.tabCount === 3
      && dbg.before.statsVisible === true && dbg.before.lastNoteVisible === true
      && dbg.before.helpVisible === false && dbg.before.logVisible === false
      && dbg.before.open === false && dbg.before.linkVisible === false
      && dbg.before.showLogVisible === false,
    JSON.stringify({ before: { pane: dbg.before.pane, selected: dbg.before.selected, stats: dbg.before.statsVisible, help: dbg.before.helpVisible, link: dbg.before.linkVisible, showLog: dbg.before.showLogVisible } }));
  check("troubleshooting panel opens via #debug and lists fake MIDI inputs",
    dbg.hashed.open === true && dbg.hashed.panelVisible === true
      && dbg.hashed.pane === "help" && dbg.hashed.selected === "Help"
      && /Devices/i.test(dbg.hashed.text) && /GarageKey Mini/.test(dbg.hashed.text)
      && /Keyboard connected: GarageKey Mini/i.test(dbg.hashed.text)
      && /Inputs \(1\)/.test(dbg.hashed.report)
      && /Miditech/.test(dbg.hashed.text)
      && /Outputs \(1\)/.test(dbg.hashed.report)
      && /^Connection$/m.test(dbg.hashed.report)
      && /^Browser$/m.test(dbg.hashed.report)
      && /Sound profile:/.test(dbg.hashed.report)
      && /Sound profile/i.test(dbg.hashed.text)
      && /Small speaker|Full range/.test(dbg.hashed.report),
    JSON.stringify({ pane: dbg.hashed.pane, text: dbg.hashed.text.slice(0, 240), report: (dbg.hashed.report || "").split("\\n").slice(0, 16) }));
  check("troubleshooting Copy report includes the inputs count",
    typeof dbg.copied === "string" && /Inputs \(0\)/.test(dbg.copied)
      && /Browser sees no MIDI keyboard/.test(dbg.copied)
      && /^Devices$/m.test(dbg.copied)
      && /^Connection$/m.test(dbg.copied)
      && /^Browser$/m.test(dbg.copied)
      && /Web MIDI support:/.test(dbg.copied)
      && /Permission:/.test(dbg.copied)
      && /Sound profile: (Small speaker|Full range)\./.test(dbg.copied),
    (dbg.copied || "").slice(0, 400));
  check("troubleshooting panel updates when a statechange adds an input",
    /Inputs \(0\)/.test(dbg.emptyOpen.report)
      && /Browser sees no MIDI keyboard/.test(dbg.emptyOpen.report)
      && /GarageKey Mini/.test(dbg.afterChange.text)
      && /Keyboard connected: GarageKey Mini/.test(dbg.afterChange.report)
      && /Inputs \(1\)/.test(dbg.afterChange.report)
      && /State change:/.test(dbg.afterChange.text),
    JSON.stringify({ empty: (dbg.emptyOpen.report || "").split("\\n").slice(0, 14), after: dbg.afterChange.text.slice(0, 240) }));
  check("the Log tab shows the MIDI log and its controls",
    dbg.onLog.pane === "log" && dbg.onLog.selected === "Log"
      && dbg.onLog.logVisible === true && dbg.onLog.midiLogVisible === true
      && dbg.onLog.logControls === true
      && dbg.onLog.statsVisible === false && dbg.onLog.helpVisible === false,
    JSON.stringify({ onLog: { pane: dbg.onLog.pane, logVisible: dbg.onLog.logVisible, controls: dbg.onLog.logControls } }));
  check("switching Stats, Log, and Help does not move the status box, keyboard, or switch",
    dbg.before.statusTop === dbg.opened.statusTop
      && dbg.before.statusTop === dbg.onLog.statusTop
      && dbg.before.statusH === dbg.opened.statusH
      && dbg.before.statusH === dbg.onLog.statusH
      && dbg.before.kbTop === dbg.opened.kbTop
      && dbg.before.kbTop === dbg.onLog.kbTop
      && dbg.before.switchTop === dbg.opened.switchTop
      && dbg.before.switchTop === dbg.onLog.switchTop
      && dbg.opened.stageH === dbg.before.stageH
      && dbg.onLog.stageH === dbg.before.stageH
      && dbg.opened.panelTop != null && dbg.opened.panelTop >= dbg.opened.kbBottom
      && dbg.before.switchTop >= dbg.before.kbBottom
      && dbg.before.statusTop > 0 && dbg.before.kbTop > 0
      && dbg.opened.open === true && dbg.opened.panelVisible === true
      && /Devices/i.test(dbg.opened.text) && /Browser sees no MIDI keyboard/i.test(dbg.opened.text)
      && dbg.afterArrow.pane === "help" && dbg.afterArrow.selected === "Help",
    JSON.stringify({ before: { statusTop: dbg.before.statusTop, statusH: dbg.before.statusH, kbTop: dbg.before.kbTop, switchTop: dbg.before.switchTop, stageH: dbg.before.stageH }, opened: { statusTop: dbg.opened.statusTop, kbTop: dbg.opened.kbTop, switchTop: dbg.opened.switchTop, stageH: dbg.opened.stageH, panelTop: dbg.opened.panelTop }, onLog: { statusTop: dbg.onLog.statusTop, switchTop: dbg.onLog.switchTop, stageH: dbg.onLog.stageH }, afterArrow: { pane: dbg.afterArrow.pane } }));

  check("Help report scrolls on a phone",
    dbg.helpScroll.scrollHeight > dbg.helpScroll.clientHeight && dbg.helpScroll.after > dbg.helpScroll.start,
    JSON.stringify(dbg.helpScroll));

  // The range card (everything below the status box) must not shift as states change.
  const DOTS = '<span class="dots"><span>.</span><span>.</span><span>.</span></span>';
  const layoutStates = [
    ["checking", "", "status is-warn", "Checking for MIDI" + DOTS],
    ["button", "", "status is-connect", "Tap to connect MIDI keyboard"],
    ["waiting", "", "status is-warn", "Waiting for permission" + DOTS + "<br>Tap <strong>Allow</strong> if asked."],
    ["connected", "has-access is-connected", "status is-ok", "Connected: <strong>Digital Piano</strong>"],
    ["denied", "blocked", "status is-err", "MIDI isn't allowed for this site.<br>Allow MIDI in the browser's site settings."],
    ["no-answer", "", "status is-err", "No answer from the browser.<br><button type=\"button\" class=\"reload-link\">Reload</button> to try again."],
    ["no-keyboard", "has-access", "status is-warn", "No MIDI keyboard detected.<br>Plug one in, or <button type=\"button\" class=\"scan-link\" aria-label=\"scan again\">scan again</button>."],
    ["scanning", "has-access", "status is-warn", "Scanning" + DOTS]
  ];
  async function measureBelow(w, h, mobile) {
    const p = await browser.newPage();
    p.on("pageerror", (err) => jsErrors.push(String(err)));
    await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: !!mobile, hasTouch: !!mobile });
    await p.evaluateOnNewDocument(() => { try { localStorage.removeItem("aplus.pane.v1"); localStorage.removeItem("aplus.sound.v1"); } catch (e) {} });
    await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 200));
    const info = await p.evaluate((states) => {
      const st = document.getElementById("status");
      const msg = st.querySelector(".msg");
      const prev = {
        body: document.body.className,
        status: st.className,
        html: msg.innerHTML,
        role: st.getAttribute("role"),
        tab: st.getAttribute("tabindex"),
        cursor: st.style.cursor,
        aria: st.getAttribute("aria-label")
      };
      const tops = {};
      const heights = {};
      states.forEach((s) => {
        document.body.className = s[1];
        st.className = s[2];
        msg.innerHTML = s[3];
        if (s[0] === "button") {
          st.setAttribute("role", "button");
          st.setAttribute("tabindex", "0");
        } else {
          st.setAttribute("role", "status");
          st.removeAttribute("tabindex");
        }
        tops[s[0]] = Math.round(document.querySelector(".kb-wrap").getBoundingClientRect().top);
        heights[s[0]] = Math.round(st.getBoundingClientRect().height);
      });
      document.body.className = prev.body;
      st.className = prev.status;
      msg.innerHTML = prev.html;
      if (prev.role) st.setAttribute("role", prev.role); else st.removeAttribute("role");
      if (prev.tab) st.setAttribute("tabindex", prev.tab); else st.removeAttribute("tabindex");
      st.style.cursor = prev.cursor;
      if (prev.aria) st.setAttribute("aria-label", prev.aria); else st.removeAttribute("aria-label");
      return { tops, heights, vw: window.innerWidth, vh: window.innerHeight };
    }, layoutStates);
    await p.close();
    return info;
  }
  const belowViewports = [
    ["portrait-412", 412, 915, true],
    ["portrait-360", 360, 800, true],
    ["portrait-320", 320, 680, true],
    ["landscape-915x412", 915, 412, true],
    ["desktop-1280", 1280, 800, false]
  ];
  for (const [name, w, h, mobile] of belowViewports) {
    const info = await measureBelow(w, h, mobile);
    const tops = Object.values(info.tops);
    const heights = Object.values(info.heights);
    const topsEqual = tops.length === 8 && tops.every((v) => v === tops[0] && v > 0);
    const heightsEqual = heights.length === 8 && heights.every((v) => v === heights[0] && v > 0);
    console.log("BELOW " + name, JSON.stringify(info));
    check("range card top is identical across status states at " + name,
      topsEqual && heightsEqual,
      JSON.stringify(info));
  }

  const portLay = await layoutInfo(page);
  console.log("LAYOUT portrait", JSON.stringify(portLay));
  check("portrait keys keep piano proportion (h/w ~4.0)", Math.abs(portLay.kb.h / (portLay.kb.w / portLay.whiteCount) - 4.0) < 0.3, JSON.stringify(portLay.kb));
  check("portrait black keys have height", portLay.blackCount === 10 && Math.abs(portLay.blackH / portLay.whiteH - 0.62) < 0.03,
    JSON.stringify({ blackCount: portLay.blackCount, blackH: portLay.blackH, whiteH: portLay.whiteH }));

  await page.evaluate(() => window.__pfTest.feed([0x90, 60, 100]));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await new Promise((r) => setTimeout(r, 50));
  let st = await page.evaluate(() => window.__pfTest.getState());
  check("C4 note-on held", st.held["60"] && st.held["60"].vel === 100, JSON.stringify(st.held));
  check("last note is C4 / 60 / vel 100 / ch 1",
    st.last && st.last.name === "C4" && st.last.note === 60 && st.last.vel === 100 && st.last.ch === 1,
    JSON.stringify(st.last));
  const held60 = await page.evaluate(() => {
    const el = document.querySelector("[data-note='60']");
    return el ? el.classList.contains("held") : false;
  });
  check("key 60 has .held", held60);
  const pressColors = await page.evaluate(() => {
    function rgbList(text) {
      const out = [];
      let m;
      const re = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/g;
      while ((m = re.exec(text))) {
        if (!(+m[1] === 0 && +m[2] === 0 && +m[3] === 0)) {
          out.push({ r: +m[1], g: +m[2], b: +m[3] });
        }
      }
      // Chrome serializes color-mix() stops as color(srgb …) in 0–1 units.
      const re2 = /color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/g;
      while ((m = re2.exec(text))) {
        out.push({
          r: Math.round(+m[1] * 255),
          g: Math.round(+m[2] * 255),
          b: Math.round(+m[3] * 255)
        });
      }
      return out;
    }
    function hue(c) {
      const r = c.r / 255, g = c.g / 255, b = c.b / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (d < 1e-6) return { h: 0, s: 0 };
      const s = d / max;
      let h;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = h * 60;
      if (h < 0) h += 360;
      return { h, s };
    }
    function isAccent(c) {
      const { h, s } = hue(c);
      return s >= 0.25 && h >= 15 && h <= 55 && c.r >= 140;
    }
    function pack(el) {
      const cs = getComputedStyle(el);
      const after = getComputedStyle(el, "::after");
      const bg = (cs.backgroundImage + " " + cs.backgroundColor).trim();
      const afterBg = (after.backgroundImage + " " + after.backgroundColor).trim();
      const visible = parseFloat(after.opacity) > 0.5 ? afterBg : bg;
      return {
        bg,
        afterBg,
        afterOpacity: parseFloat(after.opacity),
        colors: rgbList(visible)
      };
    }
    const held = document.querySelector("[data-note='60']");
    const idle = document.querySelector("[data-note='62']");
    return {
      held: pack(held),
      idle: pack(idle),
      heldClass: held && held.className
    };
  });
  const heldFill = pressColors.held.bg + " @ " + pressColors.held.afterBg + " op=" + pressColors.held.afterOpacity;
  const idleFill = pressColors.idle.bg + " @ " + pressColors.idle.afterBg + " op=" + pressColors.idle.afterOpacity;
  check("pressed white key background differs from unpressed and has the accent hue",
    heldFill !== idleFill
      && pressColors.held.afterOpacity >= 0.9
      && pressColors.held.colors.some((c) => {
        const r = c.r / 255, g = c.g / 255, b = c.b / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        if (d < 1e-6 || d / max < 0.25 || c.r < 140) return false;
        let h;
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h = h * 60;
        if (h < 0) h += 360;
        return h >= 15 && h <= 55;
      }),
    JSON.stringify(pressColors));
  check("readout shows C4", await page.evaluate(() => document.getElementById("last-name").textContent) === "C4");
  check("held count is 1", st.heldCount === 1, String(st.heldCount));
  check("log has at least 1 row", st.logLength >= 1, String(st.logLength));
  check("log decodes note on C4", st.log.some((r) => /Note on C4 \(60\) vel 100 ch 1/.test(r.decoded)),
    st.log.map((r) => r.decoded).join(" | "));
  check("latency samples recorded after note-on", st.latencySamples > 0, String(st.latencySamples));

  await page.evaluate(() => window.__pfTest.feed([0x90, 60, 0]));
  await new Promise((r) => setTimeout(r, 30));
  st = await page.evaluate(() => window.__pfTest.getState());
  check("C4 released by 0x90 vel 0", !st.held["60"] && st.heldCount === 0, JSON.stringify(st.held));
  const unheld60 = await page.evaluate(() => {
    const el = document.querySelector("[data-note='60']");
    return el ? !el.classList.contains("held") : false;
  });
  check("key 60 no longer .held", unheld60);

  await page.evaluate(() => window.__pfTest.feed([0x90, 64, 80]));
  await new Promise((r) => setTimeout(r, 20));
  await page.evaluate(() => window.__pfTest.feed([0x80, 64, 40]));
  await new Promise((r) => setTimeout(r, 20));
  st = await page.evaluate(() => window.__pfTest.getState());
  check("E4 released by 0x80", !st.held["64"], JSON.stringify(st.held));
  check("seen high stays at E4 (64) after release", st.seenHigh === 64, String(st.seenHigh));

  await page.evaluate(() => {
    const t = performance.now();
    window.__pfTest.feed([0x90, 48, 96], t);
    window.__pfTest.feed([0x90, 52, 88], t + 1);
    window.__pfTest.feed([0x90, 55, 110], t + 2);
    window.__pfTest.feed([0x90, 60, 70], t + 3);
    window.__pfTest.feed([0xb0, 64, 127], t + 4);
  });
  await new Promise((r) => setTimeout(r, 80));
  st = await page.evaluate(() => window.__pfTest.getState());
  check("chord of 4 notes held", st.heldCount === 4, String(st.heldCount));
  check("sustain on", st.sustainOn === true);
  check("sustain indicator says on", await page.evaluate(() => document.getElementById("sustain").textContent) === "on");
  check("seen low C3 (48)", st.seenLow === 48, String(st.seenLow));

  const portrait = await shot(page, "portrait-412x915.png", 412, 915);
  st = await page.evaluate(() => window.__pfTest.getState());
  check("after portrait shot, 4 notes still held", st.heldCount === 4, String(st.heldCount));

  const landscape = await shot(page, "landscape-915x412.png", 915, 412);
  st = await page.evaluate(() => window.__pfTest.getState());
  check("after landscape resize, 4 notes still held", st.heldCount === 4, String(st.heldCount));
  const lit = await page.evaluate(() =>
    ["48", "52", "55", "60"].every((n) => {
      const el = document.querySelector("[data-note='" + n + "']");
      return el && el.classList.contains("held");
    })
  );
  check("chord keys still lit after resize", lit);

  const landLay = await layoutInfo(page);
  console.log("LAYOUT landscape", JSON.stringify(landLay));
  check("landscape keyboard is tall enough", landLay.kb.h >= 110, JSON.stringify(landLay.kb));
  check("landscape black keys visible", landLay.blackCount >= 5 && landLay.blackH >= 60 && landLay.blackW >= 8,
    JSON.stringify({ blackCount: landLay.blackCount, blackH: landLay.blackH, blackW: landLay.blackW, whiteH: landLay.whiteH }));

  await page.evaluate(() => window.__pfTest.feed([0x90, 24, 90]));
  await new Promise((r) => setTimeout(r, 40));
  st = await page.evaluate(() => window.__pfTest.getState());
  check("visible range extended down to C1", st.visibleLow === 24, String(st.visibleLow));
  const labelC1 = await page.evaluate(() => document.getElementById("range-label").textContent);
  check("range label updates to C1–C5 without Visible",
    labelC1 === "C1–C5 · 49 keys" && !/^Visible\b/.test(labelC1), labelC1);
  const c1held = await page.evaluate(() => {
    const el = document.querySelector("[data-note='24']");
    return el && el.classList.contains("held");
  });
  check("C1 key exists and is held", c1held);
  check("seen low now C1 (24)", st.seenLow === 24, String(st.seenLow));

  await page.evaluate(() => window.__pfTest.feed([0x90, 84, 90]));
  await new Promise((r) => setTimeout(r, 40));
  st = await page.evaluate(() => window.__pfTest.getState());
  check("visible range extended up to C6", st.visibleHigh === 84, String(st.visibleHigh));
  const labelC6 = await page.evaluate(() => document.getElementById("range-label").textContent);
  check("range label updates to C1–C6 without Visible",
    labelC6 === "C1–C6 · 61 keys" && !/^Visible\b/.test(labelC6), labelC6);

  await page.evaluate(() => document.getElementById("btn-reset-range").click());
  await new Promise((r) => setTimeout(r, 40));
  st = await page.evaluate(() => window.__pfTest.getState());
  check("reset returns visible range to 48-72", st.visibleLow === 48 && st.visibleHigh === 72,
    JSON.stringify({ low: st.visibleLow, high: st.visibleHigh }));
  const labelReset = await page.evaluate(() => document.getElementById("range-label").textContent);
  check("range label returns to C3–C5 · 25 keys after reset",
    labelReset === "C3–C5 · 25 keys", labelReset);

  const beforeFilter = await page.evaluate(() => window.__pfTest.getState().logLength);
  await page.evaluate(() => {
    window.__pfTest.feed([0xfe]);
    window.__pfTest.feed([0xf8]);
  });
  await new Promise((r) => setTimeout(r, 20));
  const afterFilter = await page.evaluate(() => window.__pfTest.getState().logLength);
  check("clock/sensing hidden when filter on", afterFilter === beforeFilter, "before=" + beforeFilter + " after=" + afterFilter);
  await page.evaluate(() => {
    const cb = document.getElementById("filter-rt");
    cb.checked = false;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
    window.__pfTest.feed([0xfe]);
    window.__pfTest.feed([0xf8]);
  });
  await new Promise((r) => setTimeout(r, 20));
  st = await page.evaluate(() => window.__pfTest.getState());
  check("clock/sensing logged when filter off", st.logLength >= afterFilter + 2,
    "before=" + afterFilter + " after=" + st.logLength);
  check("decoded clock and active sensing",
    st.log.some((r) => r.decoded === "Clock") && st.log.some((r) => r.decoded === "Active sensing"));

  await page.evaluate(() => document.getElementById("btn-clear").click());
  st = await page.evaluate(() => window.__pfTest.getState());
  check("clear log empties it", st.logLength === 0);


  // Play view: falling notes and lit keys, wait mode.
  {
    const p = await browser.newPage();
    p.on("pageerror", (err) => jsErrors.push(String(err)));
    await p.evaluateOnNewDocument(() => { try { localStorage.removeItem("aplus.mode.v1"); } catch (e) {} });
    await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    const ps = () => p.evaluate(() => window.__pfTest.play.state());
    const feed = (n) => p.evaluate((n) => { window.__pfTest.feed([0x90, n, 100]); window.__pfTest.feed([0x80, n, 0]); }, n);
    const testChrome = await p.evaluate(() => {
      const wrap = document.querySelector(".status-wrap");
      const st = wrap.getBoundingClientRect();
      const kb = document.querySelector(".kb-wrap").getBoundingClientRect();
      return {
        statusVisible: st.height > 0 && getComputedStyle(wrap).display !== "none",
        statusH: Math.round(st.height),
        kbTop: Math.round(kb.top),
        kbH: Math.round(kb.height)
      };
    });
    check("play: status bar is visible in Test before entering Play",
      testChrome.statusVisible === true && testChrome.statusH > 0, JSON.stringify(testChrome));
    await p.click("#mode-play");
    await p.waitForFunction(() => window.__pfTest.play.state().steps > 0, { timeout: 8000 });
    const opts = await p.evaluate(() => ({
      songs: [...document.querySelectorAll("#play-song option")].map((o) => o.value),
      songLabels: [...document.querySelectorAll("#play-song option")].map((o) => o.textContent),
      rungs: [...document.querySelectorAll("#play-rung option")].map((o) => o.value),
      lowerHidden: getComputedStyle(document.querySelector(".lower")).display === "none",
    }));
    check("play: song picker lists the catalog", opts.songs.includes("mary-had-a-little-lamb") && opts.songs.includes("over-in-the-meadow"), opts.songs.join(","));
    const pickScores = opts.songLabels.map((t) => +((t.match(/ · (\d+\.\d)$/) || [])[1]));
    check("play: song picker lists Row, Row, Row Your Boat and Itsy Bitsy Spider, easiest first by score, with no level labels",
      opts.songs.join(",") === "mary-had-a-little-lamb,over-in-the-meadow,itsy-bitsy-spider,row-your-boat"
        && pickScores.every((v, i) => Number.isFinite(v) && (i === 0 || v >= pickScores[i - 1]))
        && opts.songLabels.every((t) => !/beginner|easy|intermediate|advanced|level|grade/i.test(t)),
      JSON.stringify(opts.songLabels));
    check("play: rung picker has right hand, roots and full", opts.rungs.join(",") === "rh,roots,full", opts.rungs.join(","));
    check("play: Keyboard panes hidden in Play", opts.lowerHidden);

    function playAreaBox() {
      return p.evaluate(() => {
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
        };
        const sheet = document.getElementById("play-sheet");
        const pause = document.getElementById("play-pause");
        const wait = document.getElementById("play-wait");
        const label = wait && wait.parentElement ? wait.parentElement.textContent.replace(/\s+/g, " ").trim() : "";
        return {
          wrap: box(document.querySelector(".kb-wrap")),
          highway: box(document.getElementById("highway")),
          keys: box(document.getElementById("kb-scroll")),
          sheetOpen: !!(sheet && !sheet.hidden),
          sheetRole: sheet ? sheet.getAttribute("role") : null,
          modal: sheet ? sheet.getAttribute("aria-modal") : null,
          start: (document.getElementById("play-toggle") || {}).textContent || "",
          restart: (document.getElementById("play-restart") || {}).textContent || "",
          pauseShown: !!(pause && !pause.hidden),
          pauseLabel: pause ? pause.getAttribute("aria-label") : null,
          waitLabel: label,
          playing: window.__pfTest.play.state().playing,
          statusVisible: (function () {
            const wrap = document.querySelector(".status-wrap");
            const r = wrap.getBoundingClientRect();
            return r.height > 0 && getComputedStyle(wrap).display !== "none";
          })(),
          midiShown: (function () {
            const el = document.getElementById("play-midi");
            const r = el && el.getBoundingClientRect();
            return !!(el && r.height > 0 && getComputedStyle(el).display !== "none");
          })(),
          midiText: (document.getElementById("play-midi-msg") || {}).innerText
            ? document.getElementById("play-midi-msg").innerText.replace(/\s+/g, " ").trim() : "",
          midiConnectShown: (function () {
            const btn = document.getElementById("play-midi-connect");
            return !!(btn && !btn.hidden && btn.getBoundingClientRect().height > 0);
          })(),
          midiConnectLabel: (document.getElementById("play-midi-connect") || {}).getAttribute
            ? document.getElementById("play-midi-connect").getAttribute("aria-label") : null,
          needsConnect: document.getElementById("status").classList.contains("is-connect"),
          headerVisible: (function () {
            const top = document.querySelector(".top");
            const r = top.getBoundingClientRect();
            return r.height > 0 && getComputedStyle(top).display !== "none";
          })(),
          headerTop: Math.round(document.querySelector(".top").getBoundingClientRect().top),
          soundInSheet: (function () {
            const sheet = document.getElementById("play-sheet");
            const sound = document.getElementById("sound-controls");
            const btn = document.getElementById("btn-sound");
            const vol = document.getElementById("sound-volume");
            const vis = (el) => !!(el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== "none");
            return !!(sheet && sound && sheet.contains(sound) && vis(btn) && vis(vol)
              && /Sound /.test(btn.getAttribute("aria-label") || "")
              && /Volume/.test(vol.getAttribute("aria-label") || ""));
          })(),
          testSwitch: (function () {
            const btn = document.getElementById("play-to-test");
            const r = btn && btn.getBoundingClientRect();
            return !!(btn && r && r.height > 0 && getComputedStyle(btn).display !== "none"
              && (btn.getAttribute("aria-label") || "") === "Switch to Test."
              && btn.textContent.trim() === "Test");
          })(),
          keysBottom: Math.round(document.getElementById("kb-scroll").getBoundingClientRect().bottom),
          scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
          scrollHeight: Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
            (document.scrollingElement || document.documentElement).scrollHeight
          ),
          innerHeight: window.innerHeight,
          padTop: parseFloat(getComputedStyle(document.body).paddingTop) || 0,
          padBottom: parseFloat(getComputedStyle(document.body).paddingBottom) || 0
        };
      });
    }
    function keyboardAnchored(a, b) {
      return a.keysBottom === b.keysBottom && a.keys.h === b.keys.h && a.wrap.bottom === b.wrap.bottom;
    }
    function samePlayArea(a, b) {
      return JSON.stringify(a.wrap) === JSON.stringify(b.wrap)
        && JSON.stringify(a.highway) === JSON.stringify(b.highway)
        && JSON.stringify(a.keys) === JSON.stringify(b.keys);
    }
    async function waitingNoteGeometry() {
      return p.evaluate(() => {
        const cv = document.getElementById("highway");
        const keys = document.getElementById("kb-scroll").getBoundingClientRect();
        const hr = cv.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const backingOk = cv.width === Math.round(hr.width * dpr) && cv.height === Math.round(hr.height * dpr);
        const ctx = cv.getContext("2d");
        const img = ctx.getImageData(0, 0, cv.width, cv.height);
        const data = img.data;
        // Note bars are amber; the lane board and lines are faint neutrals.
        const amber = (i) => data[i + 3] > 150 && data[i] > 170 && data[i + 1] > 110 && data[i + 2] < 125;
        let maxY = -1;
        for (let y = cv.height - 1; y >= 0; y--) {
          const row = y * cv.width * 4;
          for (let x = 0; x < cv.width; x++) {
            if (amber(row + x * 4)) { maxY = y; break; }
          }
          if (maxY >= 0) break;
        }
        const noteBottom = maxY < 0 ? null : hr.top + (maxY + 1) / dpr;
        const st = window.__pfTest.play.state();
        return {
          backingOk,
          canvasW: cv.width,
          canvasH: cv.height,
          cssW: Math.round(hr.width),
          cssH: Math.round(hr.height),
          dpr,
          noteBottom: noteBottom == null ? null : Math.round(noteBottom * 10) / 10,
          keysTop: Math.round(keys.top * 10) / 10,
          canvasBottom: Math.round(hr.bottom * 10) / 10,
          gap: noteBottom == null ? null : Math.round((keys.top - noteBottom) * 10) / 10,
          slotGap: Math.round((keys.top - hr.bottom) * 10) / 10,
          playing: st.playing,
          beat: st.beat,
          step: st.step,
          wait: st.wait
        };
      });
    }
    function hitLineAtKeys(g) {
      return g && g.backingOk === true && g.wait === true && g.playing === true
        && g.noteBottom != null && Math.abs(g.gap) <= 6 && Math.abs(g.slotGap) <= 2;
    }
    const overlayOpen = await playAreaBox();
    check("play: overlay is shown on entering Play",
      overlayOpen.sheetOpen === true && overlayOpen.sheetRole === "dialog" && overlayOpen.modal === "true"
        && overlayOpen.start === "Start" && overlayOpen.pauseShown === false && overlayOpen.playing === false
        && overlayOpen.headerVisible === false,
      JSON.stringify(overlayOpen));
    check("play: sheet has the sound controls and a Test switch, and the header is hidden",
      overlayOpen.soundInSheet === true && overlayOpen.testSwitch === true && overlayOpen.headerVisible === false,
      JSON.stringify({ soundInSheet: overlayOpen.soundInSheet, testSwitch: overlayOpen.testSwitch, headerVisible: overlayOpen.headerVisible }));
    check("play: Wait checkbox is labelled Wait for me!",
      overlayOpen.waitLabel === "Wait for me!", overlayOpen.waitLabel);
    const tempoLabel = await p.evaluate(() => {
      const input = document.getElementById("play-tempo");
      const label = input.labels && input.labels[0];
      const out = document.getElementById("play-tempo-out");
      const lr = label ? label.getBoundingClientRect() : null, ir = input.getBoundingClientRect();
      const sr = document.getElementById("play-song").getBoundingClientRect();
      return { text: label ? label.textContent.trim() : null, forId: label ? label.htmlFor : null,
        visible: !!(lr && lr.width > 0 && lr.height > 0), sameRow: !!(lr && Math.abs((lr.top + lr.bottom) / 2 - (ir.top + ir.bottom) / 2) <= 2),
        before: !!(lr && lr.right <= ir.left), alignedLeft: !!(lr && Math.abs(lr.left - sr.left) <= 1),
        readout: out.textContent.trim() };
    });
    const keysRow = await p.evaluate(() => {
      const fs = document.getElementById("play-keys"), lg = fs.querySelector("legend");
      const labels = [...fs.querySelectorAll("label")], radios = [...fs.querySelectorAll('input[type="radio"]')];
      const lr = lg.getBoundingClientRect(), last = labels[labels.length - 1].getBoundingClientRect();
      const tl = document.querySelector(".play-tempo-label").getBoundingClientRect(), sr = document.getElementById("play-song").getBoundingClientRect();
      const mid = (r) => (r.top + r.bottom) / 2;
      return { legend: lg.textContent.trim(), names: labels.map((l) => l.textContent.trim()), values: radios.map((r) => r.value),
        checked: radios.filter((r) => r.checked).map((r) => r.value), sameName: radios.every((r) => r.name === "play-keys"),
        leftAligned: Math.abs(lr.left - tl.left) <= 1 && Math.abs(labels[0].getBoundingClientRect().left - tl.left) <= 1,
        rightAligned: Math.abs(last.right - sr.right) <= 1,
        oneRow: labels.every((l) => Math.abs(mid(l.getBoundingClientRect()) - mid(last)) <= 1) && lr.bottom <= last.top };
    });
    check("play: Keys choice is a labelled group of five options in one row under the label, aligned with the sheet, Octave by default",
      keysRow.legend === "Keys" && keysRow.values.join(",") === "octave,coctave,tight,plus,groups"
        && keysRow.names.join(",") === "Octave,C octave,Tight,Plus one,Groups" && keysRow.checked.join(",") === "octave"
        && keysRow.sameName && keysRow.leftAligned && keysRow.rightAligned && keysRow.oneRow,
      JSON.stringify(keysRow));
    const fsState = () => p.evaluate(() => {
      const b = document.getElementById("play-fullscreen"), r = b.getBoundingClientRect();
      const sr = document.getElementById("play-song").getBoundingClientRect(), tr = document.getElementById("play-to-test").getBoundingClientRect();
      const kw = document.querySelector(".kb-wrap").getBoundingClientRect(), kb = document.getElementById("keyboard").getBoundingClientRect();
      return { shown: !b.hidden && r.width > 0, label: b.getAttribute("aria-label"), pressed: b.getAttribute("aria-pressed"),
        fs: !!document.fullscreenElement, inHead: b.closest(".play-sheet-head") !== null && Math.abs((r.top + r.bottom) / 2 - (tr.top + tr.bottom) / 2) <= 1,
        rightAligned: Math.abs(r.right - sr.right) <= 1, focusable: b.tabIndex === 0,
        edgeToEdge: kw.left === 0 && Math.abs(kw.right - innerWidth) <= 0.5, keysFull: kb.width >= kw.width - 8 && Math.abs((kb.left - kw.left) - (kw.right - kb.right)) <= 1 };
    });
    const fs0 = await fsState();
    await p.click("#play-fullscreen");
    await p.waitForFunction(() => !!document.fullscreenElement && document.getElementById("play-fullscreen").getAttribute("aria-pressed") === "true", { timeout: 4000 }).catch(() => {});
    const fs1 = await fsState();
    await p.click("#play-fullscreen");
    await p.waitForFunction(() => !document.fullscreenElement && document.getElementById("play-fullscreen").getAttribute("aria-pressed") === "false", { timeout: 4000 }).catch(() => {});
    const fs2 = await fsState();
    check("play: Full screen button sits at the end of the sheet header, labelled, and toggles full screen on and off",
      fs0.shown && fs0.label === "Full screen" && fs0.pressed === "false" && !fs0.fs && fs0.inHead && fs0.rightAligned && fs0.focusable
        && fs1.fs && fs1.label === "Exit full screen" && fs1.pressed === "true" && fs1.keysFull
        && !fs2.fs && fs2.label === "Full screen" && fs2.pressed === "false",
      JSON.stringify({ fs0, fs1, fs2 }));
    check("play: the play area runs edge to edge and the keys fill its width (4px inset kept)", fs0.edgeToEdge && fs0.keysFull && fs2.edgeToEdge, JSON.stringify(fs0));
    const keysUnit = await p.evaluate(() => {
      const f = (lo, hi, m) => { const r = window.__pfTest.play.keysRange(lo, hi, m); return r.low + "-" + r.high; };
      const all = (lo, hi) => ["octave", "coctave", "tight", "plus", "groups"].map((m) => f(lo, hi, m)).join(" ");
      return {
        maryRh: all(60, 67),        // C4-G4
        blackEnds: all(61, 66),     // C#4-F#4
        blackEnds2: all(63, 70),    // D#4-A#4
        twoKeys: all(64, 65),       // E4-F4
        wide: all(59, 72),          // B3-C5
        bassFull: all(48, 69),      // C3-A4
        edges: ["octave", "coctave", "tight", "plus", "groups"].map((m) => window.__pfTest.play.keysRange(60, 67, m).edges).join(","),
        cOct: f(60, 60, "coctave") + " " + f(60, 72, "coctave") + " " + f(59, 73, "coctave") // single C, exact C-C, past both Cs
      };
    });
    check("play: Keys ranges: C octave runs C to C (both included, at least an octave) with no half key past the top C, tight covers the notes, plus one adds a white key past each end, groups take whole C-E / F-B groups",
      keysUnit.maryRh === "57-71 60-72 60-67 59-69 60-71"
        && keysUnit.blackEnds === "57-71 60-72 60-67 59-69 60-71"
        && keysUnit.blackEnds2 === "60-74 60-72 62-71 60-72 60-71"
        && keysUnit.twoKeys === "59-71 60-72 64-65 62-67 60-71"
        && keysUnit.wide === "59-72 48-72 59-72 57-74 53-76"
        && keysUnit.bassFull === "48-69 48-72 48-69 47-71 48-71"
        && keysUnit.cOct === "60-72 60-72 48-84"
        && keysUnit.edges === "false,false,true,true,false",
      JSON.stringify(keysUnit));
    check("play: tempo slider has a visible Tempo label on its row, aligned with the sheet, and keeps the % readout",
      tempoLabel.text === "Tempo" && tempoLabel.forId === "play-tempo" && tempoLabel.visible && tempoLabel.sameRow
        && tempoLabel.before && tempoLabel.alignedLeft && /^\d+%$/.test(tempoLabel.readout),
      JSON.stringify(tempoLabel));
    check("play: status bar is hidden and the play area uses the freed height",
      overlayOpen.statusVisible === false && overlayOpen.wrap.top < testChrome.kbTop
        && overlayOpen.wrap.h > testChrome.kbH,
      JSON.stringify({ test: testChrome, play: { statusVisible: overlayOpen.statusVisible, wrap: overlayOpen.wrap } }));
    check("play: sheet shows the connection status and a Connect control when needed",
      overlayOpen.midiShown === true && overlayOpen.midiText.length > 0
        && (overlayOpen.needsConnect
          ? (overlayOpen.midiConnectShown === true && overlayOpen.midiConnectLabel === "Connect MIDI keyboard."
            && overlayOpen.midiText === "No keyboard connected")
          : true),
      JSON.stringify(overlayOpen));

    let st = await ps();
    const melody = [64, 62, 60, 62, 64, 64, 64, 62, 62, 62, 64, 67, 67, 64, 62, 60, 62, 64, 64, 64, 64, 62, 62, 64, 62, 60];
    check("play: Mary right-hand MIDI parses to the verified melody", st.song === "mary-had-a-little-lamb" &&
      JSON.stringify(st.stepNotes.flat()) === JSON.stringify(melody), JSON.stringify(st.stepNotes.flat()));
    check("play: notes render before Play", st.drawn > 0 && !st.playing, "drawn=" + st.drawn);

    async function playKeyboardFit() {
      return p.evaluate(() => {
        const keys = [...document.querySelectorAll("#keyboard .key")];
        const notes = keys.map((k) => +k.dataset.note);
        const lo = Math.min(...notes), hi = Math.max(...notes);
        const hw = document.getElementById("highway").getBoundingClientRect();
        const scroll = document.getElementById("kb-scroll").getBoundingClientRect();
        const songNotes = [...new Set(window.__pfTest.play.state().stepNotes.flat())];
        const missing = songNotes.filter((n) => !notes.includes(n));
        const black = { 1: true, 3: true, 6: true, 8: true, 10: true };
        const cols = {};
        keys.forEach((k) => {
          const r = k.getBoundingClientRect();
          cols[+k.dataset.note] = { x: r.left - hw.left, w: r.width };
        });
        const lanesOnKeys = songNotes.every((n) => {
          const c = cols[n];
          return c && c.w > 0 && c.x >= -1 && c.x + c.w <= hw.width + 1;
        });
        return {
          song: window.__pfTest.play.state().song,
          rung: window.__pfTest.play.state().rung,
          lo, hi, count: keys.length, missing, lanesOnKeys,
          startWhite: !black[lo % 12], endWhite: !black[hi % 12],
          sameSlot: Math.abs(hw.left - scroll.left) < 1 && Math.abs(hw.width - scroll.width) < 1,
          rangeLow: window.__pfTest.play.state().rangeLow,
          rangeHigh: window.__pfTest.play.state().rangeHigh
        };
      });
    }
    function checkPlayRange(label, expectLo, expectHi, expectCount, info) {
      check(label,
        info.lo === expectLo && info.hi === expectHi && info.count === expectCount
          && info.rangeLow === expectLo && info.rangeHigh === expectHi
          && info.startWhite === true && info.endWhite === true
          && info.missing.length === 0 && info.lanesOnKeys === true && info.sameSlot === true
          && info.hi - info.lo >= 12,
        JSON.stringify(info));
    }
    // Mary RH is C4–G4 (span 7); the default Octave choice pads to an octave and snaps to white keys → A3–B4.
    checkPlayRange("play: Mary right-hand keyboard matches the padded song range and lanes align",
      57, 71, 15, await playKeyboardFit());

    await p.evaluate(() => { const t = document.getElementById("play-tempo"); t.value = 150; t.dispatchEvent(new Event("input")); });
    const areaBeforeStart = await playAreaBox();
    await p.click("#play-toggle");
    await p.waitForFunction(() => window.__pfTest.play.state().playing === true && window.__pfTest.play.state().beat >= 0, { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 300));
    const areaPlaying = await playAreaBox();
    check("play: overlay is hidden while playing and the pause button is shown",
      areaPlaying.sheetOpen === false && areaPlaying.pauseShown === true
        && areaPlaying.pauseLabel === "Pause." && areaPlaying.playing === true,
      JSON.stringify(areaPlaying));
    check("play: header stays hidden and the play area size is unchanged after Start",
      areaPlaying.headerVisible === false && areaPlaying.scrollY === 0
        && samePlayArea(areaBeforeStart, areaPlaying)
        && areaPlaying.scrollHeight <= areaPlaying.innerHeight
        && areaPlaying.keysBottom <= areaPlaying.innerHeight,
      JSON.stringify({ before: areaBeforeStart, playing: areaPlaying }));
    st = await ps();
    check("play: wait mode holds at the first note", st.playing && st.step === 0 && st.beat === 0, "beat=" + st.beat + " step=" + st.step);
    const hit = await waitingNoteGeometry();
    check("play: waiting note lands at the top of the keyboard and the canvas backing matches its size",
      hitLineAtKeys(hit), JSON.stringify(hit));
    check("play: next key glows", JSON.stringify(st.lit) === "[64]", JSON.stringify(st.lit));
    await feed(65);
    st = await ps();
    check("play: wrong key does not advance", st.step === 0, "step=" + st.step);
    await feed(64);
    st = await ps();
    check("play: right key advances", st.step === 1 && JSON.stringify(st.next) === "[62]", "step=" + st.step + " next=" + JSON.stringify(st.next));
    await p.waitForFunction(() => window.__pfTest.play.state().beat >= 1, { timeout: 8000 });
    await p.evaluate(() => {
      const k = document.querySelector('#keyboard .key[data-note="62"]');
      k.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7 }));
      k.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 7 }));
    });
    st = await ps();
    check("play: on-screen tap advances", st.step === 2, "step=" + st.step);
    await p.click("#play-pause");
    const areaPaused = await playAreaBox();
    check("play: pause reopens the overlay with Resume and Restart",
      areaPaused.sheetOpen === true && areaPaused.start === "Resume" && areaPaused.restart === "Restart"
        && areaPaused.pauseShown === false && areaPaused.playing === false,
      JSON.stringify(areaPaused));
    check("play: header stays hidden and the play area size is unchanged after Pause",
      areaPaused.headerVisible === false && areaPaused.scrollY === 0
        && samePlayArea(areaPlaying, areaPaused)
        && areaPaused.soundInSheet === true && areaPaused.testSwitch === true
        && areaPaused.scrollHeight <= areaPaused.innerHeight
        && areaPaused.keysBottom <= areaPaused.innerHeight,
      JSON.stringify({ playing: areaPlaying, paused: areaPaused }));
    await p.select("#play-rung", "full");
    await p.waitForFunction(() => window.__pfTest.play.state().rung === "full", { timeout: 8000 });
    st = await ps();
    check("play: both-hands rung waits for the whole chord", JSON.stringify(st.stepNotes[0]) === "[48,52,55,64]" && !st.playing,
      JSON.stringify(st.stepNotes[0]));
    // Mary full/roots are already C3–G4, more than an octave, snapped to white keys.
    checkPlayRange("play: Mary full keyboard matches the song range and lanes align",
      48, 67, 20, await playKeyboardFit());

    await p.select("#play-song", "over-in-the-meadow");
    await p.waitForFunction(() => window.__pfTest.play.state().song === "over-in-the-meadow" &&
      window.__pfTest.play.state().rung === "rh" && window.__pfTest.play.state().steps > 0, { timeout: 8000 });
    await p.waitForFunction(() => {
      const notes = [...document.querySelectorAll("#keyboard .key")].map((k) => +k.dataset.note);
      return notes.length > 0 && Math.min(...notes) === 59 && Math.max(...notes) === 71;
    }, { timeout: 8000 });
    // Meadow RH is C4–A4 (span 9); pad to an octave and snap to white keys → B3–B4.
    checkPlayRange("play: Meadow right-hand keyboard matches the padded song range and lanes align",
      59, 71, 13, await playKeyboardFit());
    await p.select("#play-rung", "full");
    await p.waitForFunction(() => window.__pfTest.play.state().rung === "full" &&
      window.__pfTest.play.state().song === "over-in-the-meadow", { timeout: 8000 });
    await p.waitForFunction(() => {
      const notes = [...document.querySelectorAll("#keyboard .key")].map((k) => +k.dataset.note);
      return notes.length > 0 && Math.min(...notes) === 48 && Math.max(...notes) === 69;
    }, { timeout: 8000 });
    // Meadow full/roots are already C3–A4.
    checkPlayRange("play: Meadow full keyboard matches the song range and lanes align",
      48, 69, 22, await playKeyboardFit());

    for (const [w, h] of [[915, 412], [412, 915]]) {
      await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await new Promise((r) => setTimeout(r, 300));
      const lay = await p.evaluate(() => {
        const hw = document.getElementById("highway").getBoundingClientRect();
        const kb = document.getElementById("kb-scroll").getBoundingClientRect();
        return { hwH: Math.round(hw.height), kbH: Math.round(kb.height), above: hw.bottom <= kb.top + 1,
          fits: document.documentElement.scrollWidth <= innerWidth && kb.bottom <= innerHeight + 1 };
      });
      check("play: highway above the keys and fits at " + w + "x" + h, lay.hwH >= 50 && lay.kbH >= 60 && lay.above && lay.fits, JSON.stringify(lay));
    }
    async function playViewportChrome() {
      return p.evaluate(() => {
        const top = document.querySelector(".top");
        const tr = top.getBoundingClientRect();
        const keys = document.getElementById("kb-scroll").getBoundingClientRect();
        const wrap = document.querySelector(".kb-wrap").getBoundingClientRect();
        const se = document.scrollingElement || document.documentElement;
        return {
          headerVisible: tr.height > 0 && getComputedStyle(top).display !== "none",
          headerTop: Math.round(tr.top),
          wrapTop: Math.round(wrap.top),
          wrapBottom: Math.round(wrap.bottom),
          wrapH: Math.round(wrap.height),
          keysBottom: Math.round(keys.bottom),
          keysH: Math.round(keys.height),
          scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
          scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, se.scrollHeight),
          innerHeight: window.innerHeight,
          playing: window.__pfTest.play.state().playing,
          sheetOpen: !document.getElementById("play-sheet").hidden,
          padTop: parseFloat(getComputedStyle(document.body).paddingTop) || 0,
          padBottom: parseFloat(getComputedStyle(document.body).paddingBottom) || 0
        };
      });
    }
    for (const [name, w, h] of [
      ["390x844", 390, 844],
      ["390x664", 390, 664],
      ["360x640", 360, 640],
      ["412x780", 412, 780],
      ["915x412", 915, 412],
      ["740x360", 740, 360]
    ]) {
      await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await new Promise((r) => setTimeout(r, 300));
      if (await p.evaluate(() => window.__pfTest.play.state().playing)) await p.click("#play-pause");
      await p.waitForFunction(() => !window.__pfTest.play.state().playing && !document.getElementById("play-sheet").hidden, { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 80));
      const openFit = await playViewportChrome();
      check("play: header is hidden and the page fits the viewport at " + name + " with the sheet open",
        openFit.headerVisible === false && openFit.scrollY === 0
          && openFit.scrollHeight <= openFit.innerHeight
          && openFit.keysBottom <= openFit.innerHeight
          && openFit.playing === false && openFit.sheetOpen === true
          && openFit.wrapTop <= openFit.padTop + 1
          && openFit.wrapBottom >= openFit.innerHeight - openFit.padBottom - 1,
        JSON.stringify(openFit));
      if (name === "390x844" || name === "740x360") {
        const tempoEdge = await p.evaluate(() => {
          const t = document.getElementById("play-tempo"), out = document.getElementById("play-tempo-out");
          const ref = document.getElementById("play-song").getBoundingClientRect();
          const orig = t.value, rows = [];
          for (const v of [50, 100, 150]) {
            t.value = v; t.dispatchEvent(new Event("input"));
            const o = out.getBoundingClientRect(), s = t.getBoundingClientRect();
            const range = document.createRange(); range.selectNodeContents(out);
            const txt = range.getBoundingClientRect();
            rows.push({ v, text: out.textContent.trim(), outL: o.left, outR: o.right, txtR: txt.right, sliderL: s.left, sliderR: s.right });
          }
          t.value = orig; t.dispatchEvent(new Event("input"));
          return { refR: ref.right, rows };
        });
        const r0 = tempoEdge.rows[0];
        check("play: tempo readout's right edge matches the sheet rows and its width is fixed for 50%–150% at " + name,
          tempoEdge.rows.every((r) => Math.abs(r.outR - tempoEdge.refR) <= 1 && r.txtR <= r.outR + 0.5
            && r.outL === r0.outL && r.sliderL === r0.sliderL && r.sliderR === r0.sliderR && r.text === r.v + "%"),
          JSON.stringify(tempoEdge));
      }
      await p.click("#play-toggle");
      await p.waitForFunction(() => {
        const st = window.__pfTest.play.state();
        return st.playing === true && st.wait === true && st.step === 0 && st.beat >= 0;
      }, { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 80));
      const playFit = await playViewportChrome();
      check("play: header is hidden and the play area fills the viewport at " + name,
        playFit.headerVisible === false && playFit.playing === true && playFit.scrollY === 0
          && playFit.scrollHeight <= playFit.innerHeight
          && playFit.keysBottom <= playFit.innerHeight
          && playFit.wrapTop <= playFit.padTop + 1
          && playFit.wrapBottom >= playFit.innerHeight - playFit.padBottom - 1,
        JSON.stringify(playFit));
      const playHit = await waitingNoteGeometry();
      check("play: waiting note lands at the keyboard at " + name,
        hitLineAtKeys(playHit), JSON.stringify(playHit));
      await p.click("#play-pause");
      await p.waitForFunction(() => window.__pfTest.play.state().playing === false && !document.getElementById("play-sheet").hidden, { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 80));
      const pausedFit = await playViewportChrome();
      check("play: header stays hidden, the play area size is unchanged, and the page does not scroll after Pause at " + name,
        pausedFit.headerVisible === false && pausedFit.scrollY === 0
          && pausedFit.scrollHeight <= pausedFit.innerHeight
          && pausedFit.keysBottom <= pausedFit.innerHeight
          && pausedFit.playing === false && pausedFit.sheetOpen === true
          && pausedFit.wrapTop === playFit.wrapTop && pausedFit.wrapH === playFit.wrapH
          && pausedFit.wrapTop === openFit.wrapTop && pausedFit.wrapH === openFit.wrapH
          && pausedFit.wrapTop <= pausedFit.padTop + 1
          && pausedFit.wrapBottom >= pausedFit.innerHeight - pausedFit.padBottom - 1,
        JSON.stringify({ open: openFit, playing: playFit, paused: pausedFit }));
    }

    // Song-sized keyboard with real proportions, perspective highway, notes landing on their keys.
    async function pauseToSheet() {
      if (await p.evaluate(() => window.__pfTest.play.state().playing)) await p.click("#play-pause");
      await p.waitForFunction(() => !window.__pfTest.play.state().playing && !document.getElementById("play-sheet").hidden, { timeout: 8000 });
    }
    for (const [song, rung, lo, hi] of [["mary-had-a-little-lamb", "rh", 57, 71], ["over-in-the-meadow", "full", 48, 69]]) {
      await pauseToSheet();
      await p.select("#play-song", song);
      await p.waitForFunction((s) => window.__pfTest.play.state().song === s && window.__pfTest.play.state().steps > 0, { timeout: 8000 }, song);
      if (await p.evaluate(() => window.__pfTest.play.state().rung) !== rung) {
        await p.select("#play-rung", rung);
      }
      await p.waitForFunction((r, lo, hi) => {
        const notes = [...document.querySelectorAll("#keyboard .key")].map((k) => +k.dataset.note);
        return window.__pfTest.play.state().rung === r && Math.min(...notes) === lo && Math.max(...notes) === hi;
      }, { timeout: 8000 }, rung, lo, hi);
      for (const [name, w, h] of [["390x844", 390, 844], ["360x640", 360, 640], ["915x412", 915, 412], ["740x360", 740, 360]]) {
        await pauseToSheet();
        await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await new Promise((r) => setTimeout(r, 300));
        await p.click("#play-restart");
        await p.click("#play-toggle");
        await p.waitForFunction(() => { const s = window.__pfTest.play.state(); return s.playing && s.wait && s.step === 0 && s.beat >= 0; }, { timeout: 8000 });
        await new Promise((r) => setTimeout(r, 80));
        const g = await p.evaluate(() => {
          const land = matchMedia("(orientation: landscape) and (max-height: 540px)").matches;
          const cap = land ? 0.40 : 0.33;
          const kb = document.getElementById("keyboard").getBoundingClientRect();
          const sc = document.getElementById("kb-scroll");
          const scr = sc.getBoundingClientRect();
          // Layout sizes: the keys are drawn tilted, so screen boxes are foreshortened.
          const wkEl = document.querySelector("#keyboard .key.white");
          const wk = { width: wkEl.offsetWidth, height: wkEl.offsetHeight };
          const bk = document.querySelector("#keyboard .key.black");
          const bkr = bk ? { height: bk.offsetHeight } : null;
          const cv = document.getElementById("highway");
          const hr = cv.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;
          const data = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
          const amber = (i) => data[i + 3] > 150 && data[i] > 170 && data[i + 1] > 110 && data[i + 2] < 125;
          let row = -1;
          for (let y = cv.height - 1; y >= 0 && row < 0; y--) {
            for (let x = 0; x < cv.width; x++) if (amber((y * cv.width + x) * 4)) { row = y; break; }
          }
          const spans = [];
          if (row >= 0) {
            let s = -1;
            for (let x = 0; x <= cv.width; x++) {
              const on = x < cv.width && amber((row * cv.width + x) * 4);
              if (on && s < 0) s = x;
              if (!on && s >= 0) { spans.push(hr.left + (s + x) / 2 / dpr); s = -1; }
            }
          }
          const st = window.__pfTest.play.state();
          const kbEl = document.getElementById("keyboard");
          const offsets = st.next.map((n) => {
            const k = document.querySelector('#keyboard .key[data-note="' + n + '"]');
            const c = scr.left + kbEl.offsetLeft - sc.scrollLeft + k.offsetLeft + k.offsetWidth / 2;
            return spans.length ? Math.min(...spans.map((x) => Math.abs(x - c))) : 99;
          });
          const se = document.scrollingElement || document.documentElement;
          return {
            land, cap,
            ratio: +(wk.height / wk.width).toFixed(2),
            blackLen: bkr ? +(bkr.height / wk.height).toFixed(2) : null,
            keyShare: +(kb.height / innerHeight).toFixed(3),
            hwShare: +(hr.height / innerHeight).toFixed(3),
            kbW: Math.round(kb.width), fillW: Math.round(scr.width - 8),
            centered: Math.abs((kb.left + kb.right) / 2 - (scr.left + scr.right) / 2) <= 1,
            noteBottom: row < 0 ? null : +(hr.top + (row + 1) / dpr).toFixed(1),
            keysTop: +scr.top.toFixed(1),
            next: st.next, offsets: offsets.map((o) => +o.toFixed(1)),
            tilt: st.tilt, tiltClass: kbEl.classList.contains("kb-tilt"),
            scrolls: se.scrollHeight > innerHeight || se.scrollWidth > innerWidth || window.scrollY !== 0,
            drawMs: +window.__pfTest.play.drawMs(30).toFixed(3)
          };
        });
        const capped = g.keyShare >= g.cap - 0.003;
        check("play: " + song + " " + rung + " at " + name + ": real key proportions, capped height, highway majority, note on its key",
          g.ratio <= 4.7 && (g.ratio >= 4.3 || g.tilt === 60) && (g.blackLen == null || (g.blackLen >= 0.6 && g.blackLen <= 0.65))
            && g.keyShare <= g.cap + 0.003 && g.hwShare >= 0.5 && !g.scrolls && g.centered
            && (capped || g.kbW >= g.fillW - 1)
            && g.tilt >= 0 && g.tilt <= 60 && g.tiltClass === (g.tilt > 0)
            && g.kbW >= g.fillW - 1
            && g.noteBottom != null && Math.abs(g.keysTop - g.noteBottom) <= 3
            && g.next.length > 0 && g.offsets.every((o) => o <= 3)
            && g.drawMs < 4,
          JSON.stringify(g));
      }
    }
    await pauseToSheet();

    // New songs: each part loads, the keyboard shows exactly the part's range, and playback waits for and follows the keys.
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await new Promise((r) => setTimeout(r, 300));
    for (const [song, ranges, count] of [
      ["row-your-boat", { rh: [60, 72], roots: [48, 72], full: [48, 72] }, 27],
      ["itsy-bitsy-spider", { rh: [55, 67], roots: [48, 67], full: [48, 67] }, 47]
    ]) {
      await pauseToSheet();
      await p.select("#play-song", song);
      await p.waitForFunction((s) => window.__pfTest.play.state().song === s && window.__pfTest.play.state().steps > 0, { timeout: 8000 }, song);
      const meta = await p.evaluate(async (s) => {
        const j = await (await fetch("songs/" + s + "/song.json")).json();
        const buf = await (await fetch("songs/" + s + "/rh.mid")).arrayBuffer();
        const m = window.__pfTest.play.parse(buf);
        return { time: j.time, pd: j.public_domain, score: j.score, sources: j.sources.length,
          rungs: [...document.querySelectorAll("#play-rung option")].map((o) => o.value), bpb: m.beatsPerBar, notes: m.notes.length,
          bpm: Math.round(m.bpm) };
      }, song);
      check("play: " + song + " loads with right hand, roots and full parts, in 6/8, public domain, with sources",
        meta.rungs.join(",") === "rh,roots,full" && meta.time === "6/8" && meta.bpb === 3 && meta.pd === true
          && meta.sources >= 2 && meta.notes === count && meta.bpm === 90 && meta.score > 0,
        JSON.stringify(meta));
      for (const rung of ["rh", "roots", "full"]) {
        await pauseToSheet();
        if (await p.evaluate(() => window.__pfTest.play.state().rung) !== rung) await p.select("#play-rung", rung);
        const [lo, hi] = ranges[rung];
        await p.waitForFunction((r, lo, hi) => {
          const n = [...document.querySelectorAll("#keyboard .key")].map((k) => +k.dataset.note);
          return window.__pfTest.play.state().rung === r && Math.min(...n) === lo && Math.max(...n) === hi;
        }, { timeout: 8000 }, rung, lo, hi);
        const kr = await p.evaluate(() => {
          const st = window.__pfTest.play.state();
          const keys = [...document.querySelectorAll("#keyboard .key")].map((k) => +k.dataset.note);
          const played = [].concat(...st.stepNotes);
          return { keys: keys.length, lo: Math.min(...keys), hi: Math.max(...keys), pLo: Math.min(...played), pHi: Math.max(...played),
            rangeLow: st.rangeLow, rangeHigh: st.rangeHigh };
        });
        check("play: " + song + " " + rung + " shows exactly the part's keys (" + lo + "-" + hi + ")",
          kr.lo === lo && kr.hi === hi && kr.keys === hi - lo + 1 && kr.pLo === lo && kr.pHi === hi
            && kr.rangeLow === lo && kr.rangeHigh === hi, JSON.stringify(kr));
      }
      await pauseToSheet();
      await p.select("#play-rung", "rh");
      await p.waitForFunction(() => window.__pfTest.play.state().rung === "rh", { timeout: 8000 });
      await p.click("#play-restart");
      await p.click("#play-toggle");
      await p.waitForFunction(() => { const s = window.__pfTest.play.state(); return s.playing && s.wait && s.step === 0; }, { timeout: 8000 });
      const firstNotes = await p.evaluate(() => window.__pfTest.play.state().stepNotes.slice(0, 4));
      // Wait mode: the clock stops at the first note until its key is played.
      const beatAt = () => p.evaluate(() => window.__pfTest.play.state().beat);
      let b1 = await beatAt();
      for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 150)); const b2 = await beatAt(); if (b2 === b1 && b2 > -1) break; b1 = b2; }
      await new Promise((r) => setTimeout(r, 300));
      const waiting = await p.evaluate(() => ({ step: window.__pfTest.play.state().step, beat: window.__pfTest.play.state().beat }));
      const stopped = waiting.beat === b1;
      const tries = [];
      for (let k = 0; k < firstNotes.length; k++) {
        let n = 0;
        while ((await p.evaluate(() => window.__pfTest.play.state().step)) === k && n < 40) {
          await p.evaluate((ns) => { ns.forEach((x) => window.__pfTest.feed([0x90, x, 90])); ns.forEach((x) => window.__pfTest.feed([0x80, x, 0])); }, firstNotes[k]);
          n++;
          await new Promise((r) => setTimeout(r, 150));
        }
        tries.push(n);
      }
      const after = await p.evaluate(() => window.__pfTest.play.state());
      check("play: " + song + " right hand plays: waits at the first note, then follows the keys",
        stopped && waiting.step === 0 && after.step >= 4 && after.playing === true && tries.every((n) => n < 40),
        JSON.stringify({ firstNotes, waiting, stopped, tries, stepAfter: after.step, beat: +after.beat.toFixed(2) }));
    }
    await pauseToSheet();
    await p.select("#play-song", "mary-had-a-little-lamb");
    await p.waitForFunction(() => window.__pfTest.play.state().song === "mary-had-a-little-lamb" && window.__pfTest.play.state().steps > 0, { timeout: 8000 });
    if (await p.evaluate(() => window.__pfTest.play.state().rung) !== "rh") await p.select("#play-rung", "rh");
    await p.waitForFunction(() => window.__pfTest.play.state().rung === "rh", { timeout: 8000 });

    // Keys choice on Mary RH (C4-G4): each mode's range, edge silhouettes, full width, key height and saving.
    for (const [mode, lo, hi, silL, silR] of [["tight", 60, 67, null, 68], ["plus", 59, 69, 58, 70], ["groups", 60, 71, null, null], ["octave", 57, 71, null, null], ["coctave", 60, 72, null, null]]) {
      await pauseToSheet();
      await p.click('#play-keys input[value="' + mode + '"]');
      await p.waitForFunction((lo, hi) => {
        const n = [...document.querySelectorAll("#keyboard .key")].map((k) => +k.dataset.note);
        return Math.min(...n) === lo && Math.max(...n) === hi;
      }, { timeout: 8000 }, lo, hi);
      await p.click("#play-restart");
      await p.click("#play-toggle");
      await p.waitForFunction(() => { const s = window.__pfTest.play.state(); return s.playing && s.wait && s.step === 0 && s.beat >= 0; }, { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 120));
      const km = await p.evaluate(() => {
        const kb = document.getElementById("keyboard"), kbr = kb.getBoundingClientRect(), sc = document.getElementById("kb-scroll");
        const sil = [...kb.querySelectorAll(".key-silhouette")].map((e) => ({ note: +e.dataset.note, side: e.classList.contains("left") ? "L" : "R",
          hidden: e.getAttribute("aria-hidden"), w: +e.offsetWidth.toFixed(1),
          look: (() => { const c = getComputedStyle(e), k = getComputedStyle(kb.querySelector(".key.black"));
            return c.opacity === k.opacity && c.backgroundImage === k.backgroundImage && c.pointerEvents === "none"; })(),
          inside: e.offsetLeft >= -0.5 && e.offsetLeft + e.offsetWidth <= kb.offsetWidth + 0.5 }));
        const bw = (kb.querySelector(".key.black") || {}).offsetWidth || 0;
        const st = window.__pfTest.play.state(), kh = window.__pfTest.play.keyHeight();
        const keys = kb.querySelectorAll(".key").length;
        return { mode: window.__pfTest.play.keysMode(), saved: localStorage.getItem("aplus.playkeys.v1"), keys, rangeLow: st.rangeLow, rangeHigh: st.rangeHigh,
          sil, blackW: bw, kbW: Math.round(kbr.width), fillW: Math.round(sc.getBoundingClientRect().width - 8), tilt: st.tilt,
          keyH: Math.round(kh.now), shownH: Math.round(innerHeight - kbr.top - 7), playing: st.playing };
      });
      const wantSil = [silL != null ? silL + "L" : null, silR != null ? silR + "R" : null].filter(Boolean).join(",");
      check("play: Keys " + mode + " on Mary RH shows " + lo + "-" + hi + " with edge half keys [" + wantSil + "] colored like the black keys, full width, key height kept, saved",
        km.mode === mode && km.saved === mode && km.keys === hi - lo + 1 && km.rangeLow === lo && km.rangeHigh === hi
          && km.sil.map((x) => x.note + x.side).join(",") === wantSil
          && km.sil.every((x) => x.hidden === "true" && x.inside && x.look && Math.abs(x.w - km.blackW / 2) <= 1)
          && km.kbW >= km.fillW - 1 && Math.abs(km.shownH - km.keyH) <= 2 && km.playing,
        JSON.stringify(km));
    }
    await pauseToSheet();
    await p.evaluate(() => localStorage.removeItem("aplus.playkeys.v1"));

    // Tilted keys and straight lanes: notes land on the keys' top edge.
    await pauseToSheet();
    await p.select("#play-song", "mary-had-a-little-lamb");
    await p.waitForFunction(() => window.__pfTest.play.state().song === "mary-had-a-little-lamb" && window.__pfTest.play.state().steps > 0, { timeout: 8000 });
    if (await p.evaluate(() => window.__pfTest.play.state().rung) !== "rh") await p.select("#play-rung", "rh");
    await p.waitForFunction(() => window.__pfTest.play.state().rung === "rh", { timeout: 8000 });
    const fixedStyle = await p.evaluate(() => ({ far: window.__pfTest.play.state().farScale, tilt: window.__pfTest.play.state().tilt,
      toggle: !!document.getElementById("play-style"), tiltClass: document.getElementById("keyboard").classList.contains("kb-tilt") }));
    check("play: straight lanes and keys tilted only as needed, with no style toggle in the menu",
      fixedStyle.far === 1 && fixedStyle.tilt >= 0 && fixedStyle.tilt <= 60 && fixedStyle.tiltClass === (fixedStyle.tilt > 0)
        && fixedStyle.toggle === false, JSON.stringify(fixedStyle));
    const tiltUnit = await p.evaluate(() => {
      const f = (w, n, h) => window.__pfTest.play.keyFit(w, n, h);
      const onScreen = (w, n, r) => +(r.ratio * w / n * Math.cos(r.tilt * Math.PI / 180)).toFixed(2);
      const fit = f(720, 13, 144), clamp = f(720, 9, 144), tiny = f(720, 9, 40);
      const range = window.__pfTest.play.keyRange;
      return {
        flatWhenFits: f(374, 9, 278), fit: fit.tilt, fitH: onScreen(720, 13, fit),
        fewer: f(720, 9, 200).tilt, more: f(720, 13, 200).tilt,
        portrait: f(374, 13, 278).tilt, landscape: f(720, 13, 144).tilt,
        clamp, clampH: onScreen(720, 9, clamp), tiny, tinyH: onScreen(720, 9, tiny),
        rangePort: range(374, 9, 844), rangeLand: range(720, 9, 360), rangeFew: range(100, 30, 844)
      };
    });
    check("play: key fit fills the height, tilts more with fewer keys and in landscape, then shortens the keys past 60°",
      tiltUnit.flatWhenFits.tilt === 0 && tiltUnit.flatWhenFits.ratio === 4.5 && tiltUnit.fit > 0 && tiltUnit.fit < 60
        && tiltUnit.fitH <= 144 && tiltUnit.fitH >= 143
        && tiltUnit.fewer > tiltUnit.more && tiltUnit.landscape > tiltUnit.portrait
        && tiltUnit.clamp.tilt === 60 && tiltUnit.clamp.ratio < 4.5 && Math.abs(tiltUnit.clampH - 144) < 0.01
        && tiltUnit.tiny.tilt === 60 && Math.abs(tiltUnit.tinyH - 40) < 0.01,
      JSON.stringify(tiltUnit));
    check("play: key height range runs from a small strip to flat full-width keys, at most 60% of the screen",
      Math.abs(tiltUnit.rangePort.max - 4.5 * 374 / 9) < 0.01 && Math.abs(tiltUnit.rangePort.min - 84.4) < 0.01
        && Math.abs(tiltUnit.rangeLand.max - 216) < 0.01 && tiltUnit.rangeLand.min === 48
        && tiltUnit.rangeFew.min === tiltUnit.rangeFew.max,
      JSON.stringify({ port: tiltUnit.rangePort, land: tiltUnit.rangeLand, few: tiltUnit.rangeFew }));
    for (const [name, w, h] of [["390x844", 390, 844], ["740x360", 740, 360]]) {
      await pauseToSheet();
      await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await new Promise((r) => setTimeout(r, 300));
      await p.click("#play-restart");
      await p.click("#play-toggle");
      await p.waitForFunction(() => { const s = window.__pfTest.play.state(); return s.playing && s.wait && s.step === 0 && s.beat >= 0; }, { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 80));
      const tg = await p.evaluate(() => {
        const cv = document.getElementById("highway"), hr = cv.getBoundingClientRect(), dpr = devicePixelRatio;
        const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
        const amber = (i) => d[i + 3] > 150 && d[i] > 170 && d[i + 1] > 110 && d[i + 2] < 125;
        let row = -1;
        for (let y = cv.height - 1; y >= 0 && row < 0; y--) for (let x = 0; x < cv.width; x++) if (amber((y * cv.width + x) * 4)) { row = y; break; }
        const xs = [];
        if (row >= 0) for (let x = 0; x < cv.width; x++) if (amber((row * cv.width + x) * 4)) xs.push(x);
        const st = window.__pfTest.play.state();
        const sc = document.getElementById("kb-scroll"), kb = document.getElementById("keyboard");
        const k = document.querySelector('#keyboard .key[data-note="' + st.next[0] + '"]');
        const topCx = sc.getBoundingClientRect().left + kb.offsetLeft - sc.scrollLeft + k.offsetLeft + k.offsetWidth / 2;
        const kbr = kb.getBoundingClientRect();
        const whites = [...kb.querySelectorAll(".key.white")].map((e) => e.getBoundingClientRect());
        const se = document.scrollingElement || document.documentElement;
        return {
          noteBottom: row < 0 ? null : +(hr.top + (row + 1) / dpr).toFixed(1),
          keyTopEdge: +kbr.top.toFixed(1),
          dx: xs.length ? +(hr.left + (xs[0] + xs[xs.length - 1]) / 2 / dpr - topCx).toFixed(1) : null,
          tilt: st.tilt,
          frontWider: kbr.width > kb.offsetWidth + 4,
          keysInside: Math.max(...whites.map((r) => r.bottom)) <= sc.getBoundingClientRect().bottom - 4,
          scrolls: se.scrollHeight > innerHeight || window.scrollY !== 0
        };
      });
      check("play: keys at " + name + " (tilt " + tg.tilt + "°): the waiting note lands on the key's top edge",
        tg.noteBottom != null && Math.abs(tg.noteBottom - tg.keyTopEdge) <= 3 && tg.dx != null && Math.abs(tg.dx) <= 3
          && tg.frontWider === (tg.tilt > 0) && tg.keysInside && !tg.scrolls,
        JSON.stringify(tg));
    }

    // Key height handle: sets the keys' top edge; the bottom stays on the screen's bottom.
    for (const [name, w, h] of [["390x844", 390, 844], ["740x360", 740, 360]]) {
      await pauseToSheet();
      await p.evaluate(() => localStorage.removeItem("aplus.keyheight.v1"));
      await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await new Promise((r) => setTimeout(r, 300));
      await p.click("#play-restart");
      await p.click("#play-toggle");
      await p.waitForFunction(() => { const s = window.__pfTest.play.state(); return s.playing && s.wait && s.step === 0 && s.beat >= 0; }, { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 80));
      const kh = () => p.evaluate(() => {
        const hd = document.getElementById("key-height"), hr = hd.getBoundingClientRect();
        const kb = document.getElementById("keyboard"), kbr = kb.getBoundingClientRect();
        const sc = document.getElementById("kb-scroll"), scr = sc.getBoundingClientRect();
        const wrap = document.querySelector(".kb-wrap").getBoundingClientRect();
        const pause = document.getElementById("play-pause");
        const pr = pause.hidden ? null : pause.getBoundingClientRect();
        const whites = [...kb.querySelectorAll(".key.white")].map((e) => e.getBoundingClientRect());
        const notes = [...kb.querySelectorAll(".key")].map((k) => +k.dataset.note);
        const st = window.__pfTest.play.state(), k = window.__pfTest.play.keyHeight();
        const cv = document.getElementById("highway"), cr = cv.getBoundingClientRect(), dpr = devicePixelRatio;
        const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
        const amber = (i) => d[i + 3] > 150 && d[i] > 170 && d[i + 1] > 110 && d[i + 2] < 125;
        let row = -1;
        for (let y = cv.height - 1; y >= 0 && row < 0; y--) for (let x = 0; x < cv.width; x++) if (amber((y * cv.width + x) * 4)) { row = y; break; }
        const se = document.scrollingElement || document.documentElement;
        const overlap = (a, b) => !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        return {
          role: hd.getAttribute("role"), label: hd.getAttribute("aria-label"), tab: hd.tabIndex,
          now: +hd.getAttribute("aria-valuenow"), vmin: +hd.getAttribute("aria-valuemin"), vmax: +hd.getAttribute("aria-valuemax"),
          visible: hr.width > 0 && hr.height > 0, rightEdge: Math.abs(hr.right - wrap.right) <= 2,
          handleBottom: +hr.bottom.toFixed(1), keysTop: +kbr.top.toFixed(1),
          onKeys: hr.bottom > kbr.top + 0.5, onPause: overlap(hr, pr),
          keyH: +k.now.toFixed(1), kmin: +k.min.toFixed(1), kmax: +k.max.toFixed(1),
          shownH: +(innerHeight - kbr.top).toFixed(1),
          wrapBottom: +wrap.bottom.toFixed(1), keysBottom: +Math.max(...whites.map((r) => r.bottom)).toFixed(1),
          innerH: innerHeight,
          count: notes.length, lo: Math.min(...notes), hi: Math.max(...notes), rangeLow: st.rangeLow, rangeHigh: st.rangeHigh,
          kbW: Math.round(kbr.width), fillW: Math.round(scr.width - 8), tilt: st.tilt,
          noteBottom: row < 0 ? null : +(cr.top + (row + 1) / dpr).toFixed(1), playing: st.playing,
          scrolls: se.scrollHeight > innerHeight || window.scrollY !== 0
        };
      });
      const okLayout = (g) => g.visible && !g.onKeys && !g.onPause && g.rightEdge && g.handleBottom >= g.keysTop - 6
        && Math.abs(g.shownH - 7 - g.keyH) <= 2
        && Math.abs(g.wrapBottom - g.innerH) <= 1 && g.keysBottom <= g.innerH && g.keysBottom >= g.innerH - 9
        && g.lo === g.rangeLow && g.hi === g.rangeHigh && g.count === g.rangeHigh - g.rangeLow + 1
        && g.kbW >= g.fillW - 1 && g.noteBottom != null && Math.abs(g.noteBottom - g.keysTop) <= 3 && !g.scrolls;
      const g0 = await kh();
      check("play: Key height handle at " + name + " is a labelled slider at the right, just above the keys, clear of Pause",
        g0.role === "slider" && g0.label === "Key height" && g0.tab === 0 && g0.vmin <= g0.now && g0.now <= g0.vmax && okLayout(g0),
        JSON.stringify(g0));
      // Drag while playing.
      const hb = await p.$eval("#key-height", (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await p.mouse.move(hb.x, hb.y);
      await p.mouse.down();
      await p.mouse.move(hb.x, hb.y + 30, { steps: 4 });
      await p.mouse.up();
      await new Promise((r) => setTimeout(r, 150));
      const g1 = await kh();
      check("play: dragging the Key height handle down at " + name + " lowers the keys' top edge while playing; bottom stays flush, same keys",
        g1.playing === true && g1.keysTop > g0.keysTop + 20 && (Math.abs(g1.keyH - (g0.keyH - 30)) <= 2 || g1.keyH === g1.kmin) && okLayout(g1),
        JSON.stringify({ before: g0.keysTop, after: g1, }));
      // Keyboard control, with a visible focus ring.
      await p.keyboard.press("Shift");
      await p.focus("#key-height");
      const ring = await p.$eval("#key-height", (e) => ({ fv: e.matches(":focus-visible"), outline: getComputedStyle(e).outlineStyle, ow: parseFloat(getComputedStyle(e).outlineWidth) }));
      await p.keyboard.press("ArrowUp");
      await p.keyboard.press("ArrowUp");
      await new Promise((r) => setTimeout(r, 120));
      const g2 = await kh();
      await p.keyboard.press("End");
      await new Promise((r) => setTimeout(r, 120));
      const gMax = await kh();
      await p.keyboard.press("Home");
      await new Promise((r) => setTimeout(r, 120));
      const gMin = await kh();
      check("play: Key height handle at " + name + " works with arrow, Home and End keys and shows a focus ring",
        ring.fv && ring.outline !== "none" && ring.ow >= 2
          && Math.abs(g2.keyH - Math.min(g2.kmax, g1.keyH + 0.04 * h)) <= 1.5 && g2.keysTop < g1.keysTop
          && gMax.keyH === gMax.kmax && gMin.keyH === gMin.kmin && gMin.keysTop > gMax.keysTop
          && okLayout(g2) && okLayout(gMax) && okLayout(gMin),
        JSON.stringify({ ring, up: g2.keyH, max: [gMax.keyH, gMax.kmax, gMax.tilt], min: [gMin.keyH, gMin.kmin, gMin.tilt] }));
      // Paused, the handle still works over the sheet.
      await pauseToSheet();
      await p.focus("#key-height");
      await p.keyboard.press("PageUp");
      await new Promise((r) => setTimeout(r, 120));
      const gP = await kh();
      check("play: Key height handle at " + name + " also works while paused",
        gP.playing === false && gP.keyH > gMin.keyH && gP.keysTop < gMin.keysTop, JSON.stringify({ min: gMin.keyH, paused: gP.keyH }));
      // Saved per orientation.
      const saved = await p.evaluate(() => JSON.parse(localStorage.getItem("aplus.keyheight.v1") || "{}"));
      const p2 = await browser.newPage();
      p2.on("pageerror", (err) => jsErrors.push(String(err)));
      await p2.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await p2.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
      await p2.waitForFunction(() => window.__pfTest && window.__pfTest.play, { timeout: 8000 });
      if (!(await p2.evaluate(() => document.body.classList.contains("mode-play")))) await p2.click("#mode-play");
      await p2.waitForFunction(() => window.__pfTest.play.state().song === "mary-had-a-little-lamb" && window.__pfTest.play.state().rung === "rh"
        && window.__pfTest.play.keyHeight().now > 0, { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 200));
      const k2 = await p2.evaluate(() => window.__pfTest.play.keyHeight());
      await p2.close();
      const side = h > w ? "port" : "land", other = h > w ? "land" : "port";
      check("play: Key height at " + name + " is saved for this orientation and restored on reload",
        typeof saved[side] === "number" && Math.abs(saved[side] * h - gP.keyH) <= 1 && saved[other] === undefined
          && Math.abs(k2.now - gP.keyH) <= 1.5 && k2.land === (side === "land"),
        JSON.stringify({ saved, paused: gP.keyH, reloaded: k2 }));
    }
    await p.evaluate(() => localStorage.removeItem("aplus.keyheight.v1"));
    await pauseToSheet();
    await p.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await new Promise((r) => setTimeout(r, 300));

    await p.click("#play-to-test");
    const back = await p.evaluate(() => {
      const keys = [...document.querySelectorAll("#keyboard .key")].map((k) => +k.dataset.note);
      const st = window.__pfTest.getState();
      const wrap = document.querySelector(".status-wrap");
      const sr = wrap.getBoundingClientRect();
      const top = document.querySelector(".top");
      const tr = top.getBoundingClientRect();
      const sound = document.getElementById("sound-controls");
      const btn = document.getElementById("btn-sound");
      const vol = document.getElementById("sound-volume");
      const vis = (el) => !!(el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== "none");
      return {
        lowerVisible: getComputedStyle(document.querySelector(".lower")).display !== "none",
        highwayOff: getComputedStyle(document.getElementById("highway")).display === "none",
        count: keys.length,
        lo: Math.min(...keys),
        hi: Math.max(...keys),
        visibleLow: st.visibleLow,
        visibleHigh: st.visibleHigh,
        statusVisible: sr.height > 0 && getComputedStyle(wrap).display !== "none",
        headerVisible: tr.height > 0 && getComputedStyle(top).display !== "none",
        soundInHeader: !!(top && sound && top.contains(sound) && vis(btn) && vis(vol)),
        playMode: document.body.classList.contains("mode-play")
      };
    });
    check("play: the Test switch restores the checker and the Test header",
      back.lowerVisible === true && back.highwayOff === true
        && back.count === 25 && back.lo === 48 && back.hi === 72
        && back.visibleLow === 48 && back.visibleHigh === 72
        && back.statusVisible === true
        && back.headerVisible === true && back.soundInHeader === true
        && back.playMode === false,
      JSON.stringify(back));
    await p.close();
  }

  // Songs catalog (files only).
  runSongsChecks(check, import.meta.url);

  check("no page JS errors", jsErrors.length === 0, jsErrors.join(" | "));

  results.screenshots = { portrait, landscape };
  results.layout = { portrait: portLay, landscape: landLay };
} catch (e) {
  results.ok = false;
  results.errors.push(String(e.stack || e));
  console.error(e);
} finally {
  await browser.close();
}

fs.writeFileSync("/tmp/pf-verify/results.json", JSON.stringify(results, null, 2));
console.log("\n" + (results.ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED") +
  "  (" + results.checks.filter((c) => c.pass).length + "/" + results.checks.length + ")");
process.exit(results.ok ? 0 : 1);
