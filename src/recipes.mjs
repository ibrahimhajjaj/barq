// Recipes: a step that worked once is recorded as the actions it took, each tied to a description
// of its target rather than an element number. Next time the same goal starts on the same page,
// the actions are replayed without asking Jev, as long as every target can still be found. Where
// the page differs, replay stops and the normal Jev loop takes over from there. A single Jev
// question checks the result at the end, so a replay can't claim "done" on its own.
//
// The file keeps nothing readable from the pages: element names, surrounding text, addresses and
// the goal are kept as fingerprints, and replay compares fingerprints taken the same way from the
// live page. Only tool names, element kinds and the names of the caller's values stay readable.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export function recipeFile(env = process.env, platform = process.platform) {
  if (env.BARQ_RECIPES === "0") return null;
  if (env.BARQ_RECIPES) return env.BARQ_RECIPES;
  const base = platform === "darwin" ? join(homedir(), "Library", "Application Support")
    : platform === "win32" ? (env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
    : (env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
  return join(base, "barq", "recipes.json");
}

// Where a step starts: origin and path, not the query or fragment (those carry search terms, ids).
export function place(url) {
  try { const u = new URL(url); return u.origin + u.pathname.replace(/\/+$/, ""); } catch { return String(url); }
}

export function recipeKey(goal, url, values = {}) {
  return fingerprint(JSON.stringify([place(url), goal.toLowerCase().replace(/\s+/g, " ").trim(), Object.keys(values).sort()]));
}

// Page text can repeat what was typed (a new todo, a search term). Value contents become {name}
// before a fingerprint is taken, so a step recorded with one value finds the element that goes
// with another. Contents shorter than 3 characters are left, they would match all over the text.
export function maskValues(text, values = {}) {
  const subs = Object.entries(values).map(([k, v]) => [k, String(v)]).filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length);
  return subs.reduce((t, [k, v]) => t.split(v).join(`{${k}}`), String(text));
}

// 64 bits of a hash of the text, spacing evened out: equal text gives an equal fingerprint, and
// the text can't be read back from it (someone guessing a short common label could confirm it).
export function fingerprint(text, values) {
  return createHash("sha256").update(maskValues(text, values).normalize("NFC").replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

// A hash of values exactly as given, names and contents, for telling in memory whether a later
// call was given the same ones. Never stored: short values would be easy to guess back from it.
export function valuesPrint(values = {}) {
  return createHash("sha256").update(JSON.stringify(Object.keys(values).sort().map(k => [k, String(values[k])]))).digest("hex");
}

// Whether live text is what a fingerprint was taken of: as it reads, or with the current values
// in it masked (then the recorded text held the values it was recorded with in their place).
export function matches(text, print, values) {
  const masked = maskValues(text, values);
  return fingerprint(text) === print || (masked !== String(text) && fingerprint(masked) === print);
}

const nameOf = e => (e.label || e.text || e.placeholder || e.name || "").slice(0, 80);
const sameKind = (a, b) => a.tag === b.tag && nameOf(a) === nameOf(b) && !!a.frame === !!b.frame;

// What identifies an element across visits: its kind, and fingerprints of its name, the text
// around it and its link. Given the page's elements, `alike` notes that look-alikes stood next to
// it, so its surroundings told it apart.
export function describe(el, elements = [], values = {}) {
  if (!el) return null;
  const d = { tag: el.tag, name: fingerprint(nameOf(el), values) };
  if (el.near) d.near = fingerprint(el.near, values);
  if (el.href) d.href = fingerprint(el.href, values);
  if (el.frame) d.frame = true;
  if (elements.some(e => e !== el && sameKind(e, el))) d.alike = true;
  return d;
}

// The element on this page that matches a description: same kind and name, and among several
// look-alikes the one with the same surrounding text. Ambiguity means no match. One that had
// look-alikes must keep its surroundings even when it is the only one left: that one may be
// another row, the recorded one gone.
export function findElement(d, elements, values = {}) {
  if (!d) return null;
  const same = elements.filter(e => e.tag === d.tag && !!e.frame === !!d.frame && matches(nameOf(e), d.name, values));
  if (same.length === 1 && !d.alike) return same[0];
  const fits = (text, print) => text ? !!print && matches(text, print, values) : !print;
  const byNear = same.filter(e => fits(e.near, d.near) && fits(e.href, d.href));
  return byNear.length === 1 ? byNear[0] : null;
}

// Recipes in the fingerprinted form carry this. Older ones kept page text: never used, and dropped.
const FORMAT = 2;

// Several processes can share the file (one MCP server per agent session), so every change
// re-reads it first and writes it back atomically: a concurrent write can be lost, the file can't be torn.
export class RecipeBook {
  constructor({ file = recipeFile(), max = 500 } = {}) {
    this.file = file; this.max = max;
    this.recipes = this.load();
    if (this.stale) this.change(() => {});
  }

  load() {
    let r = {};
    if (this.file) try { r = JSON.parse(readFileSync(this.file, "utf8")); } catch {}
    if (!r || typeof r !== "object" || Array.isArray(r)) r = {};
    const kept = Object.fromEntries(Object.entries(r).filter(([, x]) => x?.v === FORMAT && Array.isArray(x.steps)));
    this.stale = Object.keys(kept).length < Object.keys(r).length;
    return kept;
  }

  get(key) { this.recipes = this.load(); return this.recipes[key] ?? null; }

  // steps: [{ tool, at, target?, checked?, valueKey?, option?, optionIndex?, key?, destination?, irreversible? }]
  put(key, steps) {
    if (!steps.length) return;
    this.change(r => { r[key] = { v: FORMAT, steps, saved: new Date().toISOString(), replays: 0, misses: 0 }; });
  }

  note(key, { replayed = false, missed = false } = {}) {
    this.change(r => {
      const rec = r[key];
      if (!rec) return;
      if (replayed) rec.replays++;
      if (missed) rec.misses++;
      // a recipe that keeps missing is worse than none: every miss costs a snapshot before Jev starts
      if (rec.misses >= 3 && rec.misses > rec.replays) delete r[key];
    });
  }

  drop(key) { this.change(r => { delete r[key]; }); }

  change(fn) {
    if (!this.file) return;
    const r = this.load();
    fn(r);
    const keys = Object.keys(r);
    if (keys.length > this.max) {
      keys.sort((a, b) => r[a].saved.localeCompare(r[b].saved));
      for (const k of keys.slice(0, keys.length - this.max)) delete r[k];
    }
    this.recipes = r;
    try {
      // what the user worked on, even as fingerprints: theirs to read, nobody else's
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(r, null, 1), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {}
  }
}
