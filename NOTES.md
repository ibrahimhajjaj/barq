# jev-browser: design notes

Work began on 16 September 2026 in Jev-playground and came to this repo on the 17th. `src/session.mjs` runs a
real browser: the page is read in code, Jev makes each small choice, and Playwright carries it out.
An LLM such as Claude gives it one goal at a time. The benchmark lives in `bench/` (run
`node bench/run.mjs --set all`), and the latest numbers are in RESULTS.md.

## Verdict

For the *see it and pick* half of working a browser, Jev makes a good partner. It answers a handful
of questions about a page in about 300 ms, and its probabilities hold up well enough to act on
without asking twice. It can't plan and it can't write text. So the work divides like this:

| who        | owns                                                                   |
|---|---|
| Claude     | the plan, one outcome to a step; every string to type; what happens when Jev says it can't |
| Jev        | each round's choices: which element, which action, which value; finished, error or blocked |
| code       | describing the page, waiting for it to settle, limits on loops, what changed and how many, typing |

Seen from Claude's side, it is like passing work to a quick, literal junior. The request is "log
in with these values", and back comes `done` with where it ended up; no page snapshot ever needs
reading. More than speed, what matters is a **status that can be trusted**. With the fixes below,
the last two full runs had no false "done" at all. The sore point is that Jev can't say why it did
something. When a step fails, the per-round record of its probabilities is the only way to find
out, so that record stays.

## First-round numbers (in Jev-playground, before this repo)

36 tasks in 14 categories: forms, widgets, pages that change, a single-page app, hover, confirm
dialogs and modals, big pages (Wikipedia, GitHub), iframes, shadow DOM, a React dropdown, new tabs,
infinite scroll, two checkouts end to end, a login on a private staging site, and six tasks
built to fail.

| run | what was new | correct | false done |
|---|---|---|---|
| v2-run1  | rewrite across the board: settling, labels, values, two stages, sessions | 20 of 26 | 2   |
| v2-run2  | plus checkbox text, images and headers, counts, stopping on errors, cycles, real typing | 25 of 26 | 0 |
| v2-run3/4| unchanged code, run again                                       | 25 of 26 | 0           |
| v3-run1  | plus 10 harder tasks, text in view, page metrics, sort state    | 33 of 36 | 1           |
| v3-run2  | plus a confirming question when answers disagree, see-through checkboxes | 34 of 36 | 0   |

v3-run2 more closely: **181 calls to Jev, 305 ms and 2.7k input tokens each on average**. Jev
takes a quarter of the time; loading and settling pages take the rest. The median confidence in
the element chosen is 0.97. The two-stage path coped with a page of 2,265 elements. An ordinary
task takes 2 to 4 calls and 1 to 8 s; a checkout of five steps, 14 to 18 calls and 13 to 19 s.

## Where it does well

- **Choosing the element.** It picked the right one on everything from a four-element form to a
  Wikipedia article, iframes and shadow DOM included, once code listed what was in them.
- **Putting values in the right fields.** One goal, "Log in" or "fill in the checkout", with a
  `values` object: Jev pairs a field with a value each round. A form of five fields, a radio button
  and the submit went through as one goal.
- **Reading state from what shows**: signed in, modal closed, option picked, result there, new tab
  open. In 556 rounds, `done` never reached 0.85 on a page that wasn't finished.
- **Knowing when it can't.** Drag and drop, right-click, file upload, a page that doesn't exist, a
  disabled field and a wrong password all ended `stuck` or `error`, never `done`.
- **Flows that run in a line, even given as one goal.** "Log in, buy the backpack, complete
  checkout" got there in 14 calls, since each page only lets the next step happen.

## Where it fails

- **Sub-goals in order whose traces vanish.** "Add two todos, complete one, clear completed" failed
  every time: it can't plan, and it loses track of which part it is on. The same actions given as
  five steps pass, so Claude has to split such goals up.
- **Goals with no end.** "Scroll to load more" never says when to stop: `done` swings from 0.2 to
  0.84 until the actions run out. Give it something to count instead.
- **Comparing many things**: whether a table is in order, whether there are exactly three of
  something, whether anything else changed. It called two of three elements "done" until code gave
  it `repeated_elements` counts, it couldn't confirm a sort without a marker, and it ticked a second
  todo nobody asked for without noticing.
- **What the page description leaves out.** Of the eleven or so fixes in this session, eight were
  gaps in how code described the page, not mistakes by Jev:
  - a login form that hadn't loaded when the page was first read
  - checkbox names given as loose text rather than labels
  - checkboxes styled to be transparent
  - images and `<th>` headers left out
  - text that wasn't in view
  - no sort markers
  - no counts
  - date pickers throwing away Playwright's `fill`

## Design rules

1. **Jev chooses; it never writes.** Anything open-ended comes to it as candidates. A "tool call"
   is a set of questions, one per argument, in one request (`choice` for enums and candidate
   strings, `noul` for yes/no). Code builds the JSON, and each field comes with its own confidence.
2. **Many questions, one request a round**: `done`, `done_change`, `error`, `blocked`, `tool`,
   `target`, `value`. Asking more in one go costs little; asking in separate calls costs a lot.
3. **Options are bare indices, and the objects sit in `state` in page order.** The elements next
   to one another carry context, as the earlier grounding experiment showed.
4. **Keep instructions short and plain.** Adding "filling in a form is not the same as submitting
   it" took a correct done from 0.70 down to 0.54. Two phrasings asked together and combined by
   taking the higher one did better than one clever phrasing.
5. **When answers disagree, that is the uncertainty.** If `done` sits between 0.5 and 0.85 while
   `tool` still wants to act, one stricter question goes out ("…with no further action needed, such
   as pressing a submit or search button?"). That cured the false "done" on GitHub: the stricter
   question scored 0.06, the loop clicked Search, and `done` then came to 0.94.
6. **Hand Jev summaries that code works out, not lists to compare**: `last_change` (what was added
   or removed, the address, new text), `metrics` (page height, length of text, number of elements),
   counts in `repeated_elements`, `sorted`, `checked`, `disabled`, `busy`.
7. **Describe what a person sees.** The labels a person reads (`<label>`, `aria-labelledby`, text
   beside the control), the text in view rather than the first N characters, and open dialogs apart.
8. **Timing belongs to code.** A page has settled when no fetch or XHR is out and nothing in the DOM
   has changed for 400 ms, with 8 s at most. Jev also gets a `wait` action for spinners.
9. **Keeping loops safe belongs to code.** Spotting cycles over (page, action), stopping at
   `error` of 0.7 or more, a cap on actions, and a `type` with nothing to type becoming a click.
10. **Hand back the spread, not a guess.** When the element choice is unsure the status is
    `ambiguous`, with the three best candidates, and Claude settles it.

## The interface Claude should use

```
open(url)                          -> { url, title }
do(goal, values?)                  -> { url, actions[], page_text?, candidates?,
                                        status: one of done, likely_done, needs_confirmation, error, stuck, blocked, ambiguous, max_actions }
check(question)                    -> probability          # confirm side effects, read the state
choose(question, options)          -> { probabilities, choice }
```

For the planner writing the goals:
- A step is one outcome you could see ("Mark 'buy milk' completed", rather than "…and then clear").
- Everything to type goes in `values`, under names that say what it is (`email`, `postal_code`).
- Give an open-ended goal an end you can count ("until at least 3 new paragraphs are shown").
- After a step that changes something, `check()` the things that should *not* have changed.
- `stuck`, `error` and `ambiguous` are where Claude takes over, not crashes.

## Second round: a repo of its own (17 September 2026)

Built: the MCP server with a session kept between calls; drag, right-click, key presses and
uploads; the stop before irreversible actions; `likely_done`; offline tests on fixtures; an estimate
of how much page the caller reads. Result now: 38 of 41 in two identical runs, and no false "done"
(RESULTS.md). What was learned:

11. **Ask the risky question with all the others, and let code decide.** `irreversible` is one more
    yes/no a round. At 0.6 or more on a click, Enter or key, the only thing it caught in about 200
    rounds was "Finish", which places an order. Logins, submits, "Add to cart" and "Continue" stayed at 0.23 or below.
12. **A step can run on into the next.** "Fill in checkout info and continue" ended on the order
    overview, and Jev couldn't see that as the end: the confirming question scored 0.18 to 0.43
    whatever the wording, naming the button included. The cure was a rule in code, not a prompt: with
    `done` in the middle, the confirming question saying no, and the next action irreversible, stop,
    call the step done, and list that action as `pending`.
13. **Some doubt can't be tuned out, so show it.** Confirming scores of 0.51 to 0.57 that were
    accepted were wrong three times; 0.59 to 0.60 were right twice. No line divides them, so the
    band from 0.45 to 0.65 now answers `likely_done` and the caller checks.
14. **Mention `values` in the done question, only when there are values, and never in the
    confirming one.** "Add a todo item" with `{todo: "walk the dog"}` added it five times over, until
    the done question read "…with the given `task.values`" (0.38 went to 0.52). The same words with no
    values made "add until 3" unsteady. Put in the confirming question, they broke logins (the values
    are gone once it works: 0.13) and the GitHub search (0.06 to 0.52, a false done).
15. **Don't offer actions a step hardly ever needs.** Jev went for `back` straight after logins that
    had worked (0.49 to 0.64) and went round in circles. Taking it out of Jev's choices fixed that; the
    caller can still use it through `browser_act`.
16. **Loop guards need the right unit to count.** The same action on a page that hasn't changed
    (three times), the same block of two or three actions (three times, with different actions
    inside it), and the one action over and over (eight times). The first limit on a single action,
    five, stopped scrolling that was doing its job.
17. **Show when order changes.** After a drag and drop the page holds the same elements in a new
    order, so the summary of changes looked empty and `done` stuck at 0.27. With a `reordered` entry
    showing before and after, the drag passes.
18. **Which row something is in belongs in the change summary.** A new todo shows up as one more
    `Toggle Todo` checkbox; only its `near` text says "walk the dog".
19. **Two fixes to listing elements came from fixture tests, not the benchmark:** looking up the text
    around an element skipped parents shorter than the element's own label, and broken images are
    drawn 18 px tall (so the size rule is right to leave them out).
20. **The model calling it reads far less.** Per task, the median is five times less page than a
    loop in the Playwright-MCP style, and on big pages 100 to 2,000 times less. Jev reads about as much
    in its place, at around 300 ms a call.

## Third round: real sites and steps that sometimes fail (17 September 2026)

21. **On the unsteady add-item step, the change summary was misleading.** The typed value came out
    as "removed", elements whose surrounding text had changed came out as removed and then added, and
    new text compared word by word lost repeated words ("walk dog"). Once elements were paired (by name
    and surrounding text, then by name), edits to values and checks were reported as `changed`, and
    text was compared as phrases, `done` for the second todo went from 0.29 to 0.59, and the step passed
    five times out of five without typing twice. The states that weren't done stayed at 0.23 or below.
22. **When Jev picks "no action" after acting and `done` is only 0.35 to 0.5, the goal had been
    reached** in every case kept (five of five), so that now answers `likely_done` rather than `stuck`.
23. **A login wall needs a status of its own.** Signed out of x.com, "open Following" went to X's
    login page, then to "Continue with Google" and Google's sign-in tab. A `login` yes/no plus "no
    credentials in `values`" now answers `needs_login` before anything is clicked (one or two calls).
24. **Not every modal is marked up as a dialog.** X's login modal is a `div` fixed over the whole
    screen. Code now hit-tests every element on screen (`covered: true`), lists large fixed overlays
    as dialogs, and turns Playwright's "intercepts pointer events" into "click blocked by an overlay".
    After that, Jev shut the modal with Escape on its own and finished the step.
25. **Headless can be shut out without a word.** x.com draws nothing in headless Chromium, and the
    settling code calls the empty page quiet after 0.7 s. Such sites need a visible browser; `open()`
    doesn't notice this yet.

## Next

- Use it as a real MCP server in Claude Code for everyday work, and note each time Claude has to step in.
- Sub-goals in order: let the caller give `goal` as a list and have code work through it, asking Jev
  "which of these is the first not done yet?" (a choice it answers well) instead of one long goal.
- Checking comparisons (sorted, exactly one changed): facts worked out in code and put in state
  (the order of a column, a list of what changed) instead of asking Jev to compare.
- Calibration: record (probability, outcome) pairs from real use to set `doneAt`, the confirming band
  and `irreversibleAt` on more than a few dozen cases.
- Out of scope: cross-origin iframes Playwright can't run code in, canvas apps, and captchas.
