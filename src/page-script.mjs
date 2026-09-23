// Runs in every frame of the page. It numbers each control in document order through data-jev-i
// and gives back what someone looking at it would see: names, state, the text on screen, open dialogs, sizes.
// Playwright sends it into the page as source, so it can't reach for anything outside itself.
export const ENUMERATE = ({ start, frame }) => {   // start: the first number to give; frame: which frame this is
  const INTERACTIVE = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=menuitem]", "[role=menuitemcheckbox]", "[role=tab]",
    "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=option]", "[role=combobox]",
    "[role=textbox]", "[role=searchbox]", "[role=slider]",
    '[contenteditable=""]', "[contenteditable=true]",
    "[onclick]", "[oncontextmenu]", "[ondblclick]", "[draggable=true]",
    '[tabindex]:not([tabindex="-1"])',
  ].join(", ");
  const TICKABLE = ["checkbox", "radio"];
  const ROW_STATE = /\b(completed|done|selected|active|checked|disabled|error|expanded)\b/i;
  // How much of a field's contents travels with the page model.
  const VALUE_SHOWN = 120;
  const SECRET_WORDS = ["pass", "passwd", "password", "pin", "otp", "cvv", "cvc", "csc", "cardnumber", "ccnumber"];

  // cut to length without leaving half an emoji at the end
  const tidy = (s, max = 80) => (s || "").replace(/\s+/g, " ").trim().slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
  const classOf = el => String(el.className?.baseVal ?? el.className ?? "");
  const middleOf = el => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const inViewport = (x, y) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;

  const isVisible = el => {
    const r = el.getBoundingClientRect();   // its box on screen
    if (Math.min(r.width, r.height) < 1) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    // transparent checkboxes, radios and file inputs are usually styled replacements that still take clicks
    return +style.opacity > 0.05 || /^(checkbox|radio|file)$/.test(el.type);
  };

  // Would a click at the middle of the element land on the element itself?
  const reachable = el => {
    const [x, y] = middleOf(el);
    if (!inViewport(x, y)) return false;
    const onTop = el.getRootNode().elementFromPoint?.(x, y);
    return !!onTop && (onTop === el || el.contains(onTop));
  };

  // Anything with a pointer cursor its parent doesn't have is usually a JS-bound control: a div,
  // a span or a table header someone hung a click handler on.
  const behavesClickable = (el, tag) => {
    if (["html", "body", "label", "svg", "path"].includes(tag) || !el.parentElement) return false;
    return getComputedStyle(el).cursor === "pointer"
      && getComputedStyle(el.parentElement).cursor !== "pointer"
      && !el.closest("a, button, [role=button]");
  };

  // Table headers are usually sortable, and a sizeable image is a hover target or a link's content.
  const looksActionable = (el, tag) => {
    if (tag === "th") return !!el.closest("thead");
    if (tag !== "img" || el.closest("a, button")) return false;
    const r = el.getBoundingClientRect();   // its box on screen
    return r.width >= 24 && r.height >= 24;
  };

  const offered = (el, tag) => {
    if (!(el.matches(INTERACTIVE) || behavesClickable(el, tag) || looksActionable(el, tag))) return false;
    if (el.closest("[inert], [data-jev-overlay]")) return false;
    // aria-hidden content is usually hidden from sight as well, but a site can also put it on
    // content that is plainly on screen (a whole form, including the dialog it opened). Keep such
    // an element only when a click at its centre would reach it.
    return !el.closest('[aria-hidden="true"]') || reachable(el);
  };

  const visibleLabel = el => [...(el.labels || [])].find(isVisible);

  // A styled tick box often cannot take the click itself: the real input sits at opacity:0 under
  // its own label, or under the one-pixel clip-rect "visually hidden" recipe with the swatch
  // painted on top. In both cases the label is the control.
  const tickTakesTheClick = el => {
    const style = getComputedStyle(el), r = el.getBoundingClientRect();
    const [x, y] = middleOf(el);
    const onTop = inViewport(x, y) ? document.elementFromPoint(x, y) : null;
    const blocked = +style.opacity <= 0.05 || r.width <= 2 || r.height <= 2
      || style.clip !== "auto" || style.clipPath !== "none"
      || (onTop && onTop !== el && [...(el.labels || [])].some(l => l === onTop || l.contains(onTop)));
    return !blocked;
  };

  // Where a click should go, or null when the element is no use to anyone. `hidden` marks a file
  // input that is display:none behind a styled button and still accepts files.
  const clickTarget = (el, type) => {
    if (!isVisible(el)) {
      const label = TICKABLE.includes(type) ? visibleLabel(el) : null;
      if (label) return { hit: label, hidden: false };
      return type === "file" ? { hit: el, hidden: true } : null;
    }
    if (TICKABLE.includes(type) && !tickTakesTheClick(el)) return { hit: visibleLabel(el) ?? el, hidden: false };
    return { hit: el, hidden: false };
  };

  const textOfIds = ids => tidy((ids || "").split(/\s+/).map(id => document.getElementById(id)?.innerText).filter(Boolean).join(" "));
  const labelOf = el => tidy(textOfIds(el.getAttribute("aria-labelledby"))
    || [...(el.labels || [])].map(l => l.innerText).join(" ")
    || el.getAttribute("aria-label")
    || "");

  // Text sitting right after the element, up to the next control: "<input> Remember me".
  const textAfter = el => {
    let text = "";
    for (let node = el.nextSibling; node && text.trim().length < 40; node = node.nextSibling) {
      if (node.nodeType === 1 && node.matches("input, select, textarea, button, br, label, div, p, li")) break;
      text += node.textContent;
    }
    return tidy(text, 60);
  };

  // What is typed into a password, one-time-code or card field never leaves the page: only whether
  // anything is in it.
  const isSecret = (el, type) => type === "password"
    || /password|one-time-code|cc-(number|csc|exp)/.test(el.getAttribute("autocomplete") || "")
    || `${el.name || ""} ${el.id || ""}`.toLowerCase().split(/[^a-z0-9]+/).some(word => SECRET_WORDS.includes(word));

  const describeField = (el, o, { tag, type, hit }) => {
    // a contenteditable often carries no role at all, and an empty one has no value to go by, so
    // say plainly that text can be typed into it
    if (el.isContentEditable) o.editable = true;
    const label = labelOf(el);
    if (label) o.label = label;
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) o.placeholder = tidy(placeholder, 60);
    if (!label && !placeholder && el.name) o.name = el.name;

    if (tag === "select") {
      o.value = tidy(el.selectedOptions?.[0]?.label, 40);
      o.options = [...el.options].slice(0, 25).map(option => tidy(option.label, 30));
      o.option_count = el.options.length;
    } else if (TICKABLE.includes(type)) {
      o.checked = el.checked;
      if (!o.label && hit !== el) o.label = tidy(hit.innerText);
      if (!o.label) { const after = textAfter(el); if (after) o.label = after; }
      if (el.value && el.value !== "on") o.value = tidy(el.value, 30);
    } else if (["submit", "button", "reset"].includes(type)) {
      o.text = tidy(el.value || label);
    } else {
      const typed = el.isContentEditable && tag !== "input" ? el.innerText : el.value;
      if (isSecret(el, type)) { if (typed) o.filled = true; }
      else if (typed) {
        o.value = tidy(typed, VALUE_SHOWN);
        // a field holding an essay is a different thing from one holding a word, and the first
        // sentence alone doesn't say which: say how much is in there when it doesn't all fit
        if (typed.length > VALUE_SHOWN) o.value_chars = typed.length;
      }
    }

    const listId = el.getAttribute("list");
    if (listId) o.suggestions = [...(document.getElementById(listId)?.options || [])].slice(0, 10).map(option => option.value);
  };

  const describeControl = (el, o, tag) => {
    const inner = el.querySelector("img[alt], svg title");
    const text = (tag === "img" ? tidy(el.getAttribute("alt")) : tidy(el.innerText))
      || labelOf(el)
      || tidy(el.getAttribute("title"))
      || tidy(inner?.getAttribute?.("alt") || inner?.textContent);
    if (text) o.text = text;
    let label = labelOf(el);
    // A calendar day shows a bare number and keeps the full date on something inside it. Without
    // that date every month's 20th reads the same, so a short text takes the name of the one thing
    // inside that is named with it.
    if (!label && text && text.length <= 3) {
      const named = [...el.querySelectorAll("[aria-label]")].map(e => e.getAttribute("aria-label"));
      const word = new RegExp(`(^|\\W)${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`);
      if (named.length === 1 && word.test(named[0])) label = tidy(named[0]);
    }
    if (label && label !== text) o.label = label;
  };

  // A custom element's attributes and classes mean whatever its app decided; aria-pressed and the
  // rest are standard. So a class is only read as "this one is selected" on the ordinary controls
  // that use it that way, never on a component of the site's own making.
  const SELECTABLE_TAGS = ["a", "button", "li", "summary", "td", "th"];
  const SELECTABLE_ROLES = ["tab", "menuitem", "menuitemradio", "option", "link", "button", "treeitem", "radio"];

  const describeState = (el, o, { tag, role }) => {
    const href = el.getAttribute("href") ?? "";
    if (href && !/^javascript/.test(href)) {
      try {
        const url = new URL(href, location.href);
        o.href = tidy(url.origin === location.origin ? url.pathname + url.search + url.hash : url.href, 80);
      } catch { o.href = tidy(href, 80); }
    }
    if (el.getAttribute("aria-disabled") === "true" || el.disabled) o.disabled = true;
    if (["true"].includes(el.getAttribute("aria-busy"))) o.busy = true;

    const sort = el.getAttribute("aria-sort") || classOf(el).match(/sort\w*?(asc|desc|up|down)/i)?.[1];
    if (sort && sort !== "none") o.sorted = /asc|up/i.test(sort) ? "ascending" : /desc|down/i.test(sort) ? "descending" : sort;
    if (el.getAttribute("aria-expanded") !== null) o.expanded = el.getAttribute("aria-expanded") === "true";
    if (el.getAttribute("aria-checked")) o.checked = ["true"].includes(el.getAttribute("aria-checked"));
    // A toggle that says it is off has to say so: with the flag left out, "off" and "this control
    // has no such state" look the same, and a question about the off one gets answered yes.
    const pressed = el.getAttribute("aria-pressed") ?? el.getAttribute("aria-selected");
    const namedByClass = !tag.includes("-") && (SELECTABLE_TAGS.includes(tag) || SELECTABLE_ROLES.includes(role))
      && /\b(selected|active)\b/.test(classOf(el));
    if (pressed === "true" || pressed === "false") o.active = pressed === "true";
    else if (el.getAttribute("aria-current") || namedByClass) o.active = true;
  };

  // Icon-only, generically named and field controls only make sense with the text around them.
  const describeSurroundings = (hit, o, own) => {
    let parent = hit.parentElement;
    for (let up = 0; parent && up < 5; up++, parent = parent.parentElement) {
      const around = tidy(parent.innerText, 400);
      if (around && around !== own) { if (around.length <= 100) o.near = around; break; }
    }
    const row = hit.closest("tr, li, [role=row], [role=listitem]");
    const state = row?.className && ROW_STATE.exec(String(row.className.baseVal ?? row.className));
    if (state) o.row_state = state[1];
  };

  // Something else (a modal, an overlay, a cookie banner) is painted over the element's middle.
  const isCovered = (hit, el) => {
    const [x, y] = middleOf(hit);
    if (!inViewport(x, y)) return false;
    const root = hit.getRootNode()?.elementFromPoint ? hit.getRootNode() : document;
    const onTop = root.elementFromPoint(x, y);
    if (!onTop || onTop === hit || hit.contains(onTop) || onTop.contains(hit)) return false;
    return !(onTop.tagName === "LABEL" && onTop.control === el);
  };

  const openDialogs = () => {
    const said = [...document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal="true"]')]
      .filter(isVisible).map(d => tidy(d.innerText, 400)).filter(Boolean);
    // overlays nobody marked up as a dialog: a fixed layer covering most of the viewport at its middle
    for (let node = document.elementFromPoint(innerWidth / 2, innerHeight / 2); node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node), r = node.getBoundingClientRect();
      if (style.position !== "fixed" && style.position !== "sticky") continue;
      if (r.width * r.height < 0.6 * innerWidth * innerHeight) continue;
      const text = tidy(node.innerText, 400);
      if (text && !said.includes(text)) said.push(text);
      break;
    }
    return said;
  };

  // The text a person can see right now, in DOM order.
  const textOnScreen = () => {
    if (!document.body) return "";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let text = "";
    for (let node = walker.nextNode(); node && text.length < 2500; node = walker.nextNode()) {
      if (!node.textContent.trim() || !node.parentElement) continue;
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(node.parentElement.tagName)) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.width === 0) continue;
      text += " " + node.textContent;
    }
    return tidy(text, 2500);
  };

  const everything = [];
  const walk = root => { for (const el of root.querySelectorAll("*")) { everything.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  for (const el of everything) el.removeAttribute("data-jev-i");

  const elements = [];
  const taken = new Set();
  let next = start;
  // The heading a control sits under. Everything is walked in document order, so the last heading
  // passed is the one it belongs to: the rules under "r/mcp Rules" are named after themselves, and
  // only this says which rules they are.
  let heading = "";
  for (const el of everything) {
    const tag = el.localName;
    if ((/^h[1-6]$/.test(tag) || el.getAttribute("role") === "heading") && isVisible(el)) heading = tidy(el.innerText, 60) || heading;
    if (!offered(el, tag)) continue;

    const type = tag !== "input" ? null : (el.getAttribute("type") || "text").toLowerCase();
    const target = clickTarget(el, type);
    if (!target || taken.has(target.hit)) continue;
    const { hit, hidden } = target;
    taken.add(hit);

    const role = el.getAttribute("role");   // what ARIA says it is, if anything
    const o = { i: next };
    o.tag = type ? `input:${type}` : role && !["a", "button", "select", "textarea"].includes(tag) ? `${tag}[${role}]` : tag;
    if (frame) o.frame = frame;
    if (hidden) o.hidden = true;

    const isField = el.isContentEditable || ["input", "select", "textarea"].includes(tag) || ["textbox", "searchbox", "combobox"].includes(role);
    if (isField) describeField(el, o, { tag, type, hit });
    else describeControl(el, o, tag);
    describeState(el, o, { tag, role });

    const own = [o.text, o.label, o.placeholder].find(Boolean) ?? "";
    if (own.length < 16 || isField) describeSurroundings(hit, o, own);
    if (!hidden && isCovered(hit, el)) o.covered = true;

    if (heading) o.section = heading;
    hit.setAttribute("data-jev-i", String(next));
    elements.push(o);
    next++;
  }

  const wholePage = document.body?.innerText ?? "";
  return {
    url: location.href,
    title: document.title,
    text: textOnScreen(),
    metrics: {
      scroll_y: Math.round(scrollY),
      page_height: document.documentElement.scrollHeight,
      // whether scrolling would reveal anything: offering the action when it would not is how a
      // step ends up scrolling at the bottom of a page over and over
      at_bottom: scrollY + innerHeight >= document.documentElement.scrollHeight - 2,
      text_length: wholePage.length,
    },
    dialogs: openDialogs(),
    elements,
    next,
  };
};
