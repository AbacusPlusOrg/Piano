// File-only checks for the public songs catalog. Used by tests/verify.mjs
// and also runnable on its own: node tests/songs-catalog.mjs
import fs from "fs";
import path from "path";

export function songsRoots(importMetaUrl) {
  const here = path.dirname(new URL(importMetaUrl).pathname);
  return [
    path.join(here, "../songs"),
    "/workspace/aplus-piano-repo/songs",
    "/workspace/pianoflow/app/songs",
  ];
}

export function runSongsChecks(check, importMetaUrl = import.meta.url) {
  const roots = songsRoots(importMetaUrl);
  const root = roots.find((r) => fs.existsSync(path.join(r, "index.json")));
  check("songs/index.json is present", !!root, roots.join(" | "));
  if (!root) return;
  let index = null;
  let parseOk = false;
  let parseErr = "";
  try {
    index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
    parseOk = true;
  } catch (e) {
    parseErr = String(e);
  }
  check("songs/index.json parses", parseOk, parseErr);
  const list = index && Array.isArray(index.songs) ? index.songs : [];
  check("songs/index.json lists at least one song", list.length >= 1, "count=" + list.length);
  const entriesOk = list.every((s) =>
    s && typeof s.id === "string" && s.id.length > 0
    && typeof s.title === "string" && s.title.length > 0
    && typeof s.score === "number" && s.score >= 0 && s.score <= 10);
  check("each index entry has id, title and a 0-10 score", entriesOk, JSON.stringify(list));
  const missing = [];
  for (const s of list) {
    const dir = path.join(root, s.id);
    for (const f of ["song.json", "score.musicxml", "full.mid"]) {
      if (!fs.existsSync(path.join(dir, f))) missing.push(s.id + "/" + f);
    }
    const songPath = path.join(dir, "song.json");
    if (fs.existsSync(songPath)) {
      try { JSON.parse(fs.readFileSync(songPath, "utf8")); }
      catch (e) { missing.push(s.id + "/song.json (invalid JSON: " + e.message + ")"); }
    }
    const xmlPath = path.join(dir, "score.musicxml");
    if (fs.existsSync(xmlPath)) {
      const head = fs.readFileSync(xmlPath, "utf8").slice(0, 400);
      if (!/score-partwise/.test(head)) missing.push(s.id + "/score.musicxml (not score-partwise)");
    }
    const midPath = path.join(dir, "full.mid");
    if (fs.existsSync(midPath)) {
      const buf = fs.readFileSync(midPath);
      if (buf.length < 8 || buf.slice(0, 4).toString("ascii") !== "MThd") {
        missing.push(s.id + "/full.mid (not a MIDI file)");
      }
    }
  }
  check("each song folder has song.json, score.musicxml and full.mid", missing.length === 0, missing.join(", "));
}

if (process.argv[1] && path.basename(process.argv[1]) === "songs-catalog.mjs") {
  const results = { ok: true, checks: [] };
  function check(name, cond, detail) {
    results.checks.push({ name, pass: !!cond, detail: detail ?? "" });
    if (!cond) results.ok = false;
    console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? " — " + detail : ""));
  }
  runSongsChecks(check, import.meta.url);
  console.log("\n" + (results.ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED") +
    "  (" + results.checks.filter((c) => c.pass).length + "/" + results.checks.length + ")");
  process.exit(results.ok ? 0 : 1);
}
