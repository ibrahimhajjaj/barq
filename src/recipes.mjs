// Recipes: a step that worked once is recorded as the actions it took, each tied to a description
// of its target rather than an element number. Next time the same goal starts on the same page,
// the actions are replayed without asking Jev, as long as every target can still be found. Where
// the page differs, replay stops and the normal Jev loop takes over from there. A single Jev
// question checks the result at the end, so a replay can't claim "done" on its own.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export function recipeFile(env = process.env, platform = process.platform) {
  if (env.JEV_BROWSER_RECIPES === "0") return null;
  if (env.JEV_BROWSER_RECIPES) return env.JEV_BROWSER_RECIPES;
  const base = platform === "darwin" ? join(homedir(), "Library", "Application Support")
    : platform === "win32" ? (env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
    : (env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
  return join(base, "jev-browser", "recipes.json");
}

// Where a step starts: origin and path, not the query or fragment (those carry search terms, ids).
export function place(url) {
  try { const u = new URL(url); return u.origin + u.pathname.replace(/\/+$/, ""); } catch { return String(url); }
}

export function recipeKey(goal, url, values = {}) {
  const g = goal.toLowerCase().replace(/\s+/g, " ").trim();
  return `${place(url)} :: ${g} :: ${Object.keys(values).sort().join(",")}`;
}

const nameOf = e => (e.label || e.text || e.placeholder || e.name || "").slice(0, 80);
const sameKind = (e, d) => e.tag === d.tag && nameOf(e) === d.name && !!e.frame === !!d.frame;

// What identifies an element across visits: its kind, its name, and the text around it. Given the
// page's elements, `alike` notes that look-alikes stood next to it, so its surroundings told it apart.
export function describe(el, elements = []) {
  if (!el) return null;
  const d = { tag: el.tag, name: nameOf(el) };
  if (el.near) d.near = el.near.slice(0, 100);
  if (el.href) d.href = el.href;
  if (el.frame) d.frame = true;
  if (elements.some(e => e !== el && sameKind(e, d))) d.alike = true;
  return d;
}

// The element on this page that matches a description: same kind and name, and among several
// look-alikes the one with the same surrounding text. Ambiguity means no match. One that had
// look-alikes must keep its surroundings even when it is the only one left: that one may be
// another row, the recorded one gone.
export function findElement(d, elements) {
  if (!d) return null;
  const same = elements.filter(e => sameKind(e, d));
  if (same.length === 1 && !d.alike) return same[0];
  const byNear = same.filter(e => (e.near ?? "") === (d.near ?? "") && (e.href ?? null) === (d.href ?? null));
  return byNear.length === 1 ? byNear[0] : null;
}

// Page text can repeat what was typed (a new todo, a search term), and a recipe keeps values by name
// only. So their contents become {name} in what a step records, and replay puts the current values
// back: replayed with other values, a step looks for the element that goes with them. Contents
// shorter than 3 characters are left, they would match all over the text.
function mapText(step, f) {
  const d = x => x && { ...x, ...Object.fromEntries(["name", "near", "href"].filter(k => x[k]).map(k => [k, f(x[k], k === "near" ? 100 : 80)])) };
  return { ...step, at: f(step.at, Infinity), ...(step.target ? { target: d(step.target) } : {}), ...(step.destination ? { destination: d(step.destination) } : {}) };
}

export function maskValues(step, values) {
  const subs = Object.entries(values).map(([k, v]) => [k, String(v)]).filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length);
  return mapText(step, s => subs.reduce((t, [k, v]) => t.split(v).join(`{${k}}`), s));
}

export function fillValues(step, values) {
  return mapText(step, (s, max) => s.replace(/\{([^{}]+)\}/g, (m, k) => Object.hasOwn(values, k) ? String(values[k]) : m).slice(0, max));
}

// Several processes can share the file (one MCP server per agent session), so every change
// re-reads it first and writes it back atomically: a concurrent write can be lost, the file can't be torn.
export class RecipeBook {
  constructor({ file = recipeFile(), max = 500 } = {}) {
    this.file = file; this.max = max;
    this.recipes = this.load();
  }

  load() {
    if (!this.file) return {};
    try { return JSON.parse(readFileSync(this.file, "utf8")); } catch { return {}; }
  }

  get(key) { this.recipes = this.load(); return this.recipes[key] ?? null; }

  // steps: [{ tool, at, target?, checked?, valueKey?, option?, optionIndex?, key?, destination?, irreversible? }]
  put(key, steps) {
    if (!steps.length) return;
    this.change(r => { r[key] = { steps, saved: new Date().toISOString(), replays: 0, misses: 0 }; });
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
      // it holds bits of the pages the user worked on: theirs to read, nobody else's
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(r, null, 1), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {}
  }
}
