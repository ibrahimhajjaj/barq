// Helpers over what the page script returns. Nothing here touches a browser or the network.

const TYPED_INPUT = /^(input:(text|email|password|search|tel|url|number|date|datetime-local|month|week|time|color|range)|textarea)/;
const TYPED_ROLE = /\[(textbox|searchbox|combobox)\]/;

// Something text can be typed into: a real field, an ARIA one, or an editable div carrying a value.
export const FIELDISH = e => !!e && (e.editable === true || TYPED_INPUT.test(e.tag) || TYPED_ROLE.test(e.tag) || (e.tag.startsWith("div[") && e.value !== undefined));
export const SELECTISH = e => Boolean(e) && (e.tag === "select" || Boolean(e.options));
export const FILEISH = e => e?.tag === "input:file";

// In order of how likely each is to be what a person would call the element.
const NAMED_BY = ["label", "text", "placeholder", "name", "near", "href"];

export function brief(e) {
  if (!e) return "?";
  const name = NAMED_BY.map(key => e[key]).find(Boolean) ?? "";
  return `${e.tag} "${String(name).substring(0, 50)}"`;
}

const WORDS_COMPARED = 600;

// The runs of words the page gained, e.g. "walk the dog", "2 items". Words that only moved are not
// gained, which is why this walks a longest-common-subsequence table rather than diffing sets.
export function insertedText(before, after, max = 300) {
  const was = before.split(" ").slice(0, WORDS_COMPARED), now = after.split(" ").slice(0, WORDS_COMPARED);
  // shared[i][j]: how many words was[i..] and now[j..] still have in common
  const shared = Array.from({ length: was.length + 1 }, () => new Uint16Array(now.length + 1));
  for (let i = was.length - 1; i >= 0; i--)
    for (let j = now.length - 1; j >= 0; j--)
      shared[i][j] = was[i] === now[j] ? shared[i + 1][j + 1] + 1 : Math.max(shared[i + 1][j], shared[i][j + 1]);

  const runs = [];
  let run = [], i = 0, j = 0;
  const endRun = () => { if (run.length) { runs.push(run.join(" ")); run = []; } };
  while (j < now.length) {
    if (i < was.length && was[i] === now[j]) { endRun(); i++; j++; }           // both sides have this word
    else if (i < was.length && shared[i + 1][j] >= shared[i][j + 1]) i++;      // only the old text had it
    else run.push(now[j++]);                                                   // the page gained it
  }
  endRun();
  return runs.join(" | ").substring(0, max);
}

// Everything about an element that an action can change, as one string, so two of them compare with ===.
const stateOf = e => [
  e.checked !== undefined ? `checked=${e.checked}` : "",
  e.value ? `value="${e.value}"` : "",
  e.filled ? "filled" : "",
  e.active ? "active" : "",
  e.sorted ? `sorted=${e.sorted}` : "",
].filter(Boolean).join(" ");

// The name plus the text around it, which is what tells one list row's button from the next.
const identity = e => `${brief(e)}${e.near && e.near !== (e.label || e.text) ? ` near "${e.near.slice(0, 40)}"` : ""}`;
const withState = e => (stateOf(e) ? `${identity(e)} ${stateOf(e)}` : identity(e));

// Match each element of the new page to one of the old: first by identity, then, for what is left,
// by name alone and in the order both pages list them. Duplicates therefore pair one for one, so
// two "Toggle" checkboxes stay two elements rather than collapsing into one.
function pairUp(before, after) {
  const unclaimed = [...before], pairs = [], unmatched = [], appeared = [];
  const claim = same => { const k = unclaimed.findIndex(same); return k >= 0 ? unclaimed.splice(k, 1)[0] : null; };

  for (const e of after) {
    const was = claim(old => identity(old) === identity(e));
    was ? pairs.push([was, e]) : unmatched.push(e);
  }
  for (const e of unmatched) {
    const was = claim(old => brief(old) === brief(e));
    was ? pairs.push([was, e]) : appeared.push(e);
  }
  return { pairs, appeared, went: unclaimed };
}

const MOST_LISTED = 15;
const MOST_MOVED = 10;

// Same elements in a different order (a drag, a sort): the stretch of the page that moved, from the
// first line that differs to the last, so a sorted table doesn't report every row.
function movedPart(before, after) {
  const was = before.map(withState), now = after.map(withState);
  if (was.length !== now.length) return null;
  const first = was.findIndex((line, k) => line !== now[k]);
  if (first < 0) return null;
  let last = was.length - 1;
  while (last > first && was[last] === now[last]) last--;
  const upto = Math.min(last + 1, first + MOST_MOVED);
  return { before: was.slice(first, upto), after: now.slice(first, upto) };
}

// What changed between two page models: elements gained, lost or in a new state (value, checked,
// active, sorted), a reordering, the URL, the metrics, and text the page gained. Surrounding text
// changing on its own is not an element change.
export function pageDiff(before, after) {
  if (!before) return undefined;
  const { pairs, appeared, went } = pairUp(before.elements, after.elements);
  const changed = pairs
    .filter(([was, now]) => stateOf(was) !== stateOf(now))
    .map(([was, now]) => `${identity(now)}: ${stateOf(was) || "(empty)"} -> ${stateOf(now) || "(empty)"}`);

  const d = {};
  for (const [name, lines] of [["added", appeared.map(withState)], ["removed", went.map(withState)], ["changed", changed]]) {
    if (lines.length) d[name] = lines.slice(0, MOST_LISTED);
  }
  if (!d.added && !d.removed && !d.changed) {
    const moved = movedPart(before.elements, after.elements);
    if (moved) d.reordered = moved;
  }

  if (before.url !== after.url) d.url = `${before.url} -> ${after.url}`;
  for (const [name, value] of Object.entries(after.metrics ?? {})) {
    if (before.metrics?.[name] !== value) (d.metrics ??= {})[name] = `${before.metrics?.[name]} -> ${value}`;
  }
  const gained = insertedText(before.text, after.text);
  if (gained) d.new_text = gained;
  return d;
}

// Words worth matching a goal against: everything a person would read off the control.
const NAME_OF = e => `${e.label ?? ""} ${e.text ?? ""} ${e.placeholder ?? ""} ${e.name ?? ""} ${e.near ?? ""}`.toLowerCase();
const GOAL_WORDS = goal => [...new Set(String(goal).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? [])];

// Which elements a goal is most likely to be about. A page a little over the question's option cap
// would otherwise have to be asked about in two rounds, which doubles the calls on every one; this
// keeps the likeliest `keep` of them and hands them back in page order, so the numbering a reader
// sees still runs down the page.
export function likelyFor(elements, goal, keep) {
  if (elements.length <= keep) return elements;
  const words = GOAL_WORDS(goal);
  const score = e => {
    const name = NAME_OF(e);
    let n = 0;
    for (const w of words) if (name.includes(w)) n += name.split(/\W+/).includes(w) ? 4 : 2.5;
    if (FIELDISH(e) || SELECTISH(e)) n += 2;                       // something to fill in is rarely noise
    if (/^(button|a|input:submit|input:button)/.test(e.tag)) n += 1.5;
    if (e.active) n += 1;
    if (e.disabled) n -= 5;
    if (e.covered || e.hidden) n -= 3;
    return n;
  };
  const ranked = elements.map((e, k) => ({ e, k, n: score(e) })).sort((a, b) => b.n - a.n || a.k - b.k);
  return ranked.slice(0, keep).sort((a, b) => a.k - b.k).map(x => x.e);
}

// The words in a goal that could be meant as something to type. Jev cannot write text, but it can
// pick, so a goal that names what to look for can still fill a search box: quoted text first, then
// what follows the words people use to introduce a term, then the runs of capitalised words, then
// the goal with its leading instruction words removed.
const LEAD_IN = /\b(?:about|for|named|called|titled|search(?:ing)? for|look(?:ing)? up|find|enter|type)\s+(.{3,80}?)(?:[.,;]|$)/giu;
const OPENER = /^\s*(?:please\s+)?(?:open|go to|navigate to|find|search|look up|show|read|view|get)\s+(?:the\s+|a\s+|an\s+)?/iu;
const TRAILING = /\s*(?:\b(?:page|article|entry|result|results|on [a-z]+)\b[\s.]*)+$/iu;

export function phrasesFrom(goal) {
  const text = String(goal ?? "").trim();
  const out = [];
  const INSTRUCTION = /^(?:open|go|navigate|find|search|look|show|read|view|get|click|type|enter|use|then|please)$/iu;
  const add = p => {
    const clean = p.replace(/^["'“”‘’\s]+|["'“”‘’\s.,;:]+$/gu, "").trim();
    if (clean.length < 2 || clean.length > 80 || INSTRUCTION.test(clean)) return;      // a verb is not a search term
    if (!out.some(x => x.toLowerCase() === clean.toLowerCase())) out.push(clean);
  };
  for (const m of text.matchAll(/["'“‘]([^"'“”‘’]{2,80})["'”’]/gu)) add(m[1]);
  for (const m of text.matchAll(LEAD_IN)) add(m[1]);
  const capitalised = text.match(/\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)*/gu) ?? [];
  for (const run of capitalised) if (run.split(/\s+/).length > 1 || run.length > 3) add(run);
  add(text.replace(OPENER, "").replace(TRAILING, ""));
  return out.slice(0, 10);
}

// Goals that a page can be read for an answer to, rather than asked about. A step that says what it
// wants in so many words ("type X into the search box", "choose Purple", "open the About page",
// "tick Remember me") is finished when the page says so, and code can see that as well as a model
// can, at no cost and without an opinion. Anything less plain than these returns null and is asked
// about as before.
const PLAIN_GOALS = [
  [/^\s*(?:please\s+)?(?:type|enter|fill in|fill|write|put)\b/iu, "type"],
  [/^\s*(?:please\s+)?(?:choose|select|pick)\b/iu, "choose"],
  [/^\s*(?:please\s+)?(?:open|go to|navigate to|visit)\b/iu, "open"],
  [/^\s*(?:please\s+)?(?:tick|check|mark)\b/iu, "tick"],
  [/^\s*(?:please\s+)?(?:add|create|submit|post|insert|save)\b/iu, "create"],
];
// more than one thing to do, so the page showing one of them proves nothing
const COMPOUND = /\b(?:then|after that|and then)\b|,\s*(?:then|and)\b|\band\s+(?:\w+\s+)?(?:continue|submit|save|send|open|click|press|choose|select|confirm|apply|search|go)\b/iu;

export function plainGoal(goal, values = {}) {
  const text = String(goal ?? "");
  if (!text || COMPOUND.test(text)) return null;
  if (mayCount(text)) return null;          // a goal that counts is settled by counting, not by this
  const hit = PLAIN_GOALS.find(([re]) => re.test(text));
  if (!hit) return null;
  const kind = hit[1];
  // what it should say afterwards: the caller's own value where there is one, else the goal's words
  const secret = Object.entries(values).some(([k, v]) => /pass|pwd|pin|otp|token|card|secret/i.test(k) || /^(keychain|bw|env|autofill)[:.]/.test(String(v)));
  if (secret) return null;                                   // nothing readable to check against
  // "Choose Two in the dropdown" names the thing right after the verb, which the general phrase
  // reader passes over because it is one short word
  const named = text.match(/^\s*(?:please\s+)?(?:type|enter|fill in|fill|write|put|choose|select|pick|open|go to|navigate to|visit|tick|check|mark)\s+(?:the\s+|a\s+|an\s+)?['"“]?([^,.;'"”]{2,40}?)['"”]?(?:\s+(?:in|into|from|on|at|of|for)\b|[,.;]|$)/iu);
  // Every value the caller gave has to show up, not just one of them: a goal that fills five
  // fields is not finished because the first one took.
  const given = Object.values(values).map(String).filter(w => w.length >= 2);
  if (given.length) return { kind, wants: given, all: true };
  const wants = [...(named ? [named[1].trim()] : []), ...phrasesFrom(text)].filter(w => w.length >= 2);
  return wants.length ? { kind, wants: wants.slice(0, 6), all: false } : null;
}

const escaped = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A single word has to be a word where it is found: "tick" is not shown by "sticker". Anything
// longer is distinctive enough to match as it stands.
const holds = (text, want) => {
  const hay = String(text ?? "").toLowerCase(), needle = String(want).toLowerCase().trim();
  if (!hay || needle.length < 2) return false;
  if (/\s/.test(needle)) return hay.includes(needle);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped(needle)}([^\\p{L}\\p{N}]|$)`, "u").test(hay);
};

// Whether the page now shows what a plain goal asked for. true means finished, null means the page
// cannot say, and null is what keeps the question honest: only a clear yes skips it.
export function goalMet(plain, page, changed = null) {
  if (!plain) return null;
  const { kind, wants } = plain;
  const els = page.elements ?? [];
  if (kind === "type") {
    const shows = w => els.some(e => FIELDISH(e) && holds(e.value, w));
    return (plain.all ? wants.every(shows) : wants.some(shows)) ? true : null;
  }
  if (kind === "choose") {
    const chosen = els.some(e => wants.some(w => (SELECTISH(e) && holds(e.value, w))
      || (e.active === true && (holds(e.text, w) || holds(e.label, w)))
      || (e.checked === true && (holds(e.text, w) || holds(e.label, w)))));
    return chosen ? true : null;
  }
  if (kind === "tick") {
    const ticked = els.some(e => e.checked === true && wants.some(w => holds(e.label, w) || holds(e.text, w) || holds(e.near, w)));
    return ticked ? true : null;
  }
  // Something was made, so the page has to hold something it did not hold before. What was typed
  // showing up in a row that has just appeared is a record; the same words sitting in the box they
  // were typed into are not.
  if (kind === "create") {
    if (!changed) return null;
    const arrived = [...(changed.added ?? []), changed.new_text ?? ""].join(" | ");
    return wants.some(w => holds(arrived, w)) ? true : null;
  }
  // Opening something means the address moved to it. Without that, a goal naming the site it is
  // already on ("open the Wikipedia article about X") would be satisfied by the domain it started
  // from, on a page where nothing has happened yet.
  if (kind === "open") {
    if (!changed?.url) return null;
    const slug = w => String(w).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const [from] = String(changed.url).split(" -> ");
    const was = slug(from), now = slug(`${page.url} ${page.title}`);
    // what the address gained, not what it already had: the site's own name is in both
    return wants.some(w => slug(w).length >= 10 && now.includes(slug(w)) && !was.includes(slug(w))) ? true : null;
  }
  return null;
}

const MOST_REPEATS = 10;

// The names a page carries more than once, commonest first: the rows of a list, the buttons of a table.
export function repeatedElements(elements) {   // controls that come many times over, counted once
  const seen = new Map();
  for (const e of elements) seen.set(brief(e), (seen.get(brief(e)) ?? 0) + 1);
  const repeats = [...seen].filter(([, n]) => n > 1).sort(([, a], [, b]) => b - a).slice(0, MOST_REPEATS);
  return repeats.length ? Object.fromEntries(repeats) : undefined;
}

const NAMES_SHOWN = ["label", "text", "placeholder", "name"];
const FLAGS_SHOWN = ["checked", "filled", "editable", "disabled", "busy", "expanded", "active", "hidden", "covered"];
const OPTIONS_SHOWN = 8;

function elementLine(e) {
  const said = [];
  for (const key of NAMES_SHOWN) if (e[key]) said.push(key === "text" ? `"${e[key]}"` : `${key}="${e[key]}"`);
  if (e.value !== undefined && e.value !== "") said.push(`value="${e.value}"`);
  if (e.value_chars) said.push(`value_chars=${e.value_chars}`);
  if (e.options) said.push(`options=[${e.options.slice(0, OPTIONS_SHOWN).join(", ")}${e.options.length > OPTIONS_SHOWN ? ", …" : ""}]`);
  if (e.option_count !== undefined) said.push(`option_count=${e.option_count}`);
  for (const flag of FLAGS_SHOWN) if (e[flag] !== undefined) said.push(`${flag}=${e[flag]}`);
  if (e.sorted) said.push(`sorted=${e.sorted}`);
  if (e.href) said.push(`href=${e.href}`);
  if (e.near && !e.text) said.push(`near="${e.near}"`);
  if (e.frame) said.push(`frame=${e.frame}`);
  return `[${e.i}] ${e.tag} ${said.join(" ")}`;
}

// The page one element to a line, for a model taking over from Jev.
export function formatPage(page, { maxElements = 400 } = {}) {   // -> text
  const shown = page.elements.slice(0, maxElements);
  const rest = page.elements.length - shown.length;
  return [
    `url: ${page.url}`,
    `title: ${page.title}`,
    ...(page.dialogs?.length ? [`dialogs: ${page.dialogs.join(" || ")}`] : []),
    `visible text: ${page.text}`,
    `elements (${page.elements.length}):`,
    ...shown.map(elementLine),
    ...(rest > 0 ? [`… ${rest} more`] : []),
  ].join("\n");
}


// Shorten s to n characters, keeping its end as well as its start: long labels in one list often
// differ only at the end ("… Room 101", "… Room 102").
export function clipMiddle(s, n) {
  s = String(s ?? "");
  if (s.length <= n) return s;
  if (n < 6) return s.slice(0, n);
  const tail = Math.floor((n - 1) * 0.4);
  return s.slice(0, n - 1 - tail) + "…" + s.slice(s.length - tail);
}

// The longest length every label can keep so that all of them, joined by 3-character separators,
// fit in `chars`. Labels shorter than their share leave the rest to the others.
function labelRoom(lens, chars) {
  let room = chars - 3 * (lens.length - 1);
  const sorted = [...lens].sort((a, b) => a - b);
  for (let k = 0; k < sorted.length; k++) {
    const share = Math.floor(room / (sorted.length - k));
    if (sorted[k] > share) return share;
    room -= sorted[k];
  }
  return Infinity;
}

// One line of at most `chars` for a run of dropdown options ({ label, group? }), each label
// prefixed by its <optgroup> where that changes. Every option is listed while each can keep about
// 10 characters; below that, an even sample that always includes the first and the last, with "…"
// marking the gaps, which still shows the range a sorted list covers.
export function optionSummary(opts, chars) {
  const items = opts.map((o, k) => (o.group && o.group !== opts[k - 1]?.group ? `${clipMiddle(o.group, 20)}: ` : "") + o.label);
  let picked = items, sep = " | ";
  if (labelRoom(items.map(s => s.length), chars) < 10) {
    const m = Math.min(items.length, Math.max(2, Math.floor((chars + 3) / 16)));
    picked = [...new Set(Array.from({ length: m }, (_, j) => Math.round(j * (items.length - 1) / (m - 1))))].map(k => items[k]);
    sep = " … ";
  }
  const room = labelRoom(picked.map(s => s.length), chars);
  return picked.map(s => clipMiddle(s, room)).join(sep).slice(0, chars);
}

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };

// The whole numbers a goal mentions, as digits or words, in order.
export function numbersIn(text) {
  const out = [];
  for (const m of String(text).toLowerCase().matchAll(/\b(\d{1,4})\b|\b([a-z]+)\b/g)) {
    const n = m[1] != null ? +m[1] : NUMBER_WORDS[m[2]];
    if (n != null && !out.includes(n)) out.push(n);
  }
  return out;
}

const kindName = e => (e.label || e.text || e.placeholder || e.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
const LEAD_WORDS = 4;

// The kinds an element counts in: its tag with the name a person sees, and its tag with each run of
// the name's first words and "…" for the rest (`button "Delete …"` for "Delete Alice").
function kindsOfOne(e) {
  const name = kindName(e);
  if (!name) return [];
  const words = name.split(" "), leads = [];
  for (let n = 1; n < words.length && n <= LEAD_WORDS; n++) leads.push(`${e.tag} "${words.slice(0, n).join(" ")} …"`);
  return [`${e.tag} "${name}"`, ...leads];
}

// The kinds of element on a page and how many of each. A kind is the tag with the name a person
// sees, so the five "Delete" buttons of a list are one kind. A list whose buttons name their row
// ("Delete Alice", "Delete Bob") has a kind per row as well as one for all of them: names of one
// tag that start with the same words are also a kind, `button "Delete …"`, when two or more names
// share it. Of such kinds with the same names in them only the one with the most words is kept:
// two choices that mean the same would split Jev's answer between them. They come first, since on
// a long list the per-row kinds would push them out of a capped question.
export function kindsOf(elements) {
  const exact = new Map(), leads = new Map();
  for (const e of elements) {
    const [k, ...more] = kindsOfOne(e);
    if (!k) continue;
    exact.set(k, (exact.get(k) ?? 0) + 1);
    for (const l of more) {
      const x = leads.get(l) ?? { n: 0, names: new Set() };
      x.n++; x.names.add(k); leads.set(l, x);
    }
  }
  const kinds = new Map(), sameNames = new Map();
  for (const [l, x] of leads) {
    if (x.names.size < 2) continue;
    const id = [...x.names].sort().join("\n"), was = sameNames.get(id);
    if (!was || l.length > was.length) sameNames.set(id, l);
  }
  for (const l of sameNames.values()) kinds.set(l, leads.get(l).n);
  for (const [k, n] of exact) kinds.set(k, n);
  return kinds;
}

// How many elements of a kind from kindsOf() a page has, counted the same way when the kind would
// no longer be offered (one "Delete …" button left).
export function countKind(elements, kind) {
  let n = 0;
  for (const e of elements) if (kindsOfOne(e).includes(kind)) n++;
  return n;
}

// Whether a goal's number could be a count: counting words, or a number followed shortly by a
// plural ("3 Delete buttons", "two todos"). "Select Option 240" or "Choose Two" name a thing.
export function mayCount(goal) {
  const g = String(goal).toLowerCase(), num = `\\d+|${Object.keys(NUMBER_WORDS).join("|")}`;
  return /\b(exactly|at least|at most|no more than|fewer than|less than|more than|up to|until|in total|count)\b/.test(g)
    || new RegExp(`\\b(${num})\\s+(?:[a-z'-]+\\s+){0,2}?[a-z]{2,}s\\b`).test(g);
}
