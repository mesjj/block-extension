// Focus Lock — background service worker
// Tracks time spent on configured sites within repeating daily windows,
// blocks sites once the per-window budget is used up, and supports a
// one-way "nuclear" mode that blocks everything for a fixed duration.

const DEFAULT_SETTINGS = {
  sites: [],
  allowedMinutes: 30,
  windowHours: 2,
};

const HEARTBEAT_ALARM = "heartbeat";
const EXHAUSTION_ALARM = "exhaustion";
const NUCLEAR_END_ALARM = "nuclear-end";
const WINDOW_ALARM = "window-reset";
const MAX_FLUSH_MS = 5 * 60000;

// A single navigation fires several events at once (tabs.onUpdated for the
// url, again for "complete", plus onActivated/onFocusChanged). Without
// serialization each one reads the same tracking.since and charges the same
// elapsed minutes to the budget, so switching sites burned time twice over.
let opQueue = Promise.resolve();
function withLock(fn) {
  const result = opQueue.then(fn);
  opQueue = result.then(
    () => {},
    () => {}
  );
  return result;
}

// ---------- storage helpers ----------

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function saveSettings(settings) {
  const clean = {
    sites: (settings.sites || [])
      .map(normalizeDomain)
      .filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i),
    allowedMinutes: Math.max(0, Number(settings.allowedMinutes) || 0),
    windowHours: Math.max(0.25, Number(settings.windowHours) || 1),
  };
  await chrome.storage.local.set({ settings: clean });
  return clean;
}

async function getUsage() {
  const { usage } = await chrome.storage.local.get("usage");
  return usage || { windowStart: 0, usedMs: 0 };
}

async function setUsage(usage) {
  await chrome.storage.local.set({ usage });
}

async function getNuclear() {
  const { nuclear } = await chrome.storage.local.get("nuclear");
  return nuclear || { active: false, startTime: null, endTime: null, durationMs: null };
}

async function setNuclear(nuclear) {
  await chrome.storage.local.set({ nuclear });
}

async function getTracking() {
  const { tracking } = await chrome.storage.session.get("tracking");
  return tracking || { domain: null, since: null };
}

async function setTracking(tracking) {
  await chrome.storage.session.set({ tracking });
}

// ---------- domain helpers ----------

function normalizeDomain(input) {
  if (!input) return "";
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0];
  s = s.split(":")[0];
  return s;
}

function hostnameFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function domainMatches(hostname, listDomain) {
  return hostname === listDomain || hostname.endsWith("." + listDomain);
}

async function matchedSite(hostname) {
  if (!hostname) return null;
  const settings = await getSettings();
  return settings.sites.find((d) => domainMatches(hostname, d)) || null;
}

// ---------- window/usage logic ----------

function computeWindowStart(now, windowHours) {
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const hoursSinceMidnight = (now - midnight) / 3600000;
  const index = Math.floor(hoursSinceMidnight / windowHours);
  return midnight + index * windowHours * 3600000;
}

async function ensureUsageWindowCurrent() {
  const settings = await getSettings();
  const now = Date.now();
  const currentWindowStart = computeWindowStart(now, settings.windowHours);
  let usage = await getUsage();
  if (usage.windowStart !== currentWindowStart) {
    usage = { windowStart: currentWindowStart, usedMs: 0 };
    await setUsage(usage);
    // Wake up exactly when this window ends so the block lifts on time
    // instead of up to a heartbeat late.
    await scheduleWindowAlarm(usage, settings);
  }
  return { usage, settings, now };
}

// Windows restart at midnight, so the last one of the day is short whenever
// the window length doesn't divide 24 evenly (e.g. 5h -> 20:00 runs 4h).
function computeWindowEnd(windowStart, windowHours) {
  const d = new Date(windowStart);
  const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return Math.min(windowStart + windowHours * 3600000, nextMidnight);
}

async function scheduleWindowAlarm(usage, settings) {
  await chrome.alarms.create(WINDOW_ALARM, {
    when: computeWindowEnd(usage.windowStart, settings.windowHours),
  });
}

// Time since tracking.since that a flush would charge. Clamped so it can't
// reach back before this window started, and capped at MAX_FLUSH_MS — the
// heartbeat commits every minute, so a larger gap means the machine was
// asleep or the browser wasn't running, which shouldn't eat the budget.
function pendingMs(tracking, usage, now) {
  if (!tracking.domain || !tracking.since) return 0;
  return Math.max(
    0,
    Math.min(now - tracking.since, now - usage.windowStart, MAX_FLUSH_MS)
  );
}

// usage.usedMs is only persisted at flush points (tracking start/stop, the
// exhaustion alarm). While actively tracking, add the still-unflushed
// in-progress elapsed time so live displays (popup, badge) count down
// smoothly instead of freezing until the next flush.
async function liveUsedMs() {
  const { usage } = await ensureUsageWindowCurrent();
  const tracking = await getTracking();
  return usage.usedMs + pendingMs(tracking, usage, Date.now());
}

async function remainingMsForSites() {
  const { settings } = await ensureUsageWindowCurrent();
  const budgetMs = settings.allowedMinutes * 60000;
  return Math.max(0, budgetMs - (await liveUsedMs()));
}

async function isBudgetExhausted() {
  return (await remainingMsForSites()) <= 0;
}

// ---------- tracking ----------

async function flushTracking() {
  const tracking = await getTracking();
  if (!tracking.domain || !tracking.since) return;
  const { usage } = await ensureUsageWindowCurrent();
  const now = Date.now();
  usage.usedMs += pendingMs(tracking, usage, now);
  await setUsage(usage);
  await setTracking({ domain: tracking.domain, since: now });
}

async function stopTracking() {
  await flushTracking();
  await setTracking({ domain: null, since: null });
  await chrome.alarms.clear(EXHAUSTION_ALARM);
}

async function startTracking(domain) {
  const tracking = await getTracking();
  if (tracking.domain !== domain) {
    await flushTracking(); // commit the previous domain's time before switching
    await setTracking({ domain, since: Date.now() });
  }
  // Always refresh the alarm: remaining accounts for in-flight time, so this
  // stays accurate, and the alarm survives having already fired once.
  const remaining = await remainingMsForSites();
  await chrome.alarms.create(EXHAUSTION_ALARM, { when: Date.now() + remaining });
}

// ---------- declarativeNetRequest ----------

// "from" is appended last and left unencoded so the blocked page can recover
// the whole original URL (including its own & params) and send the tab back
// once the block lifts. \0 is the full matched URL.
function blockedPageUrl(mode, site) {
  const base = chrome.runtime.getURL("blocked.html") + "?mode=" + mode;
  return site ? base + "&site=" + encodeURIComponent(site) : base;
}

let lastRulesSignature = null;

async function updateBlockingRules() {
  const nuclear = await getNuclear();
  const settings = await getSettings();
  const exhausted = await isBudgetExhausted();

  const signature = nuclear.active
    ? "nuclear"
    : exhausted && settings.sites.length > 0
      ? "sites:" + settings.sites.join(",")
      : "none";

  // Rewriting dynamic rules hits disk, and reconcile runs on every tab event.
  if (signature !== lastRulesSignature) {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.map((r) => r.id);
    const addRules = [];
    let nextId = 1;

    if (nuclear.active) {
      addRules.push({
        id: nextId++,
        priority: 1,
        action: {
          type: "redirect",
          redirect: { regexSubstitution: blockedPageUrl("nuclear") + "&from=\\0" },
        },
        condition: { regexFilter: "^https?://.*", resourceTypes: ["main_frame"] },
      });
    } else if (exhausted && settings.sites.length > 0) {
      for (const domain of settings.sites) {
        addRules.push({
          id: nextId++,
          priority: 1,
          action: {
            type: "redirect",
            redirect: { regexSubstitution: blockedPageUrl("site", domain) + "&from=\\0" },
          },
          condition: {
            regexFilter: "^https?://.*",
            requestDomains: [domain],
            resourceTypes: ["main_frame"],
          },
        });
      }
    }

    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    lastRulesSignature = signature;
  }

  await enforceOpenTabs(nuclear.active, exhausted, settings);
}

// declarativeNetRequest only intercepts *new* navigations, so a tab that's
// already sitting on a limited site needs to be redirected by hand the
// moment its budget runs out (or nuclear mode kicks in).
async function enforceOpenTabs(nuclearActive, exhausted, settings) {
  if (!nuclearActive && !(exhausted && settings.sites.length > 0)) return;

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || !tab.id) continue;
    const hostname = hostnameFromUrl(tab.url);
    if (!hostname) continue; // not an http/https page (e.g. already on blocked.html)

    let target = null;
    if (nuclearActive) {
      target = blockedPageUrl("nuclear");
    } else {
      const site = settings.sites.find((d) => domainMatches(hostname, d));
      if (site) target = blockedPageUrl("site", site);
    }
    if (target) {
      chrome.tabs.update(tab.id, { url: target + "&from=" + tab.url }).catch(() => {});
    }
  }
}

// ---------- toolbar badge ----------

const BADGE_COLOR_OK = "#16a34a";
const BADGE_COLOR_LOW = "#f59e0b";
const BADGE_COLOR_EXHAUSTED = "#b91c1c";
const BADGE_COLOR_NUCLEAR = "#7f1d1d";

async function updateBadgeForTab(tabId, url, ctx) {
  const hostname = url ? hostnameFromUrl(url) : null;
  const site = hostname
    ? ctx.settings.sites.find((d) => domainMatches(hostname, d)) || null
    : null;
  // A blocked tab has been navigated off the site to our own page, so match
  // that too — otherwise the indicator vanishes exactly when it matters.
  const onBlockedPage = typeof url === "string" && url.startsWith(ctx.blockedPrefix);

  if (!site && !onBlockedPage) {
    await chrome.action.setBadgeText({ tabId, text: "" });
    await chrome.action.setTitle({ tabId, title: "Focus Lock" });
    return;
  }

  const label = site || "this site";

  if (ctx.nuclear.active) {
    await chrome.action.setBadgeText({ tabId, text: "×" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR_NUCLEAR });
    await chrome.action.setTitle({
      tabId,
      title: "Focus Lock — everything is blocked (nuclear mode)",
    });
    return;
  }

  const remainingMin = Math.ceil(ctx.remainingMs / 60000);
  const exhausted = ctx.remainingMs <= 0;

  await chrome.action.setBadgeText({ tabId, text: exhausted ? "0" : String(remainingMin) });
  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: exhausted ? BADGE_COLOR_EXHAUSTED : remainingMin <= 5 ? BADGE_COLOR_LOW : BADGE_COLOR_OK,
  });
  await chrome.action.setTitle({
    tabId,
    title: exhausted
      ? `Focus Lock — ${label} is blocked until the next window`
      : `Focus Lock — ${remainingMin} min left on ${label} this window`,
  });
}

// Shared state is read once here rather than per tab; this runs on every
// tab event and a browser can have a lot of tabs open.
async function refreshAllBadges() {
  const [settings, nuclear, remainingMs, tabs] = await Promise.all([
    getSettings(),
    getNuclear(),
    remainingMsForSites(),
    chrome.tabs.query({}),
  ]);
  const ctx = {
    settings,
    nuclear,
    remainingMs,
    blockedPrefix: chrome.runtime.getURL("blocked.html"),
  };
  // A tab can close mid-update; don't let that abort the caller.
  await Promise.all(
    tabs.map((t) => updateBadgeForTab(t.id, t.url, ctx).catch(() => {}))
  );
}

// ---------- reconciliation (decide what to track based on the active tab) ----------

async function getFocusedActiveTabUrl() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const focused = windows.find((w) => w.focused);
  if (!focused) return null;
  const activeTab = (focused.tabs || []).find((t) => t.active);
  return activeTab ? activeTab.url : null;
}

async function reconcile() {
  await ensureUsageWindowCurrent();
  await endNuclearIfDue();
  const nuclear = await getNuclear();

  if (nuclear.active) {
    await stopTracking();
    await updateBlockingRules();
    await refreshAllBadges();
    return;
  }

  // Only pause tracking when the screen is actually locked. chrome.idle's
  // "idle" state fires after a few seconds of no keyboard/mouse input,
  // which happens constantly while reading or watching a video — treating
  // that as "not using the site" made the countdown freeze mid-session.
  let idleState = "active";
  try {
    idleState = await chrome.idle.queryState(15);
  } catch {
    // ignore, assume active
  }

  const url = await getFocusedActiveTabUrl();
  const hostname = url ? hostnameFromUrl(url) : null;
  const site = hostname ? await matchedSite(hostname) : null;

  if (idleState === "locked" || !site) {
    await stopTracking();
    await updateBlockingRules();
    await refreshAllBadges();
    return;
  }

  const exhausted = await isBudgetExhausted();
  if (exhausted) {
    await stopTracking();
  } else {
    await startTracking(site);
  }
  await updateBlockingRules();
  await refreshAllBadges();
}

// ---------- nuclear mode ----------

async function startNuclear(durationMs) {
  const now = Date.now();
  const current = await getNuclear();
  // A second request (e.g. from a stale popup) may extend an active session
  // but must never shorten it — that would defeat the point.
  if (current.active && current.endTime >= now + durationMs) return;
  const nuclear = {
    active: true,
    startTime: current.active ? current.startTime : now,
    endTime: now + durationMs,
    durationMs: current.active ? now + durationMs - current.startTime : durationMs,
  };
  await setNuclear(nuclear);
  await chrome.alarms.create(NUCLEAR_END_ALARM, { when: nuclear.endTime });
  await reconcile();
}

async function endNuclearIfDue() {
  const nuclear = await getNuclear();
  if (nuclear.active && Date.now() >= nuclear.endTime) {
    await setNuclear({ active: false, startTime: null, endTime: null, durationMs: null });
    await updateBlockingRules();
  }
}

// ---------- alarms & events ----------

// Runs on every service worker wake-up. Creating an alarm that already exists
// would reset its period (and the worker wakes often), so only fill gaps.
async function ensureAlarms() {
  if (!(await chrome.alarms.get(HEARTBEAT_ALARM))) {
    await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  }
  if (!(await chrome.alarms.get(WINDOW_ALARM))) {
    const { usage, settings } = await ensureUsageWindowCurrent();
    await scheduleWindowAlarm(usage, settings);
  }
}

chrome.alarms.onAlarm.addListener((alarm) =>
  withLock(async () => {
    if (alarm.name === HEARTBEAT_ALARM) {
      await endNuclearIfDue();
      await flushTracking(); // commit in-flight time so stored usage stays current
      await reconcile();
    } else if (alarm.name === EXHAUSTION_ALARM) {
      await flushTracking();
      await reconcile();
    } else if (alarm.name === NUCLEAR_END_ALARM) {
      await endNuclearIfDue();
      await reconcile();
    } else if (alarm.name === WINDOW_ALARM) {
      await reconcile(); // window rolled over: lift the block immediately
      await ensureAlarms();
    }
  })
);

chrome.tabs.onActivated.addListener(() => withLock(reconcile));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") withLock(reconcile);
});
chrome.windows.onFocusChanged.addListener(() => withLock(reconcile));
chrome.idle.onStateChanged.addListener(() => withLock(reconcile));

chrome.runtime.onInstalled.addListener(() =>
  withLock(async () => {
    const settings = await getSettings();
    await saveSettings(settings);
    await chrome.idle.setDetectionInterval(15);
    await ensureAlarms();
    await reconcile();
  })
);

chrome.runtime.onStartup.addListener(() =>
  withLock(async () => {
    await chrome.idle.setDetectionInterval(15);
    await ensureAlarms();
    await endNuclearIfDue();
    await reconcile();
  })
);

// The worker is restarted on demand; make sure the timers survive that.
withLock(ensureAlarms);

// ---------- messaging (popup / options) ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  withLock(async () => {
    try {
      await handleMessage(msg, sendResponse);
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  });
  return true; // keep channel open for async sendResponse
});

async function handleMessage(msg, sendResponse) {
  switch (msg?.type) {
    case "GET_STATE": {
      await endNuclearIfDue();
      const { usage, settings } = await ensureUsageWindowCurrent();
      const nuclear = await getNuclear();
      sendResponse({
        settings,
        usage,
        nuclear,
        remainingMs: await remainingMsForSites(),
        windowEndsAt: computeWindowEnd(usage.windowStart, settings.windowHours),
      });
      break;
    }
    case "SAVE_SETTINGS": {
      const clean = await saveSettings(msg.settings);
      await updateBlockingRules();
      await reconcile();
      sendResponse({ ok: true, settings: clean });
      break;
    }
    case "START_NUCLEAR": {
      const durationMs = Math.max(60000, Number(msg.durationMs) || 0);
      await startNuclear(durationMs);
      sendResponse({ ok: true });
      break;
    }
    default:
      sendResponse({ ok: false, error: "unknown message" });
  }
}
