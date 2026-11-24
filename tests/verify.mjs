import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";

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

  await page.evaluateOnNewDocument(() => { try { localStorage.removeItem("aplus.pane.v1"); } catch (e) {} });
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
  check("bottom hint keeps the no-sound line and drops the on-screen keys line",
    /No sound is played/.test(kbHeader.bottom)
      && /this page only shows what the keyboard sends\.?$/.test(kbHeader.bottom)
      && !/On-screen keys/.test(kbHeader.bottom)
      && !/can be tapped to test/.test(kbHeader.bottom),
    kbHeader.bottom);

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
      await p.evaluateOnNewDocument(() => { try { localStorage.removeItem("aplus.pane.v1"); } catch (e) {} });
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

    return { before, opened, onLog, afterArrow, hashed, emptyOpen, copied, afterChange };
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
      && /^Browser$/m.test(dbg.hashed.report),
    JSON.stringify({ pane: dbg.hashed.pane, text: dbg.hashed.text.slice(0, 240), report: (dbg.hashed.report || "").split("\\n").slice(0, 16) }));
  check("troubleshooting Copy report includes the inputs count",
    typeof dbg.copied === "string" && /Inputs \(0\)/.test(dbg.copied)
      && /Browser sees no MIDI keyboard/.test(dbg.copied)
      && /^Devices$/m.test(dbg.copied)
      && /^Connection$/m.test(dbg.copied)
      && /^Browser$/m.test(dbg.copied)
      && /Web MIDI support:/.test(dbg.copied)
      && /Permission:/.test(dbg.copied),
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
    await p.evaluateOnNewDocument(() => { try { localStorage.removeItem("aplus.pane.v1"); } catch (e) {} });
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
