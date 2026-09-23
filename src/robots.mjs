// robots.txt, read the way crawlers agree on: the group for our agent if there is one, otherwise the
// one for "*"; the longest matching rule wins, and Allow wins a tie. `*` matches anything and `$`
// ends a rule. A site with no robots.txt, or one that can't be fetched, allows everything, except
// that a 401 or 403 on robots.txt itself is taken as "keep out".

export function parseRobots(text, agent = "barq") {
  const groups = [];
  let current = null, lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, field, value] = [null, m[1].toLowerCase(), m[2].trim()];
    if (field === "user-agent") {
      if (!lastWasAgent) groups.push(current = { agents: [], rules: [], delay: null });
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if ((field === "allow" || field === "disallow") && value) current.rules.push({ allow: field === "allow", path: value });
    if (field === "crawl-delay" && Number.isFinite(Number(value))) current.delay = Number(value);
  }
  const mine = groups.filter(g => g.agents.some(a => a !== "*" && agent.toLowerCase().includes(a)));
  const chosen = mine.length ? mine : groups.filter(g => g.agents.includes("*"));
  return { rules: chosen.flatMap(g => g.rules), delay: chosen.map(g => g.delay).find(d => d != null) ?? null };
}

const matches = (rule, path) => {
  const re = new RegExp("^" + rule.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\?\$$/, "$"));
  return re.test(path);
};

export function allowed(robots, url) {
  const u = new URL(url), path = u.pathname + u.search;
  let best = null;
  for (const r of robots.rules) {
    if (!matches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

// One fetch per origin for the whole scan.
export function robotsReader({ agent = "barq", fetchImpl = fetch } = {}) {
  const cache = new Map();
  return origin => {
    if (!cache.has(origin)) cache.set(origin, (async () => {
      try {
        const res = await fetchImpl(`${origin}/robots.txt`, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
        if (res.status === 401 || res.status === 403) return { rules: [{ allow: false, path: "/" }], delay: null };
        if (!res.ok) return { rules: [], delay: null };
        return parseRobots(await res.text(), agent);
      } catch { return { rules: [], delay: null }; }
    })());
    return cache.get(origin);
  };
}
