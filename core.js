/*
 * core.js — pure logic for TrackMyRun. No DOM access, no network.
 *
 * Contains: Haversine distance, GPS point filter, time formatting/parsing,
 * race split planner, Riegel prediction, stats, and local storage helpers.
 * Works in the browser (exposes window.TMR) and in Node (module.exports),
 * so it can be unit-tested without a browser.
 */
(function () {
  'use strict';

  const EARTH_RADIUS_M = 6371000;

  /** Tunable GPS rules. Change these to adjust how strictly points are filtered. */
  const GPS_RULES = {
    maxAccuracyM: 30,   // ignore fixes whose reported accuracy is worse than this
    minMoveM: 3,        // moves smaller than this are GPS jitter and add no distance
    maxSpeedMps: 9,     // a jump implying more than this speed is treated as bad data
    reanchorAfter: 5    // after this many speed rejections in a row, trust the new fix
  };

  const RIEGEL_EXPONENT = 1.06;
  const MIN_RUN_KM_FOR_STATS = 1.8; // shorter runs are excluded from strategy/prediction stats
  const STRATEGIES = ['even', 'fast', 'slow'];
  const GOALS_KM = [2, 3, 5, 10];
  const DEFAULT_RAMP_S = 10;        // planner: seconds/km the pace shifts at the ends
  const STORAGE_KEY = 'trackmyrun.v1';

  // ---------- distance ----------

  const toRad = (d) => (d * Math.PI) / 180;

  /** Great-circle distance in metres between two lat/lon points (Haversine). */
  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /**
   * Stateful GPS filter. feed({lat, lon, accuracy, t}) with t in epoch ms.
   * Returns { accepted, reason, distance } where distance is metres to add.
   * Call reset() on pause/resume so a pause gap does not count as distance.
   */
  function createTrackFilter(rules) {
    const cfg = { ...GPS_RULES, ...(rules || {}) };
    let last = null;
    let speedRejects = 0;

    const reject = (reason) => ({ accepted: false, reason, distance: 0 });

    return {
      reset() {
        last = null;
        speedRejects = 0;
      },
      feed(p) {
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return reject('invalid');
        if (!(p.accuracy <= cfg.maxAccuracyM)) return reject('accuracy'); // also catches undefined/NaN
        if (!last) {
          last = p;
          return { accepted: true, reason: 'anchor', distance: 0 };
        }
        const d = haversine(last.lat, last.lon, p.lat, p.lon);
        if (d < cfg.minMoveM) return reject('jitter');

        const dt = (p.t - last.t) / 1000;
        if (dt > 0 && d / dt > cfg.maxSpeedMps) {
          speedRejects++;
          if (speedRejects < cfg.reanchorAfter) return reject('speed');
          // Many consecutive "too fast" fixes usually means our anchor is stale
          // (GPS was lost and re-acquired). Re-anchor without adding distance.
          last = p;
          speedRejects = 0;
          return { accepted: true, reason: 'reanchor', distance: 0 };
        }
        speedRejects = 0;
        last = p;
        return { accepted: true, reason: 'ok', distance: d };
      }
    };
  }

  // ---------- formatting & parsing ----------

  const pad2 = (n) => (n < 10 ? '0' : '') + n;

  /** Seconds -> "5:03" or "1:02:05". */
  function fmtDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '--:--';
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(r)}` : `${m}:${pad2(r)}`;
  }

  /** Pace in seconds per km -> "5:00". */
  function fmtPace(secPerKm) {
    if (!Number.isFinite(secPerKm) || secPerKm <= 0) return '--:--';
    return fmtDuration(secPerKm);
  }

  /**
   * Parses "mm:ss", "h:mm:ss", or a plain number (read as minutes).
   * Returns seconds, or NaN if the input is not valid.
   */
  function parseDuration(str) {
    const s = String(str == null ? '' : str).trim();
    if (!s) return NaN;
    const parts = s.split(':').map((x) => x.trim());
    if (!parts.every((x) => /^\d+(\.\d+)?$/.test(x))) return NaN;
    const n = parts.map(Number);
    if (n.length === 1) return n[0] * 60;
    if (n.length === 2) return n[1] >= 60 ? NaN : n[0] * 60 + n[1];
    if (n.length === 3) return n[1] >= 60 || n[2] >= 60 ? NaN : n[0] * 3600 + n[1] * 60 + n[2];
    return NaN;
  }

  // ---------- dates & ids ----------

  /** Local calendar date of a Date object as "YYYY-MM-DD". */
  function localYmd(dt) {
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }

  /** Monday of the week containing a "YYYY-MM-DD" date, as "YYYY-MM-DD". */
  function weekStart(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    return localYmd(dt);
  }

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ---------- race planner ----------

  /**
   * Per-km split plan whose splits sum exactly to targetSec.
   * 'even': same pace every km.
   * 'fast': pace shifts from -deltaS (first km) to +deltaS (last km).
   * 'slow': the reverse.
   * Partial final km (e.g. 5.5 km) is handled by its length.
   */
  function buildPlan(distanceKm, targetSec, strategy, deltaS) {
    const D = Number(distanceKm);
    const T = Number(targetSec);
    if (!(D > 0) || !(T > 0)) return [];
    const delta = deltaS == null ? DEFAULT_RAMP_S : Number(deltaS);
    const n = Math.ceil(D - 1e-9);
    const sign = strategy === 'fast' ? -1 : strategy === 'slow' ? 1 : 0;
    const basePace = T / D; // seconds per km

    const lens = [];
    const raw = [];
    for (let i = 0; i < n; i++) {
      const len = Math.min(1, D - i);
      const ramp = n <= 1 ? 0 : 1 - (2 * i) / (n - 1); // +1 first km ... -1 last km
      lens.push(len);
      raw.push((basePace + sign * delta * ramp) * len);
    }
    // Scale so the splits add up to the target exactly.
    const scale = T / raw.reduce((a, b) => a + b, 0);
    let cum = 0;
    return lens.map((len, i) => {
      const split = raw[i] * scale;
      cum += split;
      return { km: i + 1, segmentKm: len, splitSec: split, paceSec: split / len, cumSec: cum };
    });
  }

  // ---------- predictions & stats ----------

  /** Riegel: predicted time for toKm, given a time over fromKm. */
  const riegel = (timeSec, fromKm, toKm) => timeSec * Math.pow(toKm / fromKm, RIEGEL_EXPONENT);

  const runKm = (run) => run.distance / 1000;
  const runPace = (run) => run.time / runKm(run); // seconds per km

  /**
   * Time to cover k km within a run. Uses recorded km splits when present,
   * the run time for a run of exactly k km, or a pro-rated estimate for a
   * longer run without splits (flagged estimated). Returns null if not covered.
   */
  function timeAtKm(run, k) {
    const target = k * 1000;
    const sp = (run.splits || []).find((s) => s.km === k);
    if (sp) return { time: sp.time, estimated: false };
    if (Math.abs(run.distance - target) <= target * 0.01) return { time: run.time, estimated: false };
    if (run.distance > target) return { time: (run.time * target) / run.distance, estimated: true };
    return null;
  }

  /**
   * Best time per goal distance: { 2: {time, estimated, runId, date} | null, ... }.
   * A measured time always beats an estimate, even if the estimate is faster.
   */
  function personalBests(runs) {
    const out = {};
    GOALS_KM.forEach((k) => {
      let exact = null;
      let est = null;
      runs.forEach((r) => {
        const t = timeAtKm(r, k);
        if (!t) return;
        const cand = { time: t.time, estimated: t.estimated, runId: r.id, date: r.date };
        if (t.estimated) {
          if (!est || cand.time < est.time) est = cand;
        } else if (!exact || cand.time < exact.time) {
          exact = cand;
        }
      });
      out[k] = exact || est;
    });
    return out;
  }

  /**
   * Predicts 5K and 10K from the run that gives the fastest predicted 5K
   * (runs of MIN_RUN_KM_FOR_STATS km or more). Returns null if none qualify.
   */
  function predictFromBestRun(runs) {
    let best = null;
    runs
      .filter((r) => runKm(r) >= MIN_RUN_KM_FOR_STATS && r.time > 0)
      .forEach((r) => {
        const p5 = riegel(r.time, runKm(r), 5);
        if (!best || p5 < best.p5) {
          best = { run: r, p5, p10: riegel(r.time, runKm(r), 10) };
        }
      });
    return best;
  }

  /** Average and best pace per start strategy, using runs >= MIN_RUN_KM_FOR_STATS. */
  function strategyStats(runs) {
    const acc = {};
    STRATEGIES.forEach((s) => (acc[s] = { runs: 0, sum: 0, best: Infinity }));
    runs.forEach((r) => {
      if (runKm(r) < MIN_RUN_KM_FOR_STATS || !acc[r.strategy]) return;
      const p = runPace(r);
      const a = acc[r.strategy];
      a.runs++;
      a.sum += p;
      a.best = Math.min(a.best, p);
    });
    const out = {};
    STRATEGIES.forEach((s) => {
      const a = acc[s];
      out[s] = {
        runs: a.runs,
        avgPace: a.runs ? a.sum / a.runs : null,
        bestPace: a.runs ? a.best : null
      };
    });
    return out;
  }

  /** Total km per week for the last `weeks` weeks (oldest first). */
  function weeklyKm(runs, weeks) {
    const totals = {};
    runs.forEach((r) => {
      const k = weekStart(r.date);
      totals[k] = (totals[k] || 0) + runKm(r);
    });
    const [y, m, d] = weekStart(localYmd(new Date())).split('-').map(Number);
    const out = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const key = localYmd(new Date(y, m - 1, d - 7 * i));
      out.push({ week: key, km: totals[key] || 0 });
    }
    return out;
  }

  /** Pace over time for runs >= MIN_RUN_KM_FOR_STATS, oldest first. */
  function paceTrend(runs) {
    return runs
      .filter((r) => runKm(r) >= MIN_RUN_KM_FOR_STATS)
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt)
      .map((r) => ({ id: r.id, date: r.date, pace: runPace(r) }));
  }

  // ---------- data validation & storage ----------

  /** Validates and cleans a run object. Returns a clean run, or null if unusable. */
  function normalizeRun(r) {
    if (!r || typeof r !== 'object') return null;
    const distance = Number(r.distance);
    const time = Number(r.time);
    if (!(distance > 0) || !(time > 0)) return null;
    if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return null;
    const goal = Number(r.goal);
    const path = Array.isArray(r.path)
      ? r.path
          .filter((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
          .map((p) => [Number(p[0]), Number(p[1])])
      : [];
    const splits = Array.isArray(r.splits)
      ? r.splits
          .filter((s) => s && Number(s.km) > 0 && Number(s.time) > 0)
          .map((s) => ({ km: Number(s.km), time: Number(s.time) }))
      : [];
    return {
      id: typeof r.id === 'string' && r.id ? r.id : newId(),
      date: r.date,
      createdAt: Number(r.createdAt) || Date.now(),
      distance,
      time,
      goal: GOALS_KM.includes(goal) ? goal : null,
      strategy: STRATEGIES.includes(r.strategy) ? r.strategy : 'even',
      notes: String(r.notes || '').slice(0, 500),
      source: r.source === 'gps' ? 'gps' : 'manual',
      splits,
      path
    };
  }

  /**
   * Loads runs from a Storage-like object. Never throws.
   * If the saved data is unreadable, it is copied to a backup key first.
   */
  function loadRuns(storage) {
    if (!storage) return { runs: [], ok: false, reason: 'unavailable' };
    let raw;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch (e) {
      return { runs: [], ok: false, reason: 'unavailable' };
    }
    if (!raw) return { runs: [], ok: true };
    try {
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : (data && data.runs) || [];
      return { runs: list.map(normalizeRun).filter(Boolean), ok: true };
    } catch (e) {
      try {
        storage.setItem(`${STORAGE_KEY}.corrupt-${Date.now()}`, raw);
      } catch (_) {
        /* ignore: backup is best-effort */
      }
      return { runs: [], ok: false, reason: 'corrupt' };
    }
  }

  /** Saves runs to a Storage-like object. Returns true on success. Never throws. */
  function saveRuns(storage, runs) {
    if (!storage) return false;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, runs }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function exportJson(runs, settings) {
    return JSON.stringify(
      { app: 'TrackMyRun', version: 1, exportedAt: new Date().toISOString(), settings: normalizeSettings(settings), runs },
      null,
      2
    );
  }

  /** Parses backup text. Returns { runs, skipped } or { error }. */
  function importJson(text) {
    let data;
    try {
      data = JSON.parse(String(text || ''));
    } catch (e) {
      return { error: 'That is not valid backup text.' };
    }
    const list = Array.isArray(data) ? data : data && data.runs;
    if (!Array.isArray(list)) return { error: 'No runs found in that text.' };
    const runs = list.map(normalizeRun).filter(Boolean);
    const settings = !Array.isArray(data) && data && data.settings ? normalizeSettings(data.settings) : null;
    return { runs, skipped: list.length - runs.length, settings };
  }

  /** Adds incoming runs whose ids are not already present. */
  function mergeRuns(existing, incoming) {
    const ids = new Set(existing.map((r) => r.id));
    const merged = existing.slice();
    let added = 0;
    incoming.forEach((r) => {
      if (!ids.has(r.id)) {
        ids.add(r.id);
        merged.push(r);
        added++;
      }
    });
    return { runs: merged, added };
  }

  // ---------- reports (pure text generation; the browser downloads the result) ----------

  const csvCell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csvLine = (cells) => cells.map(csvCell).join(',');
  const escHtml = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  /** Keeps Markdown table cells on one line. */
  const mdCell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  const byDateAsc = (runs) =>
    runs.slice().sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);

  /** One row per run, for spreadsheets. */
  function runsToCsv(runs) {
    const head = ['date', 'source', 'distance_km', 'time', 'time_seconds', 'avg_pace_per_km', 'goal_km', 'strategy', 'notes', 'id'];
    const rows = byDateAsc(runs).map((r) => csvLine([
      r.date, r.source, runKm(r).toFixed(3), fmtDuration(r.time), Math.round(r.time),
      fmtPace(runPace(r)), r.goal || '', r.strategy, r.notes, r.id
    ]));
    return [csvLine(head), ...rows].join('\r\n') + '\r\n';
  }

  /** One row per km split, for spreadsheets. */
  function splitsToCsv(runs) {
    const head = ['date', 'run_id', 'km', 'cumulative_time', 'split_time_seconds', 'split_pace_per_km'];
    const rows = [];
    byDateAsc(runs).forEach((r) => {
      let prev = 0;
      (r.splits || []).slice().sort((a, b) => a.km - b.km).forEach((s) => {
        rows.push(csvLine([r.date, r.id, s.km, fmtDuration(s.time), Math.round(s.time - prev), fmtPace(s.time - prev)]));
        prev = s.time;
      });
    });
    return [csvLine(head), ...rows].join('\r\n') + '\r\n';
  }

  /** Everything the printable and Markdown reports show, as plain data. */
  function buildReport(runs, now, settings) {
    const sorted = byDateAsc(runs);
    const pred = predictFromBestRun(runs);
    return {
      generatedAt: (now || new Date()).toISOString(),
      race: raceSummary(settings, now),
      runCount: sorted.length,
      totalKm: sorted.reduce((a, r) => a + runKm(r), 0),
      totalSec: sorted.reduce((a, r) => a + r.time, 0),
      firstDate: sorted.length ? sorted[0].date : null,
      lastDate: sorted.length ? sorted[sorted.length - 1].date : null,
      pbs: personalBests(runs),
      prediction: pred
        ? { p5: pred.p5, p10: pred.p10, fromKm: runKm(pred.run), fromTime: pred.run.time, fromDate: pred.run.date }
        : null,
      strategies: strategyStats(runs),
      weeks: weeklyKm(runs, 12),
      runs: sorted
    };
  }

  const STRATEGY_LABEL = { even: 'Even', fast: 'Fast start', slow: 'Slow start' };
  const SOURCE_LABEL = { gps: 'GPS', manual: 'Manual' };

  /** Markdown report: readable as plain text, renders nicely in any Markdown viewer. */
  function reportToMarkdown(rep) {
    const L = [];
    const dash = (v) => (v == null ? '--' : v);
    L.push('# TrackMyRun report', '');
    L.push(`Generated: ${rep.generatedAt.slice(0, 16).replace('T', ' ')} UTC`, '');
    L.push('## Summary', '');
    L.push(`- Runs: ${rep.runCount}`);
    L.push(`- Total distance: ${rep.totalKm.toFixed(2)} km`);
    L.push(`- Total time: ${fmtDuration(rep.totalSec)}`);
    if (rep.firstDate) L.push(`- Period: ${rep.firstDate} to ${rep.lastDate}`);
    L.push('');

    if (rep.race) {
      const rc = rep.race;
      L.push('## Race day', '');
      L.push(`- Race date: ${rc.date} (${rc.daysLeft >= 0 ? rc.daysLeft + ' days after the report date' : 'already passed'})`);
      L.push(`- Distance: ${rc.distanceKm} km`);
      if (rc.targetSec) L.push(`- Target: ${fmtDuration(rc.targetSec)} (${fmtPace(rc.targetPace)} /km)`);
      L.push('');
    }

    L.push('## Personal bests', '');
    L.push('| Distance | Time | Date | Note |', '|---|---|---|---|');
    [2, 3, 5, 10].forEach((k) => {
      const b = rep.pbs[k];
      L.push(`| ${k} km | ${b ? fmtDuration(b.time) : '--'} | ${b ? b.date : '--'} | ${b ? (b.estimated ? 'estimated from a longer run' : 'measured') : 'no run yet'} |`);
    });
    L.push('');

    L.push('## Race prediction (Riegel, exponent 1.06)', '');
    if (rep.prediction) {
      const p = rep.prediction;
      L.push(`- Predicted 5K: ${fmtDuration(p.p5)} (${fmtPace(p.p5 / 5)} /km)`);
      L.push(`- Predicted 10K: ${fmtDuration(p.p10)} (${fmtPace(p.p10 / 10)} /km)`);
      L.push(`- Based on ${p.fromKm.toFixed(2)} km in ${fmtDuration(p.fromTime)} on ${p.fromDate}`);
    } else {
      L.push('Log a run of 1.8 km or more to see predictions.');
    }
    L.push('');

    L.push('## Start strategy comparison (runs of 1.8 km or more)', '');
    L.push('| Strategy | Runs | Avg /km | Best /km |', '|---|---|---|---|');
    STRATEGIES.forEach((s) => {
      const x = rep.strategies[s];
      L.push(`| ${STRATEGY_LABEL[s]} | ${x.runs} | ${fmtPace(x.avgPace)} | ${fmtPace(x.bestPace)} |`);
    });
    L.push('');

    L.push('## Weekly distance (last 12 weeks, weeks start Monday)', '');
    L.push('| Week starting | Distance km |', '|---|---|');
    rep.weeks.forEach((w) => L.push(`| ${w.week} | ${w.km.toFixed(2)} |`));
    L.push('');

    L.push('## Run log', '');
    if (!rep.runs.length) {
      L.push('No runs recorded yet.', '');
    } else {
      L.push('| Date | Distance km | Time | Pace /km | Goal | Strategy | Source | Notes |', '|---|---|---|---|---|---|---|---|');
      rep.runs.forEach((r) => {
        L.push(`| ${r.date} | ${runKm(r).toFixed(2)} | ${fmtDuration(r.time)} | ${fmtPace(runPace(r))} | ${r.goal ? r.goal + ' km' : '--'} | ${STRATEGY_LABEL[r.strategy]} | ${SOURCE_LABEL[r.source]} | ${mdCell(r.notes)} |`);
      });
      L.push('');
    }

    const withSplits = rep.runs.filter((r) => r.splits && r.splits.length);
    if (withSplits.length) {
      L.push('## Splits', '');
      withSplits.forEach((r) => {
        L.push(`### ${r.date}: ${runKm(r).toFixed(2)} km in ${fmtDuration(r.time)}`, '');
        L.push('| Km | Cumulative | Split | Split pace /km |', '|---|---|---|---|');
        let prev = 0;
        r.splits.slice().sort((a, b) => a.km - b.km).forEach((s) => {
          L.push(`| ${s.km} | ${fmtDuration(s.time)} | ${fmtDuration(s.time - prev)} | ${fmtPace(s.time - prev)} |`);
          prev = s.time;
        });
        L.push('');
      });
    }
    L.push('---', 'Created with TrackMyRun. All data stayed on the device where it was recorded.', '');
    return L.join('\n');
  }

  /** Standalone HTML report with inline styles. Use the browser's Print > Save as PDF. */
  function reportToHtml(rep) {
    const md = reportToMarkdown(rep); // single source of truth for the content
    const body = md.split('\n').reduce((acc, line) => {
      // Convert the Markdown we generated into HTML. Only the patterns above are handled.
      const t = line;
      const inTable = (acc.table = acc.table || false);
      if (/^\|/.test(t)) {
        if (!inTable) { acc.out.push('<table>'); acc.table = true; }
        if (/^\|[-|\s]+\|$/.test(t)) return acc;
        const isHead = acc.out[acc.out.length - 1] === '<table>';
        const cells = t.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|'));
        acc.out.push(`<tr>${cells.map((c) => (isHead ? `<th>${escHtml(c)}</th>` : `<td>${escHtml(c)}</td>`)).join('')}</tr>`);
        return acc;
      }
      if (acc.table) { acc.out.push('</table>'); acc.table = false; }
      if (t.startsWith('# ')) acc.out.push(`<h1>${escHtml(t.slice(2))}</h1>`);
      else if (t.startsWith('## ')) acc.out.push(`<h2>${escHtml(t.slice(3))}</h2>`);
      else if (t.startsWith('### ')) acc.out.push(`<h3>${escHtml(t.slice(4))}</h3>`);
      else if (t.startsWith('- ')) acc.out.push(`<li>${escHtml(t.slice(2))}</li>`);
      else if (t === '---') acc.out.push('<hr>');
      else if (t.trim()) acc.out.push(`<p>${escHtml(t)}</p>`);
      return acc;
    }, { out: [], table: false });
    if (body.table) body.out.push('</table>');
    // Wrap consecutive <li> items in a list.
    const html = body.out.join('\n').replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TrackMyRun report</title>
<style>
  body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; max-width: 900px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 26px; margin-bottom: 4px; }
  h2 { font-size: 18px; border-bottom: 2px solid #15803d; padding-bottom: 4px; margin-top: 28px; }
  h3 { font-size: 15px; margin: 18px 0 6px; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 12px; font-variant-numeric: tabular-nums; }
  th, td { border-bottom: 1px solid #ddd; padding: 6px 8px; text-align: left; font-size: 14px; }
  th { background: #f3f5f8; }
  li { margin: 2px 0; } ul { padding-left: 20px; }
  hr { border: 0; border-top: 1px solid #ddd; margin: 24px 0 8px; }
  .hint { color: #666; font-size: 13px; }
  @media print { body { margin: 0; } h2 { break-after: avoid; } table { break-inside: auto; } tr { break-inside: avoid; } }
</style></head>
<body>
${html}
<p class="hint">Tip: use your browser's Print command and choose "Save as PDF".</p>
</body></html>
`;
  }

  // ---------- settings: race day and voice ----------

  const SETTINGS_KEY = 'trackmyrun.settings';
  const DRAFT_KEY = 'trackmyrun.draft.v1';
  const DRAFT_STATES = ['running', 'paused', 'finished'];

  /** Cleans race and voice settings. Missing or bad fields fall back to defaults. */
  function normalizeSettings(s) {
    const x = s && typeof s === 'object' ? s : {};
    const dist = Number(x.raceDistanceKm);
    const target = Number(x.raceTargetSec);
    return {
      voice: x.voice === true,
      raceDate: typeof x.raceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.raceDate) ? x.raceDate : '',
      raceDistanceKm: dist > 0 ? dist : 5,
      raceTargetSec: target > 0 ? target : 0
    };
  }

  function loadSettings(storage) {
    if (!storage) return normalizeSettings(null);
    try {
      return normalizeSettings(JSON.parse(storage.getItem(SETTINGS_KEY) || 'null'));
    } catch (e) {
      return normalizeSettings(null);
    }
  }

  function saveSettings(storage, settings) {
    if (!storage) return false;
    try {
      storage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Whole calendar days from today to dateStr ("YYYY-MM-DD"). Negative if past. */
  function daysUntil(dateStr, now) {
    if (!dateStr) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    const race = new Date(y, m - 1, d);
    const n = now || new Date();
    const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    return Math.round((race - today) / 86400000);
  }

  function raceSummary(settings, now) {
    const s = normalizeSettings(settings);
    if (!s.raceDate) return null;
    return {
      date: s.raceDate,
      daysLeft: daysUntil(s.raceDate, now || new Date()),
      distanceKm: s.raceDistanceKm,
      targetSec: s.raceTargetSec || null,
      targetPace: s.raceTargetSec ? s.raceTargetSec / s.raceDistanceKm : null
    };
  }

  /** Planned seconds per km for the race, or NaN when no target is set. */
  const raceTargetPace = (s) => (s.raceTargetSec > 0 ? s.raceTargetSec / s.raceDistanceKm : NaN);

  /**
   * Seconds ahead (negative) or behind (positive) the race plan at km `km`, given the
   * actual cumulative time. Returns null if no plan applies (no target, or the run
   * distance is not the race distance).
   */
  function planDeltaAt(settings, goalKm, strategy, km, actualCumSec) {
    const s = normalizeSettings(settings);
    if (!s.raceTargetSec || goalKm !== s.raceDistanceKm) return null;
    const row = buildPlan(goalKm, s.raceTargetSec, strategy).find((r) => r.km === km);
    return row ? actualCumSec - row.cumSec : null;
  }

  /** Text for the GPS status line, based on the reported accuracy in metres. */
  function gpsStatusFor(accuracy) {
    if (!Number.isFinite(accuracy)) return 'Waiting for a GPS fix...';
    if (accuracy > 1000) return 'Location is too rough (network only). Use a phone outdoors with GPS on.';
    if (accuracy > GPS_RULES.maxAccuracyM) return `Weak GPS (±${Math.round(accuracy)} m), waiting for a better fix...`;
    return `GPS good (±${Math.round(accuracy)} m)`;
  }

  /** "4 minutes 52 seconds", for speech. */
  function spokenDuration(sec) {
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const parts = [];
    if (h) parts.push(plural(h, 'hour'));
    parts.push(plural(m, 'minute'));
    parts.push(plural(r, 'second'));
    return parts.join(' ');
  }

  // ---------- crash-safe draft of the run in progress ----------

  /** Snapshot of an active run. elapsedSec is the banked running time at save time. */
  function makeDraft(session, elapsedSec, nowMs) {
    if (!session || !DRAFT_STATES.includes(session.state)) return null;
    return {
      v: 1,
      savedAt: nowMs,
      state: session.state,
      goal: session.goal,
      strategy: session.strategy,
      date: session.date || localYmd(new Date(nowMs)),
      elapsedSec,
      distanceM: session.distanceM,
      path: session.path,
      splits: session.splits,
      nextKm: session.nextKm,
      goalReached: !!session.goalReached
    };
  }

  /** Validates draft text. Returns a clean draft, or null if missing or corrupt. */
  function parseDraft(text) {
    let d;
    try {
      d = JSON.parse(String(text == null ? '' : text));
    } catch (e) {
      return null;
    }
    if (!d || typeof d !== 'object' || d.v !== 1) return null;
    if (!DRAFT_STATES.includes(d.state)) return null;
    if (!GOALS_KM.includes(Number(d.goal))) return null;
    if (!STRATEGIES.includes(d.strategy)) return null;
    const nonNeg = (x) => Number.isFinite(x) && x >= 0;
    const elapsedSec = Number(d.elapsedSec);
    const distanceM = Number(d.distanceM);
    const savedAt = Number(d.savedAt);
    const nextKm = Number(d.nextKm);
    if (!nonNeg(elapsedSec) || !nonNeg(distanceM) || !nonNeg(savedAt) || !(nextKm >= 1)) return null;
    if (!Array.isArray(d.path) || !d.path.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;
    if (!Array.isArray(d.splits) || !d.splits.every((s) => s && Number(s.km) > 0 && nonNeg(Number(s.time)))) return null;
    return {
      v: 1,
      savedAt,
      state: d.state,
      goal: Number(d.goal),
      strategy: d.strategy,
      date: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : localYmd(new Date()),
      elapsedSec,
      distanceM,
      path: d.path.map((p) => [Number(p[0]), Number(p[1])]),
      splits: d.splits.map((s) => ({ km: Number(s.km), time: Number(s.time) })),
      nextKm: Math.floor(nextKm),
      goalReached: d.goalReached === true
    };
  }

  function saveDraft(storage, draft) {
    if (!storage) return false;
    try {
      storage.setItem(DRAFT_KEY, JSON.stringify(draft));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Returns a valid draft or null. Never throws. */
  function loadDraft(storage) {
    if (!storage) return null;
    try {
      const raw = storage.getItem(DRAFT_KEY);
      return raw ? parseDraft(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function clearDraft(storage) {
    if (!storage) return;
    try {
      storage.removeItem(DRAFT_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  const api = {
    runsToCsv, splitsToCsv, buildReport, reportToMarkdown, reportToHtml,
    normalizeSettings, loadSettings, saveSettings, daysUntil, raceSummary, raceTargetPace,
    planDeltaAt, gpsStatusFor, spokenDuration,
    makeDraft, parseDraft, saveDraft, loadDraft, clearDraft, DRAFT_KEY, SETTINGS_KEY,
    GPS_RULES, STRATEGIES, GOALS_KM, MIN_RUN_KM_FOR_STATS, STORAGE_KEY, DEFAULT_RAMP_S,
    haversine, createTrackFilter,
    fmtDuration, fmtPace, parseDuration,
    localYmd, weekStart, newId,
    buildPlan, riegel, runKm, runPace, timeAtKm,
    personalBests, predictFromBestRun, strategyStats, weeklyKm, paceTrend,
    normalizeRun, loadRuns, saveRuns, exportJson, importJson, mergeRuns
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.TMR = api;
})();
