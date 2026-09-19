// Keeps the agent's tabs in a tab group of their own and out of the user's way. The automation
// process reaches this worker over the DevTools protocol and calls the functions it puts on `self`;
// the listeners below handle tabs the agent's pages open on their own.
//
// State lives in storage.session because the worker is stopped when idle:
//   groups:   { [groupId]: { session, collapsed } }  groups this extension manages, and whether the
//                                                     user wants each one collapsed
//   userTabs: { [windowId]: [tabId, ...] }           the user's recent tabs, newest last

// Every read-modify-write of the state runs one at a time: two sessions opening tabs at once
// would otherwise each save their own copy and one group would be forgotten.
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

async function load() {
  const { groups = {}, userTabs = {} } = await chrome.storage.session.get(["groups", "userTabs"]);
  return { groups, userTabs };
}
const save = patch => chrome.storage.session.set(patch);

// When an agent tab was last brought forward, per window. Kept in memory only: it matters for a
// second or two, while the worker is certainly awake.
const agentActivatedAt = {};

const rememberUserTab = windowId => exclusive(async () => {
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (!active) return;
  const { groups, userTabs } = await load();
  if (groups[active.groupId]) { agentActivatedAt[windowId] = Date.now(); return; }
  const list = (userTabs[windowId] ?? []).filter(id => id !== active.id);
  list.push(active.id);
  userTabs[windowId] = list.slice(-5);
  await save({ userTabs });
});

// Give the user their tab back if one of the agent's tabs took the foreground. A new tab can be
// activated before it is grouped, so walk back past anything that is now the agent's.
async function restoreUserTab(windowId) {
  const { groups, userTabs } = await load();
  for (const id of [...(userTabs[windowId] ?? [])].reverse()) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab || groups[tab.groupId]) continue;
    await chrome.tabs.update(id, { active: true }).catch(() => {});
    return;
  }
}

self.jevVersion = () => chrome.runtime.getManifest().version;

// Put the tab whose URL ends with `marker` into the session's group, creating the group in that
// tab's window if the session has none there yet.
self.jevGroup = async ({ marker, session = "main", title = "Agent", color = "purple", collapsed = true }) => {
  const tab = (await chrome.tabs.query({})).find(t => (t.url || t.pendingUrl || "").endsWith(marker));
  if (!tab) throw new Error(`no tab ends with ${marker}`);
  await rememberUserTab(tab.windowId);
  const result = await exclusive(async () => {
    const { groups } = await load();
    let groupId = null;
    for (const [id, g] of Object.entries(groups)) {
      if (g.session !== session) continue;
      const live = await chrome.tabGroups.get(+id).catch(() => null);
      if (live && live.windowId === tab.windowId) { groupId = live.id; break; }
    }
    const created = groupId == null;
    groupId = await chrome.tabs.group(created
      ? { tabIds: [tab.id], createProperties: { windowId: tab.windowId } }
      : { groupId, tabIds: [tab.id] });
    // record the group before styling it, so a failure below can't leave an unknown group behind
    if (created) { groups[groupId] = { session, collapsed }; await save({ groups }); }
    // collapse only a new group: if the user opened it to watch, leave it open
    await chrome.tabGroups.update(groupId, created ? { title, color, collapsed } : { title, color });
    return { tabId: tab.id, groupId, windowId: tab.windowId };
  });
  if (tab.active) await restoreUserTab(tab.windowId);
  return result;
};

// Listening for new tabs is also what wakes this worker when the agent opens one.
chrome.tabs.onCreated.addListener(() => {});

chrome.tabs.onActivated.addListener(({ windowId }) => rememberUserTab(windowId).catch(() => {}));

// The user collapsing or expanding a group is a preference to keep. An agent tab coming forward
// also expands its group, and that isn't the user's choice.
chrome.tabGroups.onUpdated.addListener(group => exclusive(async () => {
  const { groups } = await load();
  if (!groups[group.id] || groups[group.id].collapsed === group.collapsed) return;
  if (Date.now() - (agentActivatedAt[group.windowId] ?? 0) < 1500) return;
  const [active] = await chrome.tabs.query({ active: true, windowId: group.windowId });
  if (active?.groupId === group.id) return;
  groups[group.id].collapsed = group.collapsed;
  await save({ groups });
}).catch(() => {}));

// A link with target=_blank or window.open() in an agent tab. The new tab's openerTabId can name
// the user's active tab instead of the agent's, so the navigation's source tab decides. A popup
// window of its own is left alone here: the automation side minimizes it, extension or not.
// Nothing here focuses a window, which would pull the browser in front of whatever app the user is in.
chrome.webNavigation.onCreatedNavigationTarget.addListener(async ({ sourceTabId, tabId }) => {
  const source = await chrome.tabs.get(sourceTabId).catch(() => null);
  const { groups } = await load();
  const group = source && groups[source.groupId];
  if (!group) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const win = tab && await chrome.windows.get(tab.windowId, { populate: true }).catch(() => null);
  if (!win) return;
  if (win.id !== source.windowId && win.type === "normal" && win.tabs.length > 1) {
    // opened in another of the user's windows: bring it next to its opener
    await chrome.tabs.move(tabId, { windowId: source.windowId, index: -1 }).catch(() => {});
  } else if (win.id !== source.windowId) {
    return;
  }
  agentActivatedAt[source.windowId] = Date.now();
  await chrome.tabs.group({ groupId: source.groupId, tabIds: [tabId] }).catch(() => {});
  if ((await chrome.tabs.get(tabId).catch(() => null))?.active) await restoreUserTab(source.windowId);
  if (group.collapsed) await chrome.tabGroups.update(source.groupId, { collapsed: true }).catch(() => {});
});

chrome.tabGroups.onRemoved.addListener(group => exclusive(async () => {
  const { groups } = await load();
  if (!(group.id in groups)) return;
  delete groups[group.id];
  await save({ groups });
}).catch(() => {}));
