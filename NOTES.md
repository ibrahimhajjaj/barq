# How barq is built, and why

Notes for whoever changes this code next, us included. Each section is a decision and what
pushed us to it.

## Two brains, one job each

The agent (Claude, or anything speaking MCP) is good at plans and bad at being cheap: every page
it reads costs thousands of tokens and seconds. Jev is the opposite: a decision model that answers
a batch of questions about one state in about 300 ms, but only by picking. It can't write, and it
can't hold a plan.

So the agent names one outcome per call and hands over every string. barq runs the loop: describe
the page, ask Jev several questions in one request (is it done, is it blocked, is an error showing,
is the next move irreversible, which tool, which element, which value), act, repeat. Anything Jev
is unsure about becomes a status the agent handles (`likely_done`, `ambiguous`, `stuck`), never a
guess passed off as success. "0 false done" is the number we protect above speed.

## Counting is code's job

"Add elements until there are exactly 3" defeated Jev: it judges one page at a time, and a page
with two or four of something looks about as finished as one with three. So when a goal reads like
a count (counting words, or a number followed by a plural), one question asks Jev whether it
really is one, of how many, and compared how (exactly, at least, at most; a total or that many
more). Each round Jev names which kind of element is being counted, choosing among the kinds on the
page; code counts them, tells Jev the progress, and decides "done" itself. Goals that only mention
a number ("Select Option 7") never pay for the question.

## When is a page ready?

The loop spends most of its time waiting, so "settled" has a precise meaning here:

- the document has finished loading;
- no document, fetch, xhr or script request that the last action started is still running (young
  ones only: a long-poll isn't loading), given up after about 3 s. A script from another site
  counts for a second at most: enough for code the page needs from its CDN, too short for a lazy
  ad or analytics script to hold the step;
- the DOM in every frame has been quiet for 150 ms, and at least 350 ms have passed since the
  action ended, for work a click schedules a moment later;
- no new tab that a click asked for is still on its way.

Pages that never stop moving (tickers, animations) get about 1.5 s of DOM watching, then we move
on. The page only reports changes while a settle is actually waiting, and at most every 50 ms, so
an animated page in your real browser isn't chattering at us all day. Before this, a busy page
could hold a step for 8 s; now it's well under a second on most.

## Describing a page

A script in every frame lists what a person could interact with: labels, state, and the visible
text. A few rules came from pages that broke earlier versions:

- **Frames are numbered by identity, not position.** If a frame goes away and a similar one takes
  its place, an old element number can't land in the wrong one.
- **`aria-hidden` isn't the same as hidden.** Some sites mark a whole form hidden from screen
  readers while their own dialog sits inside it, on screen. We keep such an element when a click at
  its centre would reach it.
- **Secret fields report `filled`, never their value.**
- **Long dropdowns go in two stages:** groups of options first (each summarised within a budget
  that keeps the request small), then the options of the likeliest two or three groups. The
  option is selected by index and label together, so a list that changed in between fails loudly
  instead of choosing the wrong thing.
- Pages over 240 elements get the same two-stage treatment.

## Working in the user's own browser

Attaching to a running Chrome or Edge is only acceptable if the user can't tell, except for the
group of tabs they can see. What that took:

- attach without the automation defaults (no forced colour scheme, focus emulation or downloads
  folder applied to the user's tabs), and listen only on our own tabs, so the user's own dialogs
  aren't answered for them;
- new tabs open in the background; a small helper extension groups them, keeps the user's tab in
  front, and pulls popups our tabs open into the group, working out their opener from the
  navigation rather than `openerTabId`, which names the user's tab for background tabs;
- groups are named after the project the agent works in, and each agent connection has its own;
- the helper updates itself: an older copy loaded unpacked is reloaded from disk.

**The Allow prompt.** A browser whose debugging was switched on from its inspect page asks the
user to allow every new connection. Chromium's source shows it's per WebSocket, with no way to
remember the answer. So a relay process holds the one approved connection and gives each client
its own browser-level session over it: one prompt per browser run. It listens on 127.0.0.1 behind
a random token in a file only the user can read, refuses anything with an `Origin` (web pages), and
won't pass on commands that close or crash the browser. Tabs that were open before a client connected are kept out
of its sight: it's never shown them, can't reach them by id, and so a tab the browser has put to
sleep (which answers nothing) can't hold up the client's start, as one sleeping Google Meet tab
once did for every new connection. It leaves after 30 idle minutes because
the browser shows its automation bar while connected.

## Secrets

Values are typed into the page but never shown to Jev, never returned, never traced. Anything
whose name looks secret, and every reference, reaches Jev as "(a secret value, hidden)"; the name
alone is enough to match a value to its field. References are resolved at the moment of typing:
`keychain:`, `bw:` (the Bitwarden CLI), `env:`.

`autofill` hands the field to the user's password manager. Bitwarden taught us three things:

1. Its menu lives in its own frame, with the rows in a closed shadow root that page scripts can't
   enter. The browser's DevTools protocol sees the whole tree, so we read each row's name and
   username there, and nothing else (a row can show a one-time code).
2. It fills its menu with the logins of the tab **in front**, not the tab the field is in. From a
   background tab it offered a Gmail login for a university portal. So the agent's tab is brought
   to the front of its window for the pick (without raising the window) and the user's tab handed
   back, and a menu whose rows' icons come from another site is refused.
3. A browser may have filled the form on load with a different account. When the agent names an
   account (`autofill:<name>`), that pick happens before anything submits the form.

## Stopping before the irreversible

Two independent checks, because each misses things the other catches: Jev's own "is this
irreversible" judgement, and a rule on the control's words (pay, place order, send, delete, in
English and Arabic, with exceptions like "add to cart"). The rule reads a control's label and
text, never a field's typed value; "buy milk" in a to-do field is not a purchase. Confirmation
dialogs that look destructive are dismissed and reported.

## Reading

`browser_read` with a question splits the page into passages under their headings, then asks Jev
which passage answers it, in batches with a "none of these" option. The agent gets a few
paragraphs instead of a page.

## A site's own tools

Chrome can expose tools a page registers (`document.modelContext.registerTool`, WebMCP) over the
DevTools protocol. When a site offers them, one call does what a series of clicks would, and
tools marked as changing things are held for confirmation like any other irreversible action.

## Replaying what worked

A step that ends `done` with every action successful is saved per goal and page. The same step on
the same page replays those actions without Jev, and the loop's next round looks at the result, so
a replay costs one Jev call and never claims "done" by itself. Anything that doesn't match (a
renamed button, a look-alike in a different row, a missing value, a checkbox already in the state
the step leaves it) hands back to the normal loop.

A recipe belongs to a page down to its query and fragment (tracking parameters aside), so what was
recorded for item A never replays on item B, and a link's destination and a frame's address must
still match.

A flow with a pay or delete step stops there for confirmation, as it would in the loop. The next
call for the same goal, with the same values on the same page, goes on from the action it stopped at, never from the start, and the whole
flow is recorded under the page it began on. If anything changed in between (another goal, other
values, the page, the caller acting by hand), it neither replays nor records.

The recipe file keeps no text from the user's pages: names, nearby text, addresses and the goal
are stored as 64-bit fingerprints, values are masked as their names before hashing, and replay
compares fingerprints taken the same way from the live page. A fingerprint can't be read back,
though a short common label could be guessed and confirmed; the file is readable only by its owner.

## Scanning without deciding

Some jobs have no decisions in them at all: a known list of URLs, the same extraction on each. A
Google Flights scan of about 1,600 pages in the user's own Edge showed the cost of doing those
through an agent: 12.7 s and about 2,800 model tokens a page, one tab at a time, against 3.4 s and
next to no tokens with a plain loop over barq's browser. `scan()` is that loop: a few background
tabs, random gaps between loads, one JSON line per page, a checkpoint a rerun resumes from, one more
try after an error, and a full stop at a captcha or "unusual traffic" page, because the right
answer there is a person, not a workaround. The MCP tool runs it in the background and hands back
counts and a sample, never the pages.

## What still breaks

- Judging many values at once (is this table sorted?). Jev reads a state; it doesn't compare a
  list. Those steps come back `likely_done` or `stuck`, never `done`.
- Ordered sub-goals in one call. Split them.
- Sites that serve nothing to automated browsers. Use your own browser.
- Captchas. By design, they come back `blocked`.
