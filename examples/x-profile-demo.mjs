#!/usr/bin/env node
// A headed run over a public X profile, with every decision outlined on the page just before it is
// acted on. X hangs up on headless browsers, so this one has to run headed.
//   run it with: node examples/x-profile-demo.mjs

import { Barq } from "../src/index.mjs";

const b = await Barq.launch({ headed: true, slowMo: 250, highlight: true });

const step = async (goal, options = {}) => { const opts = options;
  console.log(`\n▶ ${goal}`);
  const r = await b.do(goal, { log: line => console.log(line), ...opts });
  const why = r.info ? ` (${r.info})` : "";
  console.log(`  = ${r.status}${why}  ${r.jev_calls} jev calls, ${(r.ms / 1000).toFixed(1)}s  → ${r.url}`);
  if (r.pending) console.log("  stopped before:", r.pending);
  return r;
};

const ask = async question => {
  const p = await b.check(question);   // 0 to 1
  console.log(`\n? ${question}\n  p_yes = ${p.toFixed(2)}`);
};

const profile = "https://x.com/ibrahimwithi";

try {
  console.log(`▶ open ${profile}`);
  await b.open(profile);

  await ask("Is this a profile page on X rather than a timeline or a search?");
  await ask("Does the profile show at least one post?");

  await step("Show this profile's Media tab");
  await step("Go back to the Posts tab of this profile");
  await step("Open up the first post so all of its text shows");
  await step("Open the list of accounts this profile follows");
} finally {
  console.log("\nclosing in five seconds…");
  await new Promise(done => setTimeout(done, 5000));
  await b.close();
}
