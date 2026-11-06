/*
 * app.js — DOM, GPS, timer and rendering for TrackMyRun.
 * All calculations live in core.js (window.TMR). Nothing is sent over the network.
 */
(function () {
  'use strict';

  const C = window.TMR;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  // ---------- guarded storage & state ----------

  function getStorage() {
    try {
      return window.localStorage;
    } catch (e) {
      return null; // blocked by browser settings
    }
  }

  const storage = getStorage();
  const loaded = C.loadRuns(storage);
  let runs = loaded.runs;
  let settings = C.loadSettings(storage); // race date, target, distance, voice toggle
  let pendingDraft = null;                // unfinished run found at startup
  let lastDraftSave = 0;

  /** Saves all runs. Shows a message instead of throwing when storage fails. */
  function persist() {
    const ok = C.saveRuns(storage, runs);
    if (!ok) toast('Could not save. Storage may be full or blocked. Export a backup from the Data tab.');
    return ok;
  }

  /** Non-persistent preferences (theme) are also guarded. */
  const prefs = {
    get(key) {
      try { return storage ? storage.getItem('trackmyrun.' + key) : null; } catch (e) { return null; }
    },
    set(key, value) {
      try { if (storage) storage.setItem('trackmyrun.' + key, value); } catch (e) { /* ignore */ }
    }
  };

  // ---------- run session state (in memory while recording) ----------

  /** Fresh session. goal and strategy carry over from the previous session. */
  function freshSession(prev) {
    return {
      state: 'idle',                 // idle | running | paused | finished
      goal: prev ? prev.goal : 5,
      strategy: prev ? prev.strategy : 'even',
      date: null,
      accumulatedMs: 0,              // time already banked before the current running stretch
      startedAtPerf: 0,              // performance.now() when the current running stretch began
      distanceM: 0,
      path: [],                      // [lat, lon] accepted points
      splits: [],                    // {km, time (cumulative seconds)}
      nextKm: 1,
      samples: [],                   // {t (elapsed s), d (distance m)} for current pace
      watchId: null,
      hasFix: false,
      gpsFailed: false,
      goalReached: false,
      lastFixAt: 0,                  // wall-clock ms of the last accepted GPS point
      hiddenAt: 0,                   // wall-clock ms when the page was hidden during a run
      filter: C.createTrackFilter()
    };
  }

  let session = freshSession(null);
  let wakeLock = null;
  let tickerId = null;

  const elapsedSec = () =>
    (session.accumulatedMs + (session.state === 'running' ? performance.now() - session.startedAtPerf : 0)) / 1000;

  /** Pace over roughly the last 30 seconds of movement, or NaN. */
  function currentPaceSec(now) {
    const s = session.samples;
    if (s.length < 2) return NaN;
    const last = s[s.length - 1];
    if (now - last.t > 20) return NaN; // no recent fixes
    let first = s[0];
    for (const x of s) {
      if (last.t - x.t <= 30) { first = x; break; }
    }
    const dt = last.t - first.t;
    const dd = last.d - first.d;
    if (dt < 5 || dd < 5) return NaN;
    return dt / (dd / 1000);
  }

  // ---------- feedback helpers ----------

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) { /* not supported */ }
  }

  function setGpsStatus(text) {
    $('#gps-status').textContent = text;
  }

  // ---------- wake lock (keep screen on while running) ----------

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && session.state === 'running' && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        setWakeIndicator(true);
        wakeLock.addEventListener('release', () => { wakeLock = null; setWakeIndicator(false); });
      }
    } catch (e) {
      wakeLock = null; // unsupported or denied; the app still works
    }
  }

  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
    wakeLock = null;
    setWakeIndicator(false);
  }

  function setWakeIndicator(on) {
    $('#wake-indicator').hidden = !on;
  }

  // Hiding the page drops the wake lock and can pause GPS. Track both, and warn on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (session.state === 'running') {
        session.hiddenAt = Date.now();
        saveDraftNow();
      }
      return;
    }
    if (session.state !== 'running') return;
    requestWakeLock();
    if (session.hiddenAt) {
      const lastSeen = session.lastFixAt || session.hiddenAt;
      const gapSec = Math.round((Date.now() - lastSeen) / 1000);
      session.hiddenAt = 0;
      if (gapSec > 20) showLockWarning(gapSec);
    }
  });

  function showLockWarning(sec) {
    $('#lock-warning-text').textContent =
      `Tracking may have paused for ${sec} s while the screen was off. Distance may be short; you can correct it when saving.`;
    $('#lock-warning').hidden = false;
  }

  $('#lock-dismiss').addEventListener('click', () => { $('#lock-warning').hidden = true; });

  // ---------- GPS ----------

  function startGps() {
    if (session.watchId != null) return;
    if (!('geolocation' in navigator)) {
      session.gpsFailed = true;
      setGpsStatus('GPS is not supported in this browser. Timer only.');
      return;
    }
    session.watchId = navigator.geolocation.watchPosition(onFix, onGpsError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000
    });
  }

  function stopGps() {
    if (session.watchId != null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(session.watchId);
    }
    session.watchId = null;
  }

  function onGpsError(err) {
    if (err.code === 1) { // PERMISSION_DENIED
      session.gpsFailed = true;
      stopGps();
      setGpsStatus('Location is blocked. Allow location for this site (lock icon in the address bar), then reload. Timer only until then.');
    } else if (err.code === 2) {
      setGpsStatus('No GPS signal yet. Still trying...');
    } else {
      setGpsStatus('GPS timed out. Still trying...');
    }
    render();
  }

  /** Called for every position update from the browser. */
  function onFix(pos) {
    if (session.state !== 'running') return; // ignore fixes while paused, idle or finished
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    const res = session.filter.feed({ lat, lon, accuracy, t: pos.timestamp || Date.now() });

    if (!res.accepted) {
      if (res.reason === 'accuracy') setGpsStatus(C.gpsStatusFor(accuracy));
      return;
    }

    session.hasFix = true;
    session.gpsFailed = false;
    session.lastFixAt = Date.now();
    session.distanceM += res.distance;
    session.path.push([lat, lon]);

    const now = elapsedSec();
    session.samples.push({ t: now, d: session.distanceM });
    session.samples = session.samples.filter((x) => now - x.t <= 60); // keep last minute

    checkSplitsAndGoal(now);
    setGpsStatus(C.gpsStatusFor(accuracy));
    $('#track').innerHTML = pathSvg(session.path);
    render();
    saveDraftNow(); // every accepted point batch is saved, so a crash loses at most one fix
  }

  /** Records km splits as they are crossed, and announces the goal distance. */
  function checkSplitsAndGoal(now) {
    while (session.nextKm <= session.goal && session.distanceM >= session.nextKm * 1000) {
      const prevCum = session.splits.length ? session.splits[session.splits.length - 1].time : 0;
      session.splits.push({ km: session.nextKm, time: now });
      vibrate(150);
      toast(`Km ${session.nextKm}: ${C.fmtDuration(now)}`);
      speak(announcement(session.nextKm, now, now - prevCum));
      session.nextKm++;
    }
    if (!session.goalReached && session.distanceM >= session.goal * 1000) {
      session.goalReached = true;
      vibrate([300, 100, 300, 100, 300]);
      toast('Goal distance reached. Keep going or tap Finish.');
      speak('Goal reached.');
    }
  }

  // ---------- voice announcements (optional, off by default) ----------

  function speak(text) {
    if (!settings.voice || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    } catch (e) { /* speech unavailable on this device */ }
  }

  /** "Kilometre 2. Split 4 minutes 52 seconds. Total time 9 minutes 40 seconds. ..." */
  function announcement(km, cum, split) {
    let text = `Kilometre ${km}. Split ${C.spokenDuration(split)}. Total time ${C.spokenDuration(cum)}.`;
    const delta = C.planDeltaAt(settings, session.goal, session.strategy, km, cum);
    if (delta != null) {
      const secs = Math.round(Math.abs(delta));
      text += secs === 0 ? ' On plan.' : ` ${secs} seconds ${delta < 0 ? 'ahead of' : 'behind'} plan.`;
    }
    return text;
  }

  // ---------- crash-safe draft of the run in progress ----------

  /** Saves the run in progress. Storage failures are ignored; the run itself keeps going. */
  function saveDraftNow() {
    const d = C.makeDraft(session, elapsedSec(), Date.now());
    if (d) C.saveDraft(storage, d);
    lastDraftSave = Date.now();
  }

  function maybeSaveDraft() {
    if (Date.now() - lastDraftSave >= 10000) saveDraftNow();
  }

  function showDraftCard(d) {
    pendingDraft = d;
    $('#draft-text').textContent =
      `${(d.distanceM / 1000).toFixed(2)} km in ${C.fmtDuration(d.elapsedSec)}, goal ${d.goal} km, ` +
      `${d.strategy} start, last saved ${new Date(d.savedAt).toLocaleTimeString()}. ` +
      'Resume to keep recording, or save what you have.';
    $('#draft-card').hidden = false;
  }

  /** Puts the saved run back in the paused state. The user taps Resume to continue. */
  function restoreDraft(d) {
    session = freshSession(session);
    Object.assign(session, {
      state: 'paused',
      goal: d.goal,
      strategy: d.strategy,
      date: d.date,
      accumulatedMs: d.elapsedSec * 1000,
      distanceM: d.distanceM,
      path: d.path,
      splits: d.splits,
      nextKm: d.nextKm,
      goalReached: d.goalReached,
      hasFix: d.path.length > 0
    });
    pendingDraft = null;
    $('#draft-card').hidden = true;
    setGpsStatus('Restored an unfinished run (paused). Tap Resume to keep recording.');
    setSegments();
    $('#track').innerHTML = pathSvg(session.path);
    updateButtons();
    render();
  }

  // ---------- run controls ----------

  function start() {
    if (session.state === 'running' || session.state === 'finished') return;
    if (session.state === 'idle') session.date = C.localYmd(new Date());
    session.state = 'running';
    session.startedAtPerf = performance.now();
    session.filter.reset();
    session.samples = [];
    startGps();
    requestWakeLock();
    startTicker();
    setGpsStatus(session.hasFix ? 'Recording...' : 'Searching for GPS...');
    updateButtons();
    render();
  }

  /** Banks the running time so the clock stops. */
  function freezeClock() {
    session.accumulatedMs += performance.now() - session.startedAtPerf;
    session.startedAtPerf = 0;
  }

  function pause() {
    if (session.state !== 'running') return;
    freezeClock();
    session.state = 'paused';
    session.filter.reset(); // the pause gap must not count as distance
    session.samples = [];
    releaseWakeLock();
    stopTicker();
    saveDraftNow();
    setGpsStatus('Paused');
    updateButtons();
    render();
  }

  function finish() {
    if (session.state !== 'running' && session.state !== 'paused') return;
    if (session.state === 'running') freezeClock();
    session.state = 'finished';
    stopTicker();
    stopGps();
    releaseWakeLock();

    $('#fin-distance').value = (session.distanceM / 1000).toFixed(2);
    $('#fin-time').value = C.fmtDuration(elapsedSec());
    $('#fin-notes').value = '';
    $('#finish-panel').hidden = false;
    setGpsStatus(session.path.length ? 'Finished. Check the numbers, then save.' : 'Finished without GPS. Enter the distance, then save.');
    saveDraftNow();
    updateButtons();
    render();
    $('#finish-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function saveFinished(e) {
    e.preventDefault();
    const km = Number($('#fin-distance').value);
    const sec = C.parseDuration($('#fin-time').value);
    if (!(km > 0)) return toast('Distance must be greater than 0.');
    if (!(sec > 0)) return toast('Time not recognised. Use mm:ss or h:mm:ss.');

    const usedGps = session.path.length > 0;
    const run = C.normalizeRun({
      id: C.newId(),
      date: session.date || C.localYmd(new Date()),
      createdAt: Date.now(),
      distance: km * 1000,
      time: sec,
      goal: session.goal,
      strategy: session.strategy,
      notes: $('#fin-notes').value,
      source: usedGps ? 'gps' : 'manual',
      splits: usedGps ? session.splits : [],
      path: usedGps ? session.path.map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]) : []
    });
    if (!run) return toast('Could not save this run. Check the values.');

    runs.push(run);
    persist();
    resetSession();
    renderLog();
    renderStats();
    toast('Run saved.');
  }

  function discardRun() {
    if (session.state === 'idle') return;
    if (!confirm('Discard this run? It will not be saved.')) return;
    resetSession();
  }

  function resetSession() {
    stopTicker();
    stopGps();
    releaseWakeLock();
    session = freshSession(session);
    C.clearDraft(storage);
    $('#finish-panel').hidden = true;
    $('#lock-warning').hidden = true;
    $('#draft-card').hidden = true;
    $('#track').innerHTML = pathSvg([]);
    $('#gps-banner').hidden = true;
    setGpsStatus('Ready. Tap Start to begin.');
    updateButtons();
    render();
  }

  // ---------- ticker & rendering ----------

  function startTicker() {
    if (!tickerId) {
      tickerId = setInterval(() => {
        render();
        maybeSaveDraft(); // at most one draft write every 10 s, even with no GPS fixes
      }, 250);
    }
  }

  function stopTicker() {
    clearInterval(tickerId);
    tickerId = null;
  }

  function render() {
    const el = elapsedSec();
    const km = session.distanceM / 1000;
    const now = el;

    $('#timer').textContent = C.fmtDuration(el);
    $('#m-dist').textContent = km.toFixed(2);
    $('#m-avg').textContent = km >= 0.02 ? C.fmtPace(el / km) : '--:--';
    $('#m-pace').textContent = C.fmtPace(session.state === 'running' ? currentPaceSec(now) : NaN);
    $('#m-proj').textContent = km >= 0.05 ? C.fmtDuration((el / km) * session.goal) : '--:--';
    $('#progress-bar').style.width = Math.min(100, (km / session.goal) * 100) + '%';

    const noGpsYet = !session.hasFix && el > 60;
    const showBanner = (session.state === 'running' || session.state === 'paused') && (session.gpsFailed || noGpsYet);
    $('#gps-banner').hidden = !showBanner;

    renderSplits();
    updateRaceInfo();
  }

  /** Race countdown and the target pace next to the live pace. */
  function updateRaceInfo() {
    const pace = C.raceTargetPace(settings);
    $('#m-target').textContent = Number.isFinite(pace) ? `target ${C.fmtPace(pace)}` : '';
    const cd = $('#race-countdown');
    const days = C.daysUntil(settings.raceDate);
    cd.hidden = days == null;
    if (days != null) {
      cd.textContent = days > 0
        ? `${days} day${days === 1 ? '' : 's'} to race`
        : days === 0 ? 'Race day. Good luck!' : 'Race date has passed';
    }
  }

  function renderSplits() {
    const ul = $('#splits');
    ul.innerHTML = '';
    if (!session.splits.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'Splits appear at each km.';
      ul.appendChild(li);
      return;
    }
    let prev = 0;
    session.splits.forEach((s) => {
      const li = document.createElement('li');
      li.textContent = `Km ${s.km}: ${C.fmtDuration(s.time)} (split ${C.fmtPace(s.time - prev)}/km)`;
      prev = s.time;
      ul.appendChild(li);
    });
  }

  function updateButtons() {
    const s = session.state;
    const primary = $('#btn-primary');
    primary.textContent = s === 'running' ? 'Pause' : s === 'paused' ? 'Resume' : 'Start';
    primary.className = 'btn ' + (s === 'running' ? 'btn-warn' : 'btn-primary');
    primary.disabled = s === 'finished';
    $('#btn-finish').disabled = !(s === 'running' || s === 'paused');
    $$('#seg-goal button, #seg-strategy button').forEach((b) => (b.disabled = s !== 'idle'));
  }

  function setSegments() {
    $$('#seg-goal button').forEach((b) =>
      b.setAttribute('aria-pressed', String(Number(b.dataset.goal) === session.goal)));
    $$('#seg-strategy button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.strategy === session.strategy)));
  }

  /**
   * Draws the path as an SVG polyline, scaled to fit. No map tiles, so no
   * third party gets location data. Longitude is scaled by cos(latitude).
   */
  function pathSvg(points, cls) {
    const W = 300, H = 300, pad = 18;
    const klass = cls ? ` class="${cls}"` : '';
    if (!points || points.length < 2) {
      return `<svg viewBox="0 0 ${W} ${H}"${klass} role="img" aria-label="No path yet"><text x="150" y="150" text-anchor="middle" class="axis">No path yet</text></svg>`;
    }
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    points.forEach(([la, lo]) => {
      minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la);
      minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo);
    });
    const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const w = (maxLon - minLon) * kx || 1e-9;
    const h = (maxLat - minLat) || 1e-9;
    const scale = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
    const offX = (W - w * scale) / 2;
    const offY = (H - h * scale) / 2;
    const xy = ([la, lo]) => [offX + (lo - minLon) * kx * scale, offY + (maxLat - la) * scale];
    const pts = points.map(xy).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const [sx, sy] = xy(points[0]);
    const [ex, ey] = xy(points[points.length - 1]);
    return `<svg viewBox="0 0 ${W} ${H}"${klass} role="img" aria-label="Run path">` +
      `<polyline points="${pts}" class="path-line"/>` +
      `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="6" class="dot-start"/>` +
      `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="6" class="dot-end"/>` +
      `</svg>`;
  }

  // ---------- session log ----------

  function runCardHtml(r) {
    const km = C.runKm(r);
    const splits = r.splits.length
      ? `<ul class="splits small">${(() => {
          let prev = 0;
          return r.splits.map((s) => {
            const li = `<li>Km ${s.km}: ${C.fmtDuration(s.time)} (split ${C.fmtPace(s.time - prev)}/km)</li>`;
            prev = s.time;
            return li;
          }).join('');
        })()}</ul>`
      : '';
    const thumb = r.path.length > 1 ? `<div class="thumb">${pathSvg(r.path)}</div>` : '';
    return `<article class="card run" data-id="${esc(r.id)}">
      <div class="run-head">
        <strong>${esc(r.date)}</strong>
        <span class="badge">${r.source === 'gps' ? 'GPS' : 'Manual'}</span>
        <span class="badge">Goal ${r.goal ? r.goal + ' km' : 'n/a'}</span>
        <span class="badge">${esc(r.strategy)}</span>
      </div>
      <div class="run-body">
        <div class="run-stats">
          <div><span class="m-value">${km.toFixed(2)}</span> <span class="m-unit">km</span></div>
          <div><span class="m-value">${C.fmtDuration(r.time)}</span> <span class="m-unit">total</span></div>
          <div><span class="m-value">${C.fmtPace(C.runPace(r))}</span> <span class="m-unit">/km avg</span></div>
        </div>
        ${thumb}
      </div>
      ${splits}
      ${r.notes ? `<p class="notes">${esc(r.notes)}</p>` : ''}
      <div class="run-actions"><button type="button" class="btn btn-danger" data-delete="${esc(r.id)}">Delete</button></div>
    </article>`;
  }

  function renderLog() {
    const host = $('#history');
    const list = runs.slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    host.innerHTML = list.length
      ? list.map(runCardHtml).join('')
      : '<p class="muted">No runs yet. Record one on the Run tab, or add a manual run above.</p>';
  }

  $('#history').addEventListener('click', (e) => {
    const id = e.target.dataset && e.target.dataset.delete;
    if (!id) return;
    if (!confirm('Delete this run? This cannot be undone.')) return;
    runs = runs.filter((r) => r.id !== id);
    persist();
    renderLog();
    renderStats();
  });

  // ---------- stats ----------

  function renderStats() {
    const pbs = C.personalBests(runs);
    $('#pb-grid').innerHTML = [2, 3, 5, 10].map((k) => {
      const b = pbs[k];
      const sub = b ? `${b.estimated ? 'est. · ' : ''}${esc(b.date)}` : 'no run yet';
      return `<div class="card metric"><span class="m-label">${k} km best</span>` +
        `<span class="m-value">${b ? C.fmtDuration(b.time) : '--'}</span>` +
        `<span class="m-unit">${sub}</span></div>`;
    }).join('');

    const p = C.predictFromBestRun(runs);
    $('#predict').innerHTML = p
      ? `<div class="grid2">
          <div class="metric"><span class="m-label">Predicted 5K</span>
            <span class="m-value">${C.fmtDuration(p.p5)}</span>
            <span class="m-unit">${C.fmtPace(p.p5 / 5)} /km</span></div>
          <div class="metric"><span class="m-label">Predicted 10K</span>
            <span class="m-value">${C.fmtDuration(p.p10)}</span>
            <span class="m-unit">${C.fmtPace(p.p10 / 10)} /km</span></div>
        </div>
        <p class="muted small">Based on ${C.runKm(p.run).toFixed(2)} km in ${C.fmtDuration(p.run.time)} on ${esc(p.run.date)}.</p>`
      : '<p class="muted">Log a run of 1.8 km or more to see predictions.</p>';

    const ss = C.strategyStats(runs);
    const labels = { even: 'Even', fast: 'Fast start', slow: 'Slow start' };
    $('#strategy-table').innerHTML = `<table>
      <thead><tr><th>Strategy</th><th>Runs</th><th>Avg /km</th><th>Best /km</th></tr></thead>
      <tbody>${['even', 'fast', 'slow'].map((s) => `<tr>
        <td>${labels[s]}</td><td>${ss[s].runs}</td>
        <td>${C.fmtPace(ss[s].avgPace)}</td><td>${C.fmtPace(ss[s].bestPace)}</td></tr>`).join('')}
      </tbody></table>`;

    $('#trend').innerHTML = trendSvg(C.paceTrend(runs));
    $('#weekly').innerHTML = weeklySvg(C.weeklyKm(runs, 12));
  }

  function trendSvg(points) {
    if (points.length < 2) return '<p class="muted">Log at least 2 runs of 1.8 km or more to see the trend.</p>';
    const W = 320, H = 170, P = 30;
    const paces = points.map((p) => p.pace);
    const lo = Math.min(...paces) - 10;
    const hi = Math.max(...paces) + 10;
    const x = (i) => P + ((W - 2 * P) * i) / (points.length - 1);
    const y = (v) => P + ((H - 2 * P) * (v - lo)) / (hi - lo);
    const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.pace).toFixed(1)}`).join(' ');
    const dots = points.map((p, i) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(p.pace).toFixed(1)}" r="3.5"><title>${esc(p.date)}: ${C.fmtPace(p.pace)} /km</title></circle>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Pace trend">
      <polyline points="${line}" class="line"/>${dots}
      <text x="2" y="${P + 4}" class="axis">${C.fmtPace(lo + 10)}</text>
      <text x="2" y="${H - P + 4}" class="axis">${C.fmtPace(hi - 10)}</text>
      <text x="${P}" y="${H - 6}" class="axis">${esc(points[0].date.slice(5))}</text>
      <text x="${W - P}" y="${H - 6}" text-anchor="end" class="axis">${esc(points[points.length - 1].date.slice(5))}</text>
    </svg>`;
  }

  function weeklySvg(weeks) {
    const W = 320, H = 170, P = 14, base = H - 26;
    const max = Math.max(1, ...weeks.map((w) => w.km));
    const bw = (W - 2 * P) / weeks.length;
    const bars = weeks.map((w, i) => {
      const h = ((base - P - 14) * w.km) / max;
      const x = P + i * bw + 3;
      const y = base - h;
      const label = w.km > 0
        ? `<text x="${(x + (bw - 6) / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" class="axis">${w.km.toFixed(1)}</text>`
        : '';
      const tick = i % 3 === 0
        ? `<text x="${(x + (bw - 6) / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="axis">${esc(w.week.slice(5))}</text>`
        : '';
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${h.toFixed(1)}" rx="3" class="bar"><title>Week of ${esc(w.week)}: ${w.km.toFixed(1)} km</title></rect>${label}${tick}`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Weekly distance">
      <line x1="${P}" y1="${base}" x2="${W - P}" y2="${base}" class="axis-line"/>${bars}</svg>`;
  }

  // ---------- race planner ----------

  function renderPlan() {
    const D = Number($('#plan-dist').value);
    const T = C.parseDuration($('#plan-target').value);
    const delta = Number($('#plan-delta').value);
    const out = $('#plan-out');
    if (!(D > 0) || !(T > 0)) {
      out.innerHTML = '<p class="muted">Enter a distance and a target time, such as 25:00.</p>';
      return;
    }
    const rows = C.buildPlan(D, T, $('#plan-strategy').value, Number.isFinite(delta) ? delta : C.DEFAULT_RAMP_S);
    out.innerHTML = `<p class="muted small">Average ${C.fmtPace(T / D)} /km for ${D} km in ${C.fmtDuration(T)}.</p>
      <div class="table-wrap"><table class="plan">
        <thead><tr><th>Km</th><th>Split</th><th>Pace /km</th><th>Total</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${r.km}${r.segmentKm < 1 ? ` <span class="muted">(${r.segmentKm.toFixed(2)} km)</span>` : ''}</td>
          <td>${C.fmtDuration(r.splitSec)}</td>
          <td>${C.fmtPace(r.paceSec)}</td>
          <td>${C.fmtDuration(r.cumSec)}</td></tr>`).join('')}
        </tbody></table></div>`;
  }

  // ---------- manual entry ----------

  $('#manual-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const km = Number($('#man-distance').value);
    const sec = C.parseDuration($('#man-time').value);
    if (!(km > 0)) return toast('Distance must be greater than 0.');
    if (!(sec > 0)) return toast('Time not recognised. Use mm:ss or h:mm:ss.');
    const run = C.normalizeRun({
      id: C.newId(),
      date: $('#man-date').value,
      createdAt: Date.now(),
      distance: km * 1000,
      time: sec,
      goal: Number($('#man-goal').value),
      strategy: $('#man-strategy').value,
      notes: $('#man-notes').value,
      source: 'manual'
    });
    if (!run) return toast('Check the date and values.');
    runs.push(run);
    persist();
    e.target.reset();
    setDefaultManualDate();
    renderLog();
    renderStats();
    toast('Run added.');
  });

  function setDefaultManualDate() {
    $('#man-date').value = C.localYmd(new Date());
  }

  // ---------- data: backup & restore ----------

  function renderDataStatus() {
    $('#storage-status').textContent = !storage
      ? 'Browser storage is blocked. Runs cannot be saved on this device. Export often.'
      : loaded.ok
        ? `${runs.length} run(s) stored on this device.`
        : 'Saved data could not be read, so a backup copy was kept. Starting fresh.';
  }

  /** Creates a file in the browser and downloads it. Nothing is uploaded. */
  function download(filename, mime, text) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function stamp() {
    return C.localYmd(new Date());
  }

  function requireRuns() {
    if (!runs.length) {
      toast('No runs yet. Record or add a run first.');
      return false;
    }
    return true;
  }

  $('#dl-report-md').addEventListener('click', () => {
    if (!requireRuns()) return;
    const md = C.reportToMarkdown(C.buildReport(runs, new Date(), settings));
    download(`trackmyrun-report-${stamp()}.md`, 'text/markdown;charset=utf-8', md);
  });

  $('#dl-report-html').addEventListener('click', () => {
    if (!requireRuns()) return;
    const html = C.reportToHtml(C.buildReport(runs, new Date(), settings));
    download(`trackmyrun-report-${stamp()}.html`, 'text/html;charset=utf-8', html);
  });

  // The BOM (﻿) makes Excel read UTF-8 characters (accents, the ± sign) correctly.
  $('#dl-runs-csv').addEventListener('click', () => {
    if (!requireRuns()) return;
    download(`trackmyrun-runs-${stamp()}.csv`, 'text/csv;charset=utf-8', '﻿' + C.runsToCsv(runs));
  });

  $('#dl-splits-csv').addEventListener('click', () => {
    if (!requireRuns()) return;
    download(`trackmyrun-splits-${stamp()}.csv`, 'text/csv;charset=utf-8', '﻿' + C.splitsToCsv(runs));
  });

  $('#dl-backup-json').addEventListener('click', () => {
    download(`trackmyrun-backup-${stamp()}.json`, 'application/json', C.exportJson(runs, settings));
  });

  $('#btn-export').addEventListener('click', () => {
    $('#data-text').value = C.exportJson(runs, settings);
    toast(`Exported ${runs.length} run(s). Copy it somewhere safe.`);
  });

  $('#btn-copy').addEventListener('click', async () => {
    const ta = $('#data-text');
    if (!ta.value) return toast('Export first, then copy.');
    try {
      await navigator.clipboard.writeText(ta.value);
      toast('Copied.');
    } catch (e) {
      ta.focus();
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
      toast(ok ? 'Copied.' : 'Select the text and copy it manually.');
    }
  });

  $('#btn-import').addEventListener('click', () => {
    const res = C.importJson($('#data-text').value);
    if (res.error) return toast(res.error);
    const merged = C.mergeRuns(runs, res.runs);
    runs = merged.runs;
    persist();
    if (res.settings) {
      settings = res.settings;
      C.saveSettings(storage, settings);
      renderSettings();
    }
    renderAll();
    toast(`Imported ${merged.added} new run(s)${res.skipped ? `, skipped ${res.skipped} invalid` : ''}.`);
  });

  $('#btn-clear').addEventListener('click', () => {
    if (!confirm(`Delete all ${runs.length} run(s) stored on this device? Export a backup first.`)) return;
    runs = [];
    persist();
    renderAll();
    toast('All runs deleted.');
  });

  // ---------- race day & voice settings (Plan tab) ----------

  function renderSettings() {
    $('#set-race-date').value = settings.raceDate;
    $('#set-race-dist').value = String(settings.raceDistanceKm);
    $('#set-race-target').value = settings.raceTargetSec ? C.fmtDuration(settings.raceTargetSec) : '';
    $('#set-voice').checked = settings.voice;
    $('#voice-row').hidden = !('speechSynthesis' in window);
    updateRaceInfo();
  }

  function changeSettings(patch) {
    settings = C.normalizeSettings(Object.assign({}, settings, patch));
    if (!C.saveSettings(storage, settings)) toast('Could not save settings on this device.');
    updateRaceInfo();
  }

  $('#set-race-date').addEventListener('change', (e) => changeSettings({ raceDate: e.target.value }));
  $('#set-race-dist').addEventListener('change', (e) => changeSettings({ raceDistanceKm: Number(e.target.value) }));
  $('#set-race-target').addEventListener('change', (e) => {
    const raw = e.target.value.trim();
    if (!raw) {
      changeSettings({ raceTargetSec: 0 });
    } else {
      const sec = C.parseDuration(raw);
      if (!(sec > 0)) {
        toast('Target not recognised. Use mm:ss, for example 25:00.');
      } else {
        changeSettings({ raceTargetSec: sec });
      }
    }
    renderSettings();
  });
  $('#set-voice').addEventListener('change', (e) => {
    changeSettings({ voice: e.target.checked });
    if (e.target.checked) speak('Voice announcements are on.');
  });

  // ---------- unfinished-run card ----------

  $('#draft-resume').addEventListener('click', () => { if (pendingDraft) restoreDraft(pendingDraft); });

  $('#draft-save').addEventListener('click', () => {
    if (!pendingDraft) return;
    restoreDraft(pendingDraft);
    finish(); // opens the save panel with the restored distance and time
    toast('Check the numbers, then save the run.');
  });

  $('#draft-discard').addEventListener('click', () => {
    if (!confirm('Discard the unfinished run? It will not be saved.')) return;
    C.clearDraft(storage);
    pendingDraft = null;
    $('#draft-card').hidden = true;
  });

  // ---------- navigation, theme, wiring ----------

  function showView(name) {
    $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + name));
    $$('.tabbar button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === name)));
    if (name === 'log') renderLog();
    if (name === 'stats') renderStats();
    if (name === 'data') renderDataStatus();
    window.scrollTo(0, 0);
  }

  function renderAll() {
    renderLog();
    renderStats();
    renderDataStatus();
  }

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
  }

  function currentTheme() {
    const explicit = document.documentElement.getAttribute('data-theme');
    return explicit === 'light' ? 'light' : 'dark';
  }

  $('#btn-theme').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    prefs.set('theme', next);
  });

  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  $('#seg-goal').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || session.state !== 'idle') return;
    session.goal = Number(b.dataset.goal);
    setSegments();
    render();
  });

  $('#seg-strategy').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || session.state !== 'idle') return;
    session.strategy = b.dataset.strategy;
    setSegments();
  });

  $('#btn-primary').addEventListener('click', () => (session.state === 'running' ? pause() : start()));
  $('#btn-finish').addEventListener('click', finish);
  $('#finish-panel').addEventListener('submit', saveFinished);
  $('#btn-discard').addEventListener('click', discardRun);

  ['#plan-dist', '#plan-target', '#plan-strategy', '#plan-delta'].forEach((sel) =>
    $(sel).addEventListener('input', renderPlan));

  // ---------- init ----------

  function init() {
    const savedTheme = prefs.get('theme');
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(savedTheme || (prefersLight ? 'light' : 'dark'));

    setDefaultManualDate();
    setSegments();
    $('#track').innerHTML = pathSvg([]);
    renderPlan();
    renderAll();
    renderSettings();
    updateButtons();
    render();

    // An unfinished run from before a crash, reload or tab close.
    const draft = C.loadDraft(storage);
    if (draft) showDraftCard(draft);

    if (!loaded.ok && loaded.reason === 'corrupt') {
      toast('Saved data was unreadable. A backup copy was kept.');
    } else if (!storage) {
      toast('Browser storage is blocked. Runs will not be saved.');
    }

    // Offline support. Service workers need https or localhost.
    if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* app works without it */ });
    }
  }

  init();
})();
