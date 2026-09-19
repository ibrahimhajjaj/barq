// Reading a page instead of acting on it. The whole page (not just what is on screen) becomes a
// list of text blocks. read() either returns them as text, a page at a time, or cuts them into
// passages and lets Jev pick the passages that answer a question, so the caller reads a few
// hundred words instead of the page.

// Runs in each frame. Text nodes are grouped by their nearest block-level ancestor, so pages built
// from nested divs read the same as ones built from paragraphs. Table cells of one row join up.
export const READ_BLOCKS = () => {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "SELECT", "OPTION"]);
  const BLOCK = /^(block|list-item|table|table-row|table-cell|table-caption|flex|grid|flow-root|inline-block)$/;
  const display = new Map();
  const shown = new Map();
  const disp = e => { let d = display.get(e); if (d === undefined) display.set(e, d = getComputedStyle(e).display); return d; };
  const visible = e => {
    let v = shown.get(e);
    if (v === undefined) { const st = getComputedStyle(e); v = st.visibility !== "hidden" && st.display !== "none" && e.getClientRects().length > 0; shown.set(e, v); }
    return v;
  };
  const blockOf = el => { for (let e = el; e && e !== document.body; e = e.parentElement) if (BLOCK.test(disp(e))) return e; return document.body; };
  const region = el => el.closest("nav, [role=navigation]") ? "nav" : el.closest("footer, [role=contentinfo]") ? "footer"
    : el.closest("aside, [role=complementary]") ? "aside" : el.closest("header, [role=banner]") ? "header" : "main";
  const kind = el => {
    const h = el.closest("h1, h2, h3, h4, h5, h6, [role=heading]");
    if (h) return `h${+(h.getAttribute("aria-level") || h.tagName[1]) || 2}`;
    if (el.closest("li, [role=listitem]")) return "li";
    if (el.closest("td, th, [role=cell], [role=gridcell], [role=columnheader]")) return "cell";
    if (el.closest("pre")) return "pre";
    return "p";
  };
  const out = [];
  let last = null;
  if (!document.body) return out;
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: n => {
      if (!n.textContent.trim()) return NodeFilter.FILTER_SKIP;
      for (let e = n.parentElement; e; e = e.parentElement) if (SKIP.has(e.tagName) || e.getAttribute("aria-hidden") === "true") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const blk = blockOf(n.parentElement);
    if (!visible(blk) || !visible(n.parentElement)) continue;
    // from the text's own element: an inline <h2> inside a styled div is still a heading
    const k = kind(n.parentElement);
    const row = k === "cell" ? n.parentElement.closest("tr, [role=row]") : null;
    const key = row ?? blk;
    const text = n.textContent.replace(/\s+/g, " ");
    if (last && last.key === key) {
      last.text += (row && last.cell !== blk ? " | " : "") + text;
      last.cell = blk;
      continue;
    }
    last = { key, cell: blk, kind: row ? "row" : k, region: region(blk), text };
    out.push(last);
  }
  return out.map(({ kind, region, text }) => ({ kind, region, text: text.replace(/\s+/g, " ").trim() })).filter(b => b.text);
};

// Blocks of every frame, main frame first.
export async function readBlocks(page) {
  const blocks = [];
  for (const f of page.frames()) {
    if (f.isDetached()) continue;
    const got = await f.evaluate(READ_BLOCKS).catch(() => []);
    blocks.push(...(f === page.mainFrame() ? got : got.map(b => ({ ...b, region: "frame" }))));
  }
  return blocks;
}

export function toText(blocks, { regions } = {}) {
  const keep = regions ? blocks.filter(b => regions.includes(b.region)) : blocks;
  return keep.map(b => b.kind[0] === "h" && b.kind.length === 2 ? `${"#".repeat(+b.kind[1])} ${b.text}`
    : b.kind === "li" ? `- ${b.text}` : b.kind === "row" ? `| ${b.text} |` : b.text).join("\n");
}

// Passages of about `size` characters that never cross a heading; each remembers the heading it
// sits under so a passage makes sense on its own.
export function passages(blocks, { size = 600 } = {}) {
  const out = [];
  let heading = "", cur = null;
  const flush = () => { if (cur?.text) out.push(cur); cur = null; };
  for (const b of blocks) {
    if (/^h\d$/.test(b.kind)) { flush(); heading = b.text.slice(0, 120); continue; }
    const line = b.kind === "li" ? `- ${b.text}` : b.kind === "row" ? `| ${b.text} |` : b.text;
    if (cur && cur.text.length + line.length > size) flush();
    cur ??= { heading, region: b.region, text: "" };
    cur.text += (cur.text ? "\n" : "") + line.slice(0, size * 2);
  }
  flush();
  return out.map((p, i) => ({ i, ...p }));
}

// Split passages into requests that fit Jev: at most 240 options and about 60k characters of state.
export function batches(list, { maxOptions = 240, maxChars = 60_000 } = {}) {
  const out = [];
  let cur = [], chars = 0;
  for (const p of list) {
    const n = p.text.length + p.heading.length + 40;
    if (cur.length && (cur.length >= maxOptions || chars + n > maxChars)) { out.push(cur); cur = []; chars = 0; }
    cur.push(p); chars += n;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// Which passages answer `question`? One Choice per batch, all batches at once, each with a
// "none of these" option so a batch without the answer doesn't push its best guess forward.
// Returns passages ranked by probability, and how likely it is the page answers at all.
export async function findPassages(question, list, call, { top = 5, floor = 0.03 } = {}) {
  const groups = batches(list);
  const answers = await Promise.all(groups.map(g => call(
    { question, passages: g.map(p => ({ i: p.i, heading: p.heading || undefined, text: p.text })) },
    { best: { type: "choice", instructions: "Which entry of `passages` (by its `i`) answers `question` best? Choose `none` if no passage answers it.", criteria: { ...Object.fromEntries(g.map(p => [String(p.i), null])), none: "No passage here answers the question" } } },
  )));
  const scored = [];
  let pNone = 1;
  for (const { answers: a } of answers) {
    const probs = a.best.probabilities;
    pNone = Math.min(pNone, probs.none ?? 0);
    for (const [k, p] of Object.entries(probs)) if (k !== "none") scored.push({ i: +k, p });
  }
  scored.sort((x, y) => y.p - x.p);
  const picked = [];
  let mass = 0;
  for (const s of scored) {
    if (picked.length >= top || s.p < floor || (picked.length && mass >= 0.9)) break;
    picked.push(s); mass += s.p;
  }
  const byI = new Map(list.map(p => [p.i, p]));
  return { answered: +(1 - pNone).toFixed(3), passages: picked.map(s => ({ ...byI.get(s.i), p: +s.p.toFixed(3) })), requests: groups.length };
}
