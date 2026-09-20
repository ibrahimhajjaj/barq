# Results

How barq does on its benchmark, and where it falls short. The raw run files are in
`bench/results/`, so every number here can be checked.

## The benchmark

41 tasks on live public sites, in 16 categories: forms, native and custom widgets, dynamic
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

A task or two moves between runs of the same code: live sites and the model's scores near a
threshold both vary. Read one run's 38 against another's 39 as noise, not progress.

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
  claimed a false `done`.

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
