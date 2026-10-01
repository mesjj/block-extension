async function load() {
  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  } catch {
    return;
  }
  if (!state) return;
  const { settings } = state;
  document.getElementById("sites").value = settings.sites.join("\n");
  document.getElementById("allowedMinutes").value = settings.allowedMinutes;
  document.getElementById("windowHours").value = settings.windowHours;
}

document.getElementById("saveBtn").addEventListener("click", async () => {
  const sites = document
    .getElementById("sites")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedMinutes = Number(document.getElementById("allowedMinutes").value);
  const windowHours = Number(document.getElementById("windowHours").value);

  await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: { sites, allowedMinutes, windowHours },
  });

  const msg = document.getElementById("savedMsg");
  msg.classList.remove("hidden");
  setTimeout(() => msg.classList.add("hidden"), 1500);
  load();
});

load();
