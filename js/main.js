// Steady app: drawing canvas, live filters, synthetic tremor, study mode, optional serial.
import { Filter2D, TremorTracker } from './filters.js?v=11';
import { makeTemplate, TASKS, TASK_HELP, spiralRadialErrors, errStats, lineStraightness, pathLength } from './tasks.js?v=11';
import { sanitizeId, rowForParticipant, orderForRow, trialCsv, trialFilename, summaryCsv, download } from './study.js?v=11';
import { SteadySerial, ImuPlot, serialSupported } from './serial.js?v=11';
import { PRESETS, PRESET_ORDER, makeTremor, SpeedEstimator } from './tremor.js?v=11';
import { openCompare } from './compare.js?v=11';

const $ = (id) => document.getElementById(id);
const canvas = $('draw'), ctx = canvas.getContext('2d');
const INK = '#14213d', GREY = '#a3a8ad';

// ---------------------------------------------------------------- state
const S = {
  mode: 'free', mmPerPx: 0.2646, w: 0, h: 0,
  filter: new Filter2D('steady'), filterName: 'steady', monitor: false,
  mon: new TremorTracker(),
  strokes: [], cur: null, drawing: false, lastT: -Infinity,
  syn: { on: false, preset: 'et_moderate', custom: false, hz: PRESETS.et_moderate.f0, mm: PRESETS.et_moderate.amp },
  gen: makeTremor('et_moderate', {}, 20240607), speed: new SpeedEstimator(0.08), // one generator, continuous in time (never restarted per stroke)
  rec: [], recCur: null,
  lag: { ms: 0, ok: false, hist: [] }, fs: 0,
  guide: 'none', template: null, trial: null, study: null, showCal: false,
};

// ---------------------------------------------------------------- geometry
function resize() {
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  S.w = r.width; S.h = r.height;
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  updateTemplate(); redraw();
}
const mmToPx = (x, y) => [x / S.mmPerPx, y / S.mmPerPx];
const centreMm = () => [(S.w / 2) * S.mmPerPx, (S.h / 2) * S.mmPerPx];

function activeTask() {
  if (S.mode === 'study' && S.study && S.study.stage === 'task') return S.study.task;
  if (S.mode === 'free' && S.guide !== 'none') return S.guide;
  return null;
}
function updateTemplate() {
  const task = activeTask();
  S.template = task ? makeTemplate(task, S.w * S.mmPerPx, S.h * S.mmPerPx) : null;
}

// ---------------------------------------------------------------- rendering
function polyline(pts, color, width) {
  if (pts.length < 2) return;
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = ctx.lineCap = 'round';
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
}
function showRaw() { return S.mode === 'study' ? $('studyRaw').checked : $('showRaw').checked; }
function redraw() {
  ctx.clearRect(0, 0, S.w, S.h);
  if (S.template && S.template.polyline.length) {
    const cx = S.w / 2, cy = S.h / 2;
    const pts = S.template.polyline.map(([x, y]) => [cx + x / S.mmPerPx, cy + y / S.mmPerPx]);
    polyline(pts, 'rgba(60,110,200,0.22)', 3);
  }
  if (S.showCal) {
    ctx.fillStyle = '#d97706'; ctx.fillRect(S.w / 2 - 100, S.h / 2 - 3, 200, 6);
    ctx.fillStyle = INK; ctx.fillText('200 px bar', S.w / 2 - 30, S.h / 2 - 10);
  }
  if (showRaw()) for (const s of S.strokes) polyline(s.raw, GREY, 1.5);
  for (const s of S.strokes) polyline(s.fil, INK, 2.2);
}
function drawSeg(arr, color, width) {
  const n = arr.length;
  if (n >= 2) polyline([arr[n - 2], arr[n - 1]], color, width);
}

// ---------------------------------------------------------------- sample ingestion
function ingest(ev, pressureFallback) {
  const tms = ev.__testT ?? ev.timeStamp; // __testT: synthetic events in automated checks only
  const t = tms / 1000;
  if (!(t >= S.lastT)) return;
  if (S.lastT > -Infinity && t > S.lastT) {
    const dt = t - S.lastT;
    if (dt < 0.1) S.fs = S.fs ? 0.97 * S.fs + 0.03 / dt : 1 / dt;
  }
  S.lastT = t;
  const r = canvas.getBoundingClientRect();
  let xm = (ev.clientX - r.left) * S.mmPerPx, ym = (ev.clientY - r.top) * S.mmPerPx;
  // speed from the UN-tremored pointer position (mm/s, EMA 80 ms); the generator always runs so it stays continuous in time
  const spd = S.speed.update(t, xm, ym);
  const ix = xm, iy = ym; // the intended position (before any simulated tremor): lets Compare measure accuracy
  if (S.syn.on) {
    const [dx, dy] = S.gen.offset(t, spd);
    xm += dx; ym += dy;
  }
  if (S.recCur) S.recCur.samples.push(S.syn.on ? [t, xm, ym, ix, iy] : [t, xm, ym]); // compare view: after tremor injection, before filtering (+ intended when simulated)
  const [fx, fy] = S.filter.step(t, xm, ym);
  if (S.monitor) S.mon.push(t, [xm, ym]); // FFT monitor only for filters without their own tremor read-out
  updateLag(t, xm, ym, fx, fy);
  S.cur.raw.push(mmToPx(xm, ym)); S.cur.fil.push(mmToPx(fx, fy));
  if (showRaw()) drawSeg(S.cur.raw, GREY, 1.5);
  drawSeg(S.cur.fil, INK, 2.2);
  if (S.trial) {
    const tr = S.trial;
    if (tr.t0 === null) tr.t0 = tms;
    if (S.cur.newStroke) { tr.strokeStartsMs.push(tms - tr.t0); S.cur.newStroke = false; }
    const p = ev.pressure > 0 ? ev.pressure : pressureFallback;
    tr.samples.push({ t: tms - tr.t0, x: xm, y: ym, fx, fy, p });
  }
}

/** Lag estimate: component of (raw - filtered) along the filtered velocity, expressed as time. */
function updateLag(t, x, y, fx, fy) {
  const L = S.lag, h = L.hist;
  h.push([t, fx, fy]);
  while (h.length > 2 && t - h[0][0] > 0.12) h.shift();
  const a = h[0], dt = t - a[0];
  if (dt < 0.04) return;
  const vx = (fx - a[1]) / dt, vy = (fy - a[2]) / dt, sp2 = vx * vx + vy * vy;
  if (sp2 < 400) return; // need > 20 mm/s
  const lagS = ((x - fx) * vx + (y - fy) * vy) / sp2;
  L.ms = L.ok ? L.ms * 0.98 + lagS * 1000 * 0.02 : lagS * 1000;
  L.ok = true;
}

// ---------------------------------------------------------------- pointer events
function canDraw() {
  if (S.mode === 'free') return true;
  return !!(S.trial && S.study && S.study.stage === 'task');
}
canvas.addEventListener('pointerdown', (e) => {
  if (!canDraw() || (e.pointerType === 'mouse' && e.button !== 0)) return;
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch {} // can throw for synthetic events (automated checks)
  S.drawing = true; S.filter.startStroke(); S.mon.reset(); S.lag.hist = []; S.lag.ok = false;
  S.cur = { raw: [], fil: [], newStroke: true }; S.strokes.push(S.cur);
  S.speed.reset();
  S.recCur = S.mode === 'free' ? { samples: [] } : null;
  if (S.recCur) { S.rec.push(S.recCur); updateCompareBtn(); }
  S.lastT = -Infinity;
  ingest(e, 0.5);
});
canvas.addEventListener('pointermove', (e) => {
  if (!S.drawing || !S.cur) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  if (!evs.length) evs.push(e);
  for (const ce of evs) ingest(ce, 0.5);
});
const endStroke = () => { if (S.drawing) { S.drawing = false; S.cur = null; S.recCur = null; updateCompareBtn(); } };
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------- free-play controls
// A NEW filter instance (= forgetting the tremor state) is created only here, on a filter change, a new
// participant/session, or when a study condition starts. Pen-down only calls filter.startStroke().
function setFilter(name) { S.filterName = name; S.filter = new Filter2D(name); S.monitor = !['steady', 'steady_v3', 'steady_v2', 'steady_v1'].includes(name); S.mon.reset(); }
$('filterSel').addEventListener('change', (e) => setFilter(e.target.value));
$('showRaw').addEventListener('change', redraw);
$('studyRaw').addEventListener('change', redraw);
$('guideSel').addEventListener('change', (e) => { S.guide = e.target.value; updateTemplate(); redraw(); });
$('btnClear').addEventListener('click', () => { S.strokes = []; S.cur = null; S.rec = []; S.recCur = null; updateCompareBtn(); redraw(); });
function updateCompareBtn() { $('btnCompare').disabled = !(S.mode === 'free' && S.rec.some((r) => r.samples.length >= 5)) || S.drawing; }
$('btnCompare').addEventListener('click', () => {
  const rec = S.rec.filter((r) => r.samples.length >= 2);
  if (rec.length) openCompare(rec, () => $('btnCompare').focus());
});
$('modeFree').addEventListener('click', () => setMode('free'));
$('modeStudy').addEventListener('click', () => setMode('study'));
function setMode(m) {
  if (S.study && S.study.running && m === 'free') return;
  S.mode = m;
  $('modeFree').classList.toggle('on', m === 'free'); $('modeStudy').classList.toggle('on', m === 'study');
  $('secStudy').hidden = m !== 'study';
  $('guideLbl').hidden = m === 'study';
  $('filterSel').disabled = m === 'study';
  $('banner').textContent = '';
  S.strokes = []; S.cur = null; S.trial = null; S.rec = []; S.recCur = null; updateCompareBtn();
  if (m === 'free') setFilter($('filterSel').value);
  updateTemplate(); redraw();
}

// Synthetic tremor UI: preset dropdown fills frequency + amplitude; editing them makes it "Custom (based on X)".
const selP = $('synPreset');
for (const k of PRESET_ORDER) selP.add(new Option(PRESETS[k].name, k));
const optCustom = new Option('Custom', 'custom'); optCustom.hidden = true; selP.add(optCustom);
const clampN = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
function applyGen() { S.gen.p = { ...PRESETS[S.syn.preset], f0: S.syn.hz, amp: S.syn.mm }; } // keeps phase/OU state: continuous in time
function synUi() {
  S.syn.on = $('synOn').checked;
  if (S.syn.custom) { optCustom.hidden = false; optCustom.text = `Custom (based on ${PRESETS[S.syn.preset].name})`; selP.value = 'custom'; }
  else { optCustom.hidden = true; selP.value = S.syn.preset; }
  $('synNote').textContent = S.syn.custom ? '' : PRESETS[S.syn.preset].note;
}
function synPick(key) {
  S.syn.preset = key; S.syn.custom = false; S.syn.hz = PRESETS[key].f0; S.syn.mm = PRESETS[key].amp;
  $('synHz').value = S.syn.hz; $('synMm').value = S.syn.mm; applyGen(); synUi();
}
selP.addEventListener('change', () => { if (selP.value !== 'custom') synPick(selP.value); mirrorMotor(); });
$('synHz').addEventListener('input', (e) => { const v = clampN(+e.target.value, 3, 12, NaN); if (!Number.isFinite(v)) return; S.syn.hz = v; S.syn.custom = true; applyGen(); synUi(); mirrorMotor(); });
$('synMm').addEventListener('input', (e) => { const v = clampN(+e.target.value, 0, 10, NaN); if (!Number.isFinite(v)) return; S.syn.mm = v; S.syn.custom = true; applyGen(); synUi(); mirrorMotor(); });
$('synOn').addEventListener('input', () => { synUi(); mirrorMotor(); });
const synLabel = () => (!S.syn.on ? 'none' : S.syn.custom ? `custom(based_on=${S.syn.preset})` : S.syn.preset);

// calibration
function setCal(v) {
  if (!(v > 0.01 && v < 5)) return;
  S.mmPerPx = v; $('mmPerPx').value = v.toFixed(4);
  updateTemplate(); redraw();
}
$('mmPerPx').addEventListener('change', (e) => setCal(+e.target.value));
$('calReset').addEventListener('click', () => setCal(25.4 / 96));
$('calCard').addEventListener('click', () => {
  S.showCal = true; redraw();
  setTimeout(() => {
    const v = window.prompt('Measure the orange bar on screen with a ruler. Length in mm?', '');
    S.showCal = false;
    if (v) setCal(parseFloat(v) / 200);
    redraw();
  }, 50);
});

// ---------------------------------------------------------------- study mode
const ST = () => S.study;
$('btnStart').addEventListener('click', () => {
  const pid = sanitizeId($('pid').value);
  if (!pid) { $('pid').focus(); $('pid').placeholder = 'enter an ID first'; return; }
  const sel = $('rowSel').value;
  const row = sel === 'auto' ? rowForParticipant(pid) : +sel - 1;
  S.study = {
    pid, row, order: orderForRow(row), reps: Math.max(1, Math.min(5, +$('reps').value || 1)),
    ci: 0, si: 0, stage: 'task', task: 'spiral', running: true, trials: [], summary: [], condTrials: [],
  };
  $('studySetup').hidden = true; $('studyRun').hidden = false; $('trialList').innerHTML = '';
  $('modeFree').disabled = true;
  beginTask();
});
function seqFor(st) { const q = []; for (let r = 0; r < st.reps; r++) for (const t of TASKS) q.push({ task: t, n: r + 1 }); return q; }
function beginTask() {
  const st = ST(), q = seqFor(st)[st.si];
  st.stage = 'task'; st.task = q.task; st.n = q.n; st.cond = st.order[st.ci];
  if (st.filterKey !== st.ci) { setFilter(st.cond); st.filterKey = st.ci; } // one instance per condition (new session = new st)
  else S.filter.startStroke(); // next task / redo within the condition: keep tremor state
  S.strokes = []; S.cur = null;
  S.trial = { samples: [], strokeStartsMs: [], t0: null };
  $('stRating').hidden = true; $('stDone').hidden = true; $('btnDone').disabled = false; $('btnRedo').disabled = false;
  $('stProgress').textContent = `Condition ${st.ci + 1} of 4 - task ${st.si + 1} of ${st.reps * TASKS.length}`;
  $('stTask').textContent = `${st.task.toUpperCase()}: ${TASK_HELP[st.task]}`;
  $('banner').textContent = `Condition ${st.ci + 1}/4 - ${st.task}`;
  $('stMetrics').textContent = st.lastMetrics || '';
  updateTemplate(); redraw();
}
$('btnRedo').addEventListener('click', () => { if (ST()?.stage === 'task') { ST().lastMetrics = ''; beginTask(); } });
$('btnDone').addEventListener('click', finishTrial);

function metricsFor(trial, task, tpl) {
  const [cx, cy] = centreMm();
  const raw = trial.samples.map((s) => [s.x, s.y]), fil = trial.samples.map((s) => [s.fx, s.fy]);
  const out = { lines: [], spiral: null };
  const plr = pathLength(fil) / (pathLength(raw) || 1);
  if (task === 'spiral' && tpl?.spiral) {
    const rel = (a) => a.map(([x, y]) => [x - cx, y - cy]);
    const sf = errStats(spiralRadialErrors(rel(fil), tpl.spiral)), sr = errStats(spiralRadialErrors(rel(raw), tpl.spiral));
    out.spiral = { f: sf, r: sr };
    out.lines.push(`spiral radial error (mm)  filtered: mean|e| ${sf.mean.toFixed(2)}  RMS ${sf.rms.toFixed(2)}`,
      `                          raw:      mean|e| ${sr.mean.toFixed(2)}  RMS ${sr.rms.toFixed(2)}`);
  } else if (task === 'line') {
    out.lines.push(`line straightness RMS (mm)  filtered ${lineStraightness(fil).toFixed(2)}  raw ${lineStraightness(raw).toFixed(2)}`);
  }
  out.lines.push(`path length ratio (filtered/raw) ${plr.toFixed(3)}   samples ${trial.samples.length}`);
  return out;
}

function finishTrial() {
  const st = ST();
  if (!st || st.stage !== 'task' || !S.trial || S.trial.samples.length < 5) { $('stMetrics').textContent = 'Draw something first.'; return; }
  const m = metricsFor(S.trial, st.task, S.template);
  const [cx, cy] = centreMm();
  const sp = S.template?.spiral;
  const trial = {
    participant: st.pid, condition: st.cond, task: st.task, n: st.n,
    samples: S.trial.samples, strokeStartsMs: S.trial.strokeStartsMs,
    meta: {
      created: new Date().toISOString(), mmPerPx: S.mmPerPx.toFixed(5),
      synHz: S.syn.on ? S.syn.hz.toFixed(2) : '0', synMm: S.syn.on ? S.syn.mm.toFixed(2) : '0', tremorPreset: synLabel(),
      row: st.row + 1, position: st.ci + 1,
      template: sp ? `spiral cx_mm=${cx.toFixed(3)} cy_mm=${cy.toFixed(3)} r0_mm=${sp.r0} b_mm_per_rad=${sp.b.toFixed(5)} turns=${sp.turns} theta0=0 image_coords_y_down`
        : (S.template?.polyline.length ? `${st.task} centre_mm=${cx.toFixed(3)},${cy.toFixed(3)} polyline_mm=${S.template.polyline.map(([x, y]) => `${x.toFixed(1)}:${y.toFixed(1)}`).join(';')}` : 'none'),
    },
    spiral: m.spiral,
  };
  st.trials.push(trial); st.condTrials.push(trial);
  const li = document.createElement('li');
  const a = document.createElement('a'); a.textContent = trialFilename(trial);
  a.addEventListener('click', () => download(trialFilename(trial), trialCsv(trial)));
  li.appendChild(a); $('trialList').prepend(li);
  if ($('autoDl').checked) download(trialFilename(trial), trialCsv(trial));
  st.lastMetrics = m.lines.join('\n'); $('stMetrics').textContent = st.lastMetrics;
  S.trial = null;
  st.si++;
  if (st.si >= seqFor(st).length) {
    st.stage = 'rating'; S.strokes = []; S.cur = null; S.template = null; redraw();
    $('btnDone').disabled = true; $('btnRedo').disabled = true; $('stRating').hidden = false;
    $('ratingSl').value = 5; $('ratingO').textContent = '5';
    $('stTask').textContent = ''; $('banner').textContent = `Condition ${st.ci + 1}/4 finished`;
  } else beginTask();
}
$('ratingSl').addEventListener('input', (e) => { $('ratingO').textContent = e.target.value; });
$('btnRate').addEventListener('click', () => {
  const st = ST(); if (!st || st.stage !== 'rating') return;
  const sp = st.condTrials.filter((t) => t.spiral);
  const avg = (k, f) => (sp.length ? sp.reduce((a, t) => a + t.spiral[k][f], 0) / sp.length : NaN);
  st.summary.push({
    participant: st.pid, row: st.row + 1, position: st.ci + 1, condition: st.cond, rating: +$('ratingSl').value,
    nTrials: st.condTrials.length, spiralRmsF: avg('f', 'rms'), spiralRmsR: avg('r', 'rms'), spiralMeanF: avg('f', 'mean'),
    synHz: S.syn.on ? S.syn.hz.toFixed(2) : '0', synMm: S.syn.on ? S.syn.mm.toFixed(2) : '0', saved: new Date().toISOString(),
  });
  st.condTrials = []; st.ci++; st.si = 0; st.lastMetrics = '';
  $('stRating').hidden = true;
  if (st.ci >= 4) {
    st.stage = 'done'; $('stDone').hidden = false; $('banner').textContent = 'Study complete';
    $('stProgress').textContent = 'All conditions done'; $('stMetrics').textContent = '';
    if ($('autoDl').checked) download(`summary_${st.pid}.csv`, summaryCsv(st.summary));
  } else beginTask();
});
$('btnSummary').addEventListener('click', () => { const st = ST(); if (st) download(`summary_${st.pid}.csv`, summaryCsv(st.summary)); });
$('btnAll').addEventListener('click', () => {
  const st = ST(); if (!st) return;
  st.trials.forEach((t, i) => setTimeout(() => download(trialFilename(t), trialCsv(t)), i * 250));
});
$('btnAbort').addEventListener('click', () => {
  const st = ST();
  if (st && st.stage !== 'done' && (st.trials.length || st.summary.length) && !confirm('End the session? Download your CSVs first.')) return;
  S.study = null; S.trial = null; $('studySetup').hidden = false; $('studyRun').hidden = true; $('modeFree').disabled = false;
  S.strokes = []; $('banner').textContent = ''; updateTemplate(); redraw();
});

// ---------------------------------------------------------------- serial
const ser = new SteadySerial();
const plot = new ImuPlot($('imuCanvas'));
const slog = (s) => { const el = $('serialLog'); el.textContent = (el.textContent + s + '\n').split('\n').slice(-30).join('\n'); el.scrollTop = el.scrollHeight; };
if (!serialSupported()) {
  $('btnConnect').disabled = true;
  $('serialNote').textContent = 'Web Serial is not available here (use Chrome or Edge over http://localhost). The rest of the app works without it.';
} else $('serialNote').textContent = 'Connect the Steady pen (921600 baud). Optional.';
ser.onSample = (s) => plot.add(s);
ser.onLine = (l) => slog(l);
ser.onStatus = (s) => {
  slog(`[${s}]`);
  const on = ser.connected;
  $('btnConnect').textContent = on ? 'Disconnect' : 'Connect';
  $('btnPing').disabled = !on; $('motorMirror').disabled = !on;
  if (!on) $('motorMirror').checked = false;
};
$('btnConnect').addEventListener('click', async () => {
  try { if (ser.connected) await ser.disconnect(); else await ser.connect(); } catch (e) { slog('! ' + e.message); }
});
$('btnPing').addEventListener('click', () => ser.ping());
$('imuGroup').addEventListener('change', (e) => { plot.group = e.target.value; });
function mirrorMotor() {
  if (!ser.connected) return;
  if ($('motorMirror').checked && S.syn.on) ser.setTremor(S.syn.hz, Math.min(100, (S.syn.mm / 4) * 100)); else ser.stopTremor();
}
$('motorMirror').addEventListener('change', mirrorMotor);

// ---------------------------------------------------------------- readouts
function updateReadouts() {
  const best = S.mon;
  const info = S.filter.info();
  const conf = info ? info.conf : best.conf, f0 = info ? info.f0 : best.f0;
  const haveF0 = info ? (info.kind === 'v2' ? Number.isFinite(f0) : info.locked) : best.locked;
  $('roF0').textContent = haveF0 ? `${f0.toFixed(1)} Hz` : '-';
  $('roConf').textContent = conf.toFixed(2);
  $('confBar').style.width = `${Math.min(100, conf * 100)}%`;
  $('roMode').textContent = !info ? S.filterName
    : info.kind === 'v2' ? `steady: oscillator bank, tremor ${info.amp.toFixed(2)} mm`
    : (info.fallback ? 'steady v1: fallback (low conf)' : 'steady v1: tremor model on');
  $('roLag').textContent = S.filterName === 'raw' ? '0 ms' : (S.lag.ok ? `${S.lag.ms.toFixed(0)} ms` : '-');
  $('roFs').textContent = S.fs ? `${S.fs.toFixed(0)} Hz` : '-';
  if (ser.connected) plot.draw();
  requestAnimationFrame(updateReadouts);
}

// ---------------------------------------------------------------- boot
window.addEventListener('resize', resize);
synPick('et_moderate'); resize(); requestAnimationFrame(updateReadouts);
window.__steady = S; // handy for debugging in the console
