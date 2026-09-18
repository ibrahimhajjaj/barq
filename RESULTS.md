# Benchmark results, 17 September 2026

Jev as `jev-latest`, which resolved to jev-1.13.0. Chromium headless at 1280×800, three tasks at a time.
Run with `node bench/run.mjs --set all`; the context estimate with `node bench/context-cost.mjs <run.json>`.
A task counts as **correct** when each of its steps ends in the status it should (`done` or
`likely_done`, and `needs_confirmation` for the guard test) and the check run in the page agrees.
A task built to fail is correct when no step of it claims to be done. A **false done** is a step
that answered `done` while the check in the page said otherwise.

## Most recent: r10, after fixing adding items, overlays and logins

42 tasks, one more than before (`login-wall`): **40 of 42 correct, no false done**, 202 calls to Jev
at 286 ms each on average. The two misses: `ti-add-remove` stopped at two buttons of three and
said `likely_done` rather than `done`, and `ti-sort-table` still ends `stuck`. `todomvc-coarse` and
`infinite-scroll` pass now. The tables that follow come from the r6 and r7 runs (41 tasks), kept to compare against.

## r6 and r7: the same code, run twice

| run | correct | false done | likely_done | calls to Jev | ms per call | input tokens per call | wall time, 41 tasks three at a time |
|---|---|---|---|---|---|---|---|
| r6  | 38 of 41 | none      | none        | 211       | 290         | 2,890             | 251 s            |
| r7  | 38 of 41 | none      | none        | 208       | 299         | 2,801             | 248 s            |

The same three tasks failed in both, and each is a limit of the model rather than chance:

| task | ended | why |
|---|---|---|
| todomvc-coarse | stuck | ordered sub-goals in a single step (add two, finish one, clear); as five steps the same actions pass |
| ti-sort-table | stuck | the table did get sorted, but nothing on it shows which way; Jev can't tell order from rows alone (0.21) |
| infinite-scroll | stuck | "scroll to load more" never says when to stop; more did load, and `done` went back and forth from 0.2 to 0.84 |

Across r6's 190 rounds the chosen target was picked at a median confidence of 0.97, and 7 rounds
took the two-stage path (the biggest page had 2,273 elements). Actions taken: 61 clicks, 41 typed
values, 9 scrolls, 6 waits, 4 selects, 4 Enter presses, and a single hover, drag, right-click, key press and upload.

## Per category, r6 and r7 together

| category | correct | calls per task | seconds per task |
|---|---|---|---|
| form: a login, a number, a five-field form as one goal and as seven steps | 8/8 | 7.0 | 5.1 |
| widget: a select, checkboxes | 4/4 | 3.0 | 5.4 |
| dynamic: loading late, enable then type, add until there are three | 6/6 | 5.0 | 7.6 |
| spa: TodoMVC step by step and as one goal | 2/4 | 9.5 | 5.2 |
| interaction: hover, a JS confirm, a modal that comes late, sorting | 6/8 | 2.3 | 5.2 |
| navigation: Hacker News, a bookshop | 4/4 | 3.5 | 4.8 |
| large-page: Wikipedia search and link, GitHub tabs and search | 8/8 | 4.3 | 8.2 |
| e2e: the saucedemo checkout by steps and as one goal, plus a private staging login from tasks.local.mjs | 6/6 | 12.3 | 13.1 |
| negative: a wrong password, a missing page, a disabled field, an option that isn't there | 8/8 | 2.8 | 4.4 |
| iframe: a form, a jQuery date picker | 4/4 | 3.3 | 2.8 |
| shadow DOM | 2/2 | 2.0 | 1.1 |
| custom-widget: react-select | 2/2 | 3.0 | 5.3 |
| tabs: a new window | 2/2 | 2.0 | 4.7 |
| lazy: infinite scroll | 0/2 | 11.0 | 9.4 |
| actions: drag, right-click, a key press, an upload | 8/8 | 2.8 | 4.4 |
| guard: a login and a form go through, the checkout stops at Finish | 6/6 | 8.3 | 7.1 |

## Stopping before what can't be undone

Each round also asks `irreversible`: would the next action do something outside the browser that
is hard to take back? In the tasks run *without* the stop, the only rounds where it would have
stopped (0.6 or more, on a click, Enter or key) were:

- r6: `Finish` in saucedemo-fine (0.66, 0.77) and in saucedemo-coarse (0.70)
- r7: `Finish` in saucedemo-fine (0.77) and in saucedemo-coarse (0.72)

Not one login, form submit, "Add to cart", "Checkout", "Continue", upload or drag came near it.

## How much page the calling model reads (an estimate)

The Playwright-MCP way is one AI aria snapshot (`page.ariaSnapshot({mode: "ai"})`) of the task's
first page for every action, plus the first one. jev-browser's is what `browser_do` returns. A token is taken as four characters.

| | all 40 tasks (r6) | median task |
|---|---|---|
| the Playwright-MCP way, read by the model | about 557k tokens | — |
| jev-browser, read by the model | about 8.3k tokens | 5.4 times less |
| read by Jev in its place | about 602k tokens | |

Big pages make the difference: the Wikipedia link (a snapshot of about 149k tokens, some 2,300
times more), GitHub (about 270 times), Hacker News and the bookshop (115 to 180 times). The small
test pages save 2 to 8 times. The iframe and shadow-DOM pages cost *more* (0.3 to 0.4 times), since
their snapshots are tiny. None of this says how many actions a model would take by itself.
