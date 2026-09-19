// Many pages, no decisions: each job's URL is opened in one of a few background tabs, the caller's
// extractor reads the page, and one JSON line per job goes to a file. No decision model is asked
// anything, so a thousand pages cost no model tokens. What a hand-written loop has to get right
// lives here: pacing with random gaps, a checkpoint a rerun resumes from, one more try after an
// error, and stopping everything the moment a site says it has seen too much traffic (a person
// has to look then; nothing here tries to get past it).
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// The pages sites send automated traffic to: Google's /sorry/, reCAPTCHA, Cloudflare's challenge.
export const BLOCKED = /\/sorry\/|\/recaptcha\/|captcha|\/cdn-cgi\/challenge-platform\//i;

const sleep = ms => new Promise(done => setTimeout(done, ms));

export class ScanBlocked extends Error {}

// A job is a URL, or { url, key?, ...anything to keep with its result }. The key (the URL by
// default) is what the checkpoint remembers.
export function normalizeJobs(jobs) {
  const seen = new Set(), out = [];
  for (const j of jobs) {
    const job = typeof j === "string" ? { url: j } : { ...j };
    if (!job.url) throw new Error(`a job has no url: ${JSON.stringify(j).slice(0, 80)}`);
    job.key ??= job.url;
    if (seen.has(job.key)) continue;
    seen.add(job.key); out.push(job);
  }
  return out;
}

// Keys a checkpoint file already holds a result for (errors are tried again).
export function doneKeys(file) {
  const done = new Set();
  if (!file || !existsSync(file)) return done;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.key != null && !r.error) done.add(r.key); } catch {}
  }
  return done;
}

// The extractor from the options: a function (page, job) -> result, a JavaScript expression run in
// the page, or a CSS selector whose matches' text is returned. Without one, the page's visible text.
export function extractor({ extract, js, selector, maxText = 20_000 } = {}) {
  if (typeof extract === "function") return extract;
  if (js) return page => page.evaluate(js);
  if (selector) return page => page.$$eval(selector, els => els.map(e => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean));
  return page => page.evaluate(n => document.body?.innerText.slice(0, n) ?? "", maxText);
}

// Click the control named `name` (text or a regular expression) until it's gone, for "Load more"
// and "View more flights" buttons. At most `max` clicks.
async function clickUntilGone(page, name, { max = 20, pause = 900 } = {}) {
  const re = name instanceof RegExp ? name : new RegExp(String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  let clicks = 0;
  for (; clicks < max; clicks++) {
    const more = page.getByRole("button", { name: re }).or(page.getByRole("link", { name: re })).first();
    if (!(await more.isVisible().catch(() => false))) break;
    await more.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(pause);
  }
  return clicks;
}

// host: anything with newTab() (an attached or launched browser). Returns a summary; progress and
// the records themselves go to `onRecord` and the checkpoint file as they happen.
export async function scan(host, jobs, {
  tabs = 3, jitter = [1000, 3000], checkpoint, waitFor, clickUntilGone: more, stopOn = BLOCKED,
  retries = 1, timeout = 45_000, signal, onRecord = () => {}, ...pick
} = {}) {
  const all = normalizeJobs(jobs), done = doneKeys(checkpoint);
  const queue = all.filter(j => !done.has(j.key));
  const read = extractor(pick);
  if (checkpoint) mkdirSync(dirname(checkpoint), { recursive: true });
  const summary = { total: all.length, skipped: all.length - queue.length, done: 0, errors: 0, blocked: null, file: checkpoint ?? null, ms: 0 };
  const t0 = Date.now();
  const gap = () => sleep(jitter[0] + Math.random() * Math.max(0, jitter[1] - jitter[0]));
  const stopped = () => summary.blocked || signal?.aborted;

  const visit = async (page, job) => {
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout });
    if (stopOn.test(page.url())) throw new ScanBlocked(`the site sent us to ${page.url()}`);
    if (waitFor) await page.locator(waitFor).first().waitFor({ timeout: Math.min(timeout, 20_000) }).catch(() => {});
    const clicks = more ? await clickUntilGone(page, more) : 0;
    if (stopOn.test(page.url())) throw new ScanBlocked(`the site sent us to ${page.url()}`);
    return { result: await read(page, job), ...(clicks ? { clicks } : {}) };
  };

  const worker = async () => {
    const page = await host.newTab({ session: "scan" });
    try {
      while (queue.length && !stopped()) {
        const job = queue.shift();
        const { url, key, ...extra } = job;
        let record;
        for (let attempt = 1; attempt <= retries + 1 && !stopped(); attempt++) {
          try {
            record = { key, url, ...extra, ...(await visit(page, job)), at: new Date().toISOString() };
            break;
          } catch (e) {
            if (e instanceof ScanBlocked) { summary.blocked = e.message; queue.unshift(job); return; }
            record = { key, url, ...extra, error: String(e.message).split("\n")[0].slice(0, 200), attempt, at: new Date().toISOString() };
            if (attempt <= retries) await sleep(3000);
          }
        }
        if (!record) { queue.unshift(job); break; }   // stopped before it ran: it's still to do
        if (checkpoint) appendFileSync(checkpoint, JSON.stringify(record) + "\n");
        record.error ? summary.errors++ : summary.done++;
        onRecord(record, summary);
        if (queue.length && !stopped()) await gap();
      }
    } finally { await page.close().catch(() => {}); }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(tabs, queue.length || 1)) }, worker));
  summary.ms = Date.now() - t0;
  summary.left = queue.length;
  return summary;
}
