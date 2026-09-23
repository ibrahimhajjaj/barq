// Offline: how far each date on a page is from today, for goals about time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateDates, ABOUT_TIME } from "../src/dates.mjs";

const now = new Date(2026, 8, 23, 15, 0);   // 23 September 2026, afternoon

test("each full date says how far it is from today, in any of the usual forms", () => {
  assert.equal(annotateDates("Meetup · October 20, 2026", now), "Meetup · October 20, 2026 (in 27 days)");
  assert.equal(annotateDates("Due 2026-09-24", now), "Due 2026-09-24 (tomorrow)");
  assert.equal(annotateDates("Shipped 22 Sep 2026", now), "Shipped 22 Sep 2026 (yesterday)");
  assert.equal(annotateDates("Sept 23rd, 2026", now), "Sept 23rd, 2026 (today)");
  assert.equal(annotateDates("Posted Aug 24, 2026", now), "Posted Aug 24, 2026 (30 days ago)");
});

test("what isn't a whole date is left as it was, and a date is never said twice", () => {
  for (const s of ["Version 2026-13-40", "Order 20 items in 2026", "February 30, 2026", "Room 2026"]) assert.equal(annotateDates(s, now), s);
  const once = annotateDates("October 20, 2026", now);
  assert.equal(annotateDates(once, now), once);
});

test("only a goal about time gets the dates counted", () => {
  for (const g of ["Open the next upcoming event", "Find the order from yesterday", "Which invoice is overdue?", "Show posts from this week"]) assert.ok(ABOUT_TIME.test(g), g);
  for (const g of ["Log in", "Add the Backpack to the cart", "Open the Pull requests tab"]) assert.ok(!ABOUT_TIME.test(g), g);
});
