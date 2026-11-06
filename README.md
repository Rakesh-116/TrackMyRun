# TrackMyRun

A free, private, offline web app (PWA) for training for a 5K. No accounts, no analytics, no backend, no map tiles, and no network calls with your data. Everything is stored in your browser.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Layout and screens (Run, Log, Stats, Plan, Data) |
| `styles.css` | Theme tokens (light and dark), layout, big tap targets |
| `core.js` | Pure logic: Haversine, GPS filter, splits planner, Riegel, stats, report generation |
| `app.js` | DOM, GPS, timer, wake lock, vibration, rendering, downloads |
| `sw.js` | Service worker for offline use |
| `manifest.webmanifest`, `icon*.png/svg` | Install-to-home-screen metadata and icons |
| `vercel.json` | Vercel settings (clean URLs, no cache for the service worker) |

There is no build step: plain HTML, CSS and JavaScript.

## Run it locally

Geolocation needs `https://` or `localhost`, so do not double-click `index.html`. Start a small local server from this folder:

```powershell
cd c:\Users\RakeshPenugonda\Desktop\PP\TrackMyRun
python -m http.server 8080
```

Then open **http://localhost:8080** in Chrome or Edge. Press Ctrl+C in the terminal to stop it.

Only Python is needed. Any other static server works too, such as VS Code's "Live Server" extension.

## Deploy to Vercel (free)

The app is static files, so Vercel hosts it with no backend. Vercel gives you an `https://` address, so GPS works on your phone.

**Option A: GitHub (no command line needed)**

1. Create a GitHub repo and push this folder to it.
2. On vercel.com, sign in, click **Add New... > Project**, and import the repo.
3. Framework preset: **Other**. Build command: leave empty. Output directory: leave empty (the root is served).
4. Click **Deploy**. You get a URL like `https://trackmyrun-xxxx.vercel.app`.

Each push to GitHub redeploys automatically.

**Option B: Vercel CLI (needs Node.js)**

```powershell
npm i -g vercel
cd c:\Users\RakeshPenugonda\Desktop\PP\TrackMyRun
vercel          # first time: log in and answer the prompts
vercel --prod   # publish to the production URL
```

`vercel.json` stops the service worker from being cached, so updates reach users straight away.

### Your data does not move with the deploy

Each address has its own browser storage. Runs recorded on `localhost` stay on `localhost`, and runs on `vercel.app` stay in that browser. To carry them across:

1. On the local copy, open **Data > Full backup (.json)** to download a file.
2. On the Vercel site, open **Data > Backup and restore**, paste the file's contents, and press **Import (merge)**.

Import only adds runs that are not already there, so it is safe to repeat.

Export a backup now and then. Clearing browser data or switching browsers will otherwise lose your runs.

## Reports and downloads

Open the **Data** tab. Files are created in your browser and downloaded directly. Nothing is uploaded.

| File | Use it for |
| --- | --- |
| **Report (.md)** | Full readable report: summary, bests, predictions, strategy comparison, weekly distance, run log, splits. Opens in any text editor or Markdown viewer. |
| **Printable report (.html)** | The same report, styled for printing. Open it, choose Print, then Save as PDF. |
| **Runs (.csv)** | One row per run, for Excel or Google Sheets. |
| **Splits (.csv)** | One row per km split, for pacing analysis. |
| **Full backup (.json)** | Everything, for restoring or moving to another device. |

CSV files include a UTF-8 byte-order mark, so Excel shows accents and symbols correctly.

## Features

- **Run recorder:** goal 2, 3, 5 or 10 km; Even, Fast or Slow start; Start, Pause, Resume, Finish; live distance, current and average pace, projected finish, progress bar, live path, km splits, screen kept awake while running.
- **Clear GPS messages:** "GPS good" only at 30 m or better, "Weak GPS" for 30 to 1000 m, and "too rough (network only)" above 1 km (what a laptop shows). If location is blocked, the app says how to allow it.
- **Crash-safe draft:** the run in progress is saved about every 10 s and on every accepted GPS point. If the browser reloads or the tab is killed, the Run tab offers Resume, Save as run, or Discard.
- **Screen-lock warning:** if the page was hidden during a run and no GPS point arrived for more than 20 s, a warning says how long tracking may have paused. The missed time is never added as distance.
- **Voice announcements (off by default, Plan tab):** at each km the app says the split and total time. With a race target set, it also says how many seconds ahead or behind the plan you are (for runs at the race distance). It says "Goal reached" at the goal.
- **Race day (Plan tab):** race date, race distance, and target time. The Run tab shows the days to race and the target pace per km next to your live pace. The race date and target are included in backups and reports.
- **Log, Stats, Plan, Data:** manual entry, personal bests, Riegel predictions, strategy comparison, pace trend, weekly distance, race planner, and backup and reports (Markdown, printable HTML, CSV, JSON).

## Test on your phone (do this before race day)

1. Deploy to Vercel, then open the `https://` address in Chrome on your phone.
2. Tap Start. Allow the location prompt when it appears. Wait until the status says "GPS good" before you start running.
3. Walk a known distance outdoors, such as a 400 m track lap or a 1 km stretch measured on a map. Compare the app's distance with the real one. Within about 3 to 5% is normal for phone GPS.
4. Repeat once with the screen dimmed but on. Then switch to another app for about 30 seconds and come back. Check whether the lock warning appears and whether the distance is short.
5. Tap Finish, check the numbers, and save. Then export the Markdown report from the Data tab.
6. Optional: turn on voice announcements in the Plan tab, and set the race date and target. Check that you hear each km and the plan comparison.

If the distance reads short, or points drop, note when it happened (screen off, app switch, under trees) and report it.

## How the features work

- **GPS filter** (`GPS_RULES` in `core.js`):
  - Fixes with accuracy worse than 30 m are ignored.
  - Moves under 3 m are treated as jitter and add no distance.
  - Jumps implying more than 9 m/s are ignored. After 5 such fixes in a row, the app trusts the new position, which recovers from GPS dropouts.
  - Distance uses the Haversine formula.
- **Splits** are recorded when a whole km is crossed. Reaching the goal distance triggers a vibration.
- **Pause** freezes the clock and resets the filter, so the gap while paused does not add distance.
- **Planner:** Even is the same pace every km. Fast start moves the pace linearly from -10 s/km at the first km to +10 s/km at the last. Slow start is the reverse. Splits always sum to the target. Change the ramp in the Plan tab.
- **Predictions:** Riegel with exponent 1.06, from the run that predicts the fastest 5K (runs of 1.8 km or more).
- **Personal bests:** A measured time always beats an estimate. A 5 km time taken from a longer run with no split is an estimate and is marked "est.".
- **Data:** Stored in `localStorage` under the key `trackmyrun.v1`. Every access is wrapped in try/catch. If saved data cannot be read, the raw text is copied to a backup key before the app starts fresh.

## Known limits (be realistic on race day)

- **Background GPS:** Phones often pause location when the screen locks or the browser is in the background. Keep the screen on (the app requests a wake lock) and keep the tab open. If GPS drops, the timer keeps running, and you can enter the distance when you finish.
- **Accuracy:** Phone GPS can be off by several metres, so GPS distance can read 1 to 3% high or low, especially under trees or between buildings. Check against a known route or a treadmill.
- **Estimates:** Predictions and time-at-distance estimates are estimates, not guarantees.
- **Storage:** Data stays in one browser on one device (one address). Export a backup regularly. The unfinished-run draft lives in the same browser; clearing browser data removes it.
- **Browser support:** Voice needs a browser with speech synthesis (Chrome and Edge on Android and desktop). Screen wake lock needs Chrome or Edge on Android, and Safari on recent iOS. Where a feature is missing, the app hides it or falls back to working without it.

## Updating the app

Change the files, then bump `CACHE` in `sw.js` (for example to `trackmyrun-v2`). Pushing to GitHub or running `vercel --prod` redeploys it.

## Tests

`core.js` is pure logic with no DOM. The checks used during development covered the GPS filter, time parsing, the planner (sums and ramps), Riegel, personal bests, strategy stats, weekly totals, storage failure paths, and the CSV/Markdown/HTML report output. They can be reproduced by loading `core.js` in a page and calling `window.TMR`.
