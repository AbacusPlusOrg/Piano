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

  const resp = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  await new Promise((r) => setTimeout(r, 200));
  check("page HTTP status", resp && resp.ok(), resp ? String(resp.status()) : "no response");
  check("title", (await page.title()) === "A+Piano — MIDI test", await page.title());

  const hasHook = await page.evaluate(() => typeof window.__pfTest?.feed === "function");
  check("__pfTest.feed exposed", hasHook);

  const boot = await page.evaluate(() => window.__pfTest.getState());
  check("secure context on localhost", boot.secureContext === true);
  check("midiSupported flag is boolean", typeof boot.midiSupported === "boolean", String(boot.midiSupported));
  check("default visible range C3-C6 (48-84)", boot.visibleLow === 48 && boot.visibleHigh === 84,
    JSON.stringify({ low: boot.visibleLow, high: boot.visibleHigh }));
  const keyCount = await page.evaluate(() => document.querySelectorAll(".key").length);
  check("37 white+black keys in DOM", keyCount === 37, String(keyCount));

  const statusText = await page.evaluate(() => document.querySelector("#status .msg").innerText);
  console.log("STATUS  " + statusText.replace(/\s+/g, " "));
  check("status mentions connect or MIDI", /midi|connect|allow|device|permission/i.test(statusText), statusText.slice(0, 180));

  const portLay = await layoutInfo(page);
  console.log("LAYOUT portrait", JSON.stringify(portLay));
  check("portrait keys keep piano proportion (h/w ~6.4)", Math.abs(portLay.kb.h / (portLay.kb.w / portLay.whiteCount) - 6.4) < 0.3, JSON.stringify(portLay.kb));
  check("portrait black keys have height", portLay.blackCount === 15 && Math.abs(portLay.blackH / portLay.whiteH - 0.62) < 0.03,
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

  await page.evaluate(() => {
    const btn = document.getElementById("btn-log");
    if (!document.getElementById("log").classList.contains("open")) btn.click();
  });
  await new Promise((r) => setTimeout(r, 80));

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
  check("landscape black keys visible", landLay.blackCount === 15 && landLay.blackH >= 60 && landLay.blackW >= 8,
    JSON.stringify({ blackCount: landLay.blackCount, blackH: landLay.blackH, blackW: landLay.blackW, whiteH: landLay.whiteH }));

  await page.evaluate(() => window.__pfTest.feed([0x90, 24, 90]));
  await new Promise((r) => setTimeout(r, 40));
  st = await page.evaluate(() => window.__pfTest.getState());
  check("visible range extended down to C1", st.visibleLow === 24, String(st.visibleLow));
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

  await page.evaluate(() => document.getElementById("btn-reset-range").click());
  await new Promise((r) => setTimeout(r, 40));
  st = await page.evaluate(() => window.__pfTest.getState());
  check("reset returns visible range to 48-84", st.visibleLow === 48 && st.visibleHigh === 84,
    JSON.stringify({ low: st.visibleLow, high: st.visibleHigh }));

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
