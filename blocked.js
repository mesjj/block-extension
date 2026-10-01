function formatDuration(ms) {
  if (ms <= 0) return "0:00";
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const params = new URLSearchParams(location.search);
const mode = params.get("mode");
const site = params.get("site");

// "from" is appended last and unencoded, so take everything after it rather
// than using URLSearchParams (which would truncate a url containing "&").
// Read from href, not search, so a #fragment in the original url survives.
// The scheme check keeps a hand-crafted link from turning this into a
// javascript:/data: navigation.
function originalUrl() {
  const match = location.href.match(/[?&]from=(.+)$/);
  if (!match) return null;
  return /^https?:\/\//i.test(match[1]) ? match[1] : null;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function fromIsLimited(state) {
  const host = hostOf(originalUrl() || "");
  if (!host) return false;
  return (state.settings.sites || []).some(
    (d) => host === d || host.endsWith("." + d)
  );
}

// Guard against ping-ponging if the rules haven't been torn down yet.
const RETURN_KEY = "focuslock:lastReturn";
function tryReturn(url) {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RETURN_KEY)) || 0;
  } catch {}
  if (Date.now() - last < 30000) return;
  try {
    sessionStorage.setItem(RETURN_KEY, String(Date.now()));
  } catch {}
  location.replace(url);
}

const el = (id) => document.getElementById(id);

function render(headline, detail, countdown, subtext) {
  el("headline").textContent = headline;
  el("detail").textContent = detail;
  el("countdown").textContent = countdown;
  el("countdown").hidden = !countdown;
  el("subtext").textContent = subtext;
}

function renderUnblocked() {
  const url = originalUrl();
  render(
    "You're unblocked",
    url ? "" : "This page is no longer blocked.",
    "",
    ""
  );
  const link = el("backLink");
  link.hidden = !url;
  if (url) {
    const host = hostOf(url);
    link.textContent = `Back to ${host || "the page"}`;
    link.href = url;
    if (document.visibilityState === "visible") tryReturn(url);
  }
}

async function tick() {
  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  } catch {
    return; // service worker restarting — try again next tick
  }
  if (!state) return;

  if (state.nuclear.active) {
    render(
      "Nuclear mode active",
      "You chose to block every website. There is no way to cancel this early.",
      formatDuration(state.nuclear.endTime - Date.now()),
      "The internet comes back automatically when this hits zero."
    );
    el("backLink").hidden = true;
    return;
  }

  const stillBlocked =
    state.remainingMs <= 0 && (mode === "site" || fromIsLimited(state));

  if (stillBlocked) {
    render(
      `${site || "This site"} is blocked`,
      "You've used up your time for this window.",
      formatDuration(state.windowEndsAt - Date.now()),
      "Time remaining until the next window."
    );
    el("backLink").hidden = true;
    return;
  }

  renderUnblocked();
}

// Nuclear mode can leave many tabs on this page at once; only the visible one
// needs to tick every second.
let timer = null;
function startPolling() {
  if (timer) return;
  tick();
  timer = setInterval(tick, 1000);
}
function stopPolling() {
  clearInterval(timer);
  timer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") startPolling();
  else stopPolling();
});

if (document.visibilityState === "visible") startPolling();
else tick();
