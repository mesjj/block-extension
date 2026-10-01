function formatDuration(ms) {
  if (ms <= 0) return "0:00";
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatClock(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const btn = document.getElementById("nuclearBtn");
const IDLE_LABEL = "Block everything";
let armed = false;
let armedTimer = null;

function disarm() {
  armed = false;
  clearTimeout(armedTimer);
  btn.textContent = IDLE_LABEL;
  btn.classList.remove("armed");
}

async function refresh() {
  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  } catch {
    return; // service worker restarting
  }
  if (!state) return;
  const { settings, nuclear, remainingMs, windowEndsAt } = state;

  document.getElementById("remaining").textContent =
    settings.sites.length === 0 ? "no sites set" : formatDuration(remainingMs);
  document.getElementById("windowEnds").textContent = formatClock(windowEndsAt);
  document.getElementById("sitesList").textContent =
    settings.sites.length > 0
      ? `Tracking: ${settings.sites.join(", ")}`
      : "Add sites in settings to start tracking.";

  const idleBox = document.getElementById("nuclearIdle");
  const activeBox = document.getElementById("nuclearActive");
  if (nuclear.active) {
    idleBox.classList.add("hidden");
    activeBox.classList.remove("hidden");
    document.getElementById("nuclearRemaining").textContent = formatDuration(
      nuclear.endTime - Date.now()
    );
  } else {
    idleBox.classList.remove("hidden");
    activeBox.classList.add("hidden");
  }
}

document.getElementById("optionsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// Two-step inline confirm rather than confirm(): a modal dialog can steal
// focus from the popup, which closes it and drops the action silently.
btn.addEventListener("click", async () => {
  const amount = Number(document.getElementById("nuclearAmount").value) || 0;
  const unit = document.getElementById("nuclearUnit").value;
  if (amount <= 0) return;

  if (!armed) {
    armed = true;
    btn.textContent = `Confirm: block all for ${amount} ${unit}`;
    btn.classList.add("armed");
    armedTimer = setTimeout(disarm, 5000);
    return;
  }

  disarm();
  const durationMs = unit === "hours" ? amount * 3600000 : amount * 60000;
  try {
    await chrome.runtime.sendMessage({ type: "START_NUCLEAR", durationMs });
  } catch {}
  refresh();
});

document
  .getElementById("nuclearAmount")
  .addEventListener("input", disarm);
document.getElementById("nuclearUnit").addEventListener("change", disarm);

refresh();
setInterval(refresh, 1000);
