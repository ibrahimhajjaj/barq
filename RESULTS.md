# Results

How barq does on its benchmark, and where it falls short. The raw run files are in
`bench/results/`, so every number here can be checked.

## The benchmark

43 tasks, in 16 categories, nearly all on live public sites: forms, native and custom widgets, dynamic
loading, single-page apps, drag and drop, hover and key presses, navigation, pages with 2,000+
elements, a full checkout, iframes, shadow DOM, new tabs, lazy loading, and three guard tests
that must stop before an irreversible action. Five tasks are built to be impossible, and the
right answer there is to not claim success.

Each step's goal is written the way a planning model would write it. After every step a check
runs in the page and decides what really happened, whatever barq says.

- **correct**: every step returned the status it should, and the page check agrees.
- **false done**: a step said `done` and the page check says otherwise. This is the number we
  refuse to trade for speed.

Run it: `node bench/run.mjs --set base,hard,guard --out bench/results/<name>.json` (needs network
and a TypeSafe key, about 4 minutes, three tasks at a time in a headless Chromium at 1280×800).

## Latest runs

Everything in (counting in code, recipes with resume and fingerprints, token sizing, the cap on
other sites' scripts, scan mode), after the source rewrite:

- **41/41 correct, 0 false done**
- median 4.64 s per task, 208.2 s for all 41 run three at a time
- 203 Jev calls, 379 ms each on average

The median is up from 3.93 s earlier on. About 0.1 s a task is the 350 ms watch after each action,
which stopped us missing changes a click starts a moment later; counting goals add a question; the
rest is Jev's own latency on the day and a busier machine.

The questions in `src/session.mjs` are prompt text, and the thresholds around them were tuned
against it. Rewording them is not cosmetic: a softer "which of the values should this use?" had Jev
answer `password` for a username field, and a softer "is this hard to undo?" scored a checkout's
Finish button at 0.56 instead of 0.7, which is the difference between stopping and placing an
order. Any change to that wording needs a run of this benchmark behind it.

## How it moved

The runs below are the same 41 tasks at points along the way. Times are per task, including
waiting for pages; Jev's own share is 300 to 400 ms a call.

| run | correct | false done | median per task | all tasks | Jev calls | ms per call |
|---|---|---|---|---|---|---|
| the starting point | 39/41 | 0 | 4.85 s | 226.3 s | 197 | 384 |
| faster settle, page-scoped attach | 38/41 | 0 | 3.93 s | 198.5 s | 200 | 336 |
| settle and dropdown review fixes, run 1 | 38/41 | 0 | 3.95 s | 199.0 s | 188 | 342 |
| settle and dropdown review fixes, run 2 | 39/41 | 0 | 4.11 s | 215.6 s | 197 | 375 |
| recipes and token sizing | 40/41 | 0 | 4.45 s | 219.3 s | 196 | 364 |
| counting in code, recipe resume, fingerprints | **41/41** | 0 | 4.63 s | 222.8 s | 202 | 354 |
| after the review fixes, with scan mode | 40/41 | 0 | 4.74 s | 227.9 s | 203 | 356 |
| after the source rewrite | **41/41** | 0 | 4.64 s | 208.2 s | 203 | 379 |
| hidden frames dropped, checks split in two | 38/41 | 0 | 4.51 s | 199.4 s | 191 | 353 |
| diagnosable timeouts, passages keep their section | 40/41 | 0 | 4.58 s | 203.6 s | 200 | 329 |
| the goal's own words as typing, one question per page | **41/41** | 0 | 4.68 s | 203.2 s | 194 | 349 |
| the page answers for a plain goal, question during settle | **41/41** | 0 | 4.17 s | 184.1 s | 186 | 334 |
| dropdown options and one-prompt tasks (43 tasks) | **43/43** | 0 | 4.65 s | 225.0 s | 199 | 368 |
| a finished step is not stuck (51 tasks, see below) | **51/51** | 0 | 4.22 s | 237.3 s | 219 | 365 |
| list fields, calendars, a stricter finish (53 tasks) | **53/53** | 0 | 4.23 s | 285.9 s | 258 | 349 |

The last row is a wider set: `npm run bench` also picks up `bench/tasks.local.mjs`, seven live-site
tasks kept out of the published set (a Wikipedia article in Arabic, two GitHub navigations, an MDN
page, two pages of a product's own site, a plugin directory search). Against the 43 tasks the row
above it shares, two statuses moved and nothing else: `drag` from `likely_done` to `done` in the
same four calls, and `ti-sort-table` from `done` to `likely_done` in one call fewer. It is the run
behind two changes to the loop: a round where Jev has nothing left to do, after the step has
already acted, now answers `likely_done` rather than `stuck`, and the stricter question asked
before either stopped asking whether the page has nothing left to offer and started asking whether
what the goal asked for has happened. The first was found by another session driving a shop: "add
both X and Y to the cart" came back `stuck` three times out of three with both items in the cart.

The 53-task row adds two Google Flights tasks to the local set, one goal in a single sentence
and the same trip as five steps. Both failed before it: a city typed into a field that only takes a
value picked from its suggestions was thrown away when the focus moved on, the calendar listed every
month's 20th as "20", its date only reached the form through the calendar's own Done button, and a
Search pressed while a typed date was still unconfirmed was swallowed. Worse, the one-sentence goal
came back `done` three times out of four without searching, on a "done" score of 0.74 to 0.78.
Now a suggestion that starts with the typed text is picked inside the typing, calendar days carry
their date, a picker's Done is pressed before the step ends on it, and a soft "done" with nothing
left to do meets the stricter question up to 0.85 rather than 0.75. That last change costs
decisiveness elsewhere: `react-select`, `ti-dynamic-controls`, `ti-entry-ad` and `todomvc-fine`
now end `likely_done` rather than `done`, still correct. Their scores (0.76 to 0.82) overlap the
Flights false finish, so no line between the two exists, and a false `done` is the one number here
we don't trade.

A task or two moves between runs of the same code: live sites and the model's scores near a
threshold both vary. Read one run's 38 against another's 39 as noise, not progress. In the last run
all three misses passed on their own straight afterwards, `webform-fine` three times out of three,
which is what running three tasks at once does to a slow page.

## Against the other Jev browser agents

Run on browser-use/jev-ultrafast's own published tasks, with their goal strings, their clock (from
the first decision to done, initial navigation outside the timer) and their local fixture:

- Their Wikipedia task: **3.42 s** here against **2.798 s** there, three runs, all correct.
- Their hotel fixture: **4.21 s** here against **1.896 s** there, three runs, all correct.
- Their Google Flights task, with their goal and their independent checker (route, one-way, date,
  and every listed flight on that date), date moved from 20 September to 20 October 2026 since
  theirs had passed: **24 runs here, 23 passed**, median about **10.2 s**, 14 to 18 Jev calls, and
  no text model. Theirs: **6 of 6** in their published runs (three per arm), median **7.092 s**, 17
  Jev calls plus two calls to a text model that writes the city names. The one miss here ended
  `ambiguous` before the date was set, not `done`. Their Jev answers come back in 178 ms, ours in
  about 350 ms from where we measure, which over 14 to 16 calls is most of the difference.

All three are run from one prompt with nothing supplied: the text to type is chosen out of the goal
itself, since the decision model cannot write but can pick.

Two tasks were added to the benchmark out of this comparison, because both are shapes that produced
a wrong answer here before they were fixed: `wiki-search-open`, a goal that names what it wants but
not where to type it, on a site whose own domain carries one of the goal's words; and
`stays-filter`, one prompt with four things to do and a results list that arrives late.

They are faster on a single one-shot task, and their per-decision time is about half ours because
they send a smaller state. Three things account for most of the difference, and all three are
deliberate: a final round that verifies rather than assumes, a watch after every action for work a
page starts late, and a richer page model. What is on the other side of that trade is this file: 41
tasks on live sites with the truth asserted inside the page, no false "done" in any published run,
and a recorded run that replays without the model at all.

Their published speed evidence is three alternating pairs of one task, which their own performance
note calls too few for a statistical claim, plus two single smoke runs. They publish no accuracy
benchmark.

## Weak spots

Every task passed in the latest run, but these are the ones that have failed before, and why:

- **`ti-add-remove`** ("add elements until there are exactly 3 Delete buttons") failed in every run
  until counting moved into code: Jev judges one page at a time and can't keep count. Now Jev names
  what to count and code counts; it's been `done` since.
- **`ti-sort-table`** ("sort by last name, ascending"). Knowing a table is sorted means comparing
  every row; Jev reads a state, it doesn't compare a list. The click that sorts is easy, the proof
  isn't: it comes back `likely_done` or `stuck`, never `done`.
- **`ti-entry-ad`**: a modal that appears after a random delay, sometimes after the step already
  finished. Flaky by design of the page.
- **`todomvc-coarse`** and **`webform-fine`** fail now and then on a "done" score sitting right at
  the threshold (0.33 against 0.35). Both return a status the caller can act on; neither has ever
  claimed a false `done`. A score under that threshold no longer ends the step on its own: the
  stricter question is asked first, and a step that has acted and has nothing left to do comes back
  `likely_done` for the caller to verify.

## Guard tests

All three pass in every run: the step stops with `needs_confirmation` before placing an order,
and the order is never placed. Two checks decide that together: Jev's own judgement that the next
move can't be undone, and a rule on the control's own words (pay, place order, send, delete,
in English and Arabic, with "add to cart" and friends allowed through).

## Real tasks

We also keep a set of everyday tasks: our own sites, and a few busy public ones (GitHub, the
WordPress plugin directory, Arabic Wikipedia, MDN, Hacker News). That set stays out of the repo,
since it points at our own pages. The first run found a real bug: Arabic text costs about
three times more tokens per character than English, and a page-size cap counted characters, so
Arabic Wikipedia's results page overflowed Jev's request limit. Sizes are estimated in tokens now,
and a refused request is retried at half the size.

Latest run of that set: 8/8 correct, 0 false done, 29 Jev calls at 425 ms each.
