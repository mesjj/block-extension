# Focus Lock

A Manifest V3 browser extension (works in Brave, Chrome, and other
Chromium-based browsers) that:

- Limits a list of sites to **X minutes every Y hours**, repeating
  automatically all day (windows start at midnight: e.g. Y=2h → 00:00,
  02:00, 04:00, …). Once the budget for the current window is used, the
  sites redirect to a block page until the next window starts.
- Has a **nuclear option**: block every website for a chosen number of
  minutes/hours. Once started it **cannot be cancelled early** — that's
  the point of a commitment device. It ends automatically when the timer
  hits zero.

Time is only counted while a limited site is the active tab in the
focused window and the screen isn't locked — not while it's just open in a background tab.

The toolbar icon shows a badge whenever the current tab is on a
rate-limited site: the number of minutes left in the shared budget
(green, turning orange under 5 minutes, red at 0), or "×" when nuclear
mode has everything blocked. Hover the icon for details.

## Install in Brave

1. Open `brave://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder (`block-extension`)

The extension icon will appear in the toolbar. Click it to see status,
or click the gear icon to open Settings and add sites.

## Settings

- **Sites to limit**: one domain per line (e.g. `youtube.com`). Subdomains
  are covered automatically (`www.`, `old.`, etc.).
- **Budget**: minutes allowed per window, and the window length in hours.

When a page is blocked, the original URL is remembered. Once the block
lifts, the tab returns to where it was (or offers a "Back to …" link if
it's a background tab), so nuclear mode doesn't cost you your open tabs.

## Notes / limitations

- Blocking works by intercepting the page navigation (`main_frame`) for
  matching domains and redirecting to an internal block page — it does
  not block background API calls to the same domain from other sites.
- The nuclear option can't be turned off early from within the extension.
  Uninstalling the extension or disabling it in `brave://extensions` would
  still stop it — this is a self-control tool, not a parental-control-grade
  lock.
- All state is stored locally (`chrome.storage`); nothing leaves your
  browser.
