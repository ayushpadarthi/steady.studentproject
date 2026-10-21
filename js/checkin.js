// Spiral check-in: trace a printed-style Archimedean spiral (the classic tremor drawing task), get your
// shake size and accuracy, and keep a dated log on this device. A personal record, not a medical test.
//
// Measurements (all from the strokes on screen, millimetres):
//   shake size  = sqrt(2) x RMS distance between the RAW line and the same line smoothed with a zero-phase
//                 3 Hz low-pass (js/settle.js), ignoring the first/last 0.25 s of each stroke. For a steady
//                 back-and-forth shake this is its peak size; slow intended movement is not counted.
//   shake speed = Steady's detected tremor frequency (approximate; shown when conf >= 0.3 and size >= 0.15 mm).
//   off spiral  = mean |radial distance| to the guide spiral (js/tasks.js), for the raw hand and for Steady's line.
import { createPad, MM_PER_PX } from './pad.js?v=10';
import { $, wireCommon, download, fitCanvas } from './pagekit.js?v=10';
import { makeTemplate, spiralRadialErrors, errStats } from './tasks.js?v=10';
import { settle } from './settle.js?v=10';

const KEY = 'steady.checkin.log';
const guide = $('guide');
let tpl = null, result = null;

const pad = createPad($('ink'), $('ghost'), { width: () => 3, onEnd: () => { $('done').disabled = false; status(); } });
const ui = wireCommon(pad, { onChange: () => {} });

function centre() { return { cx: pad.w / 2, cy: pad.h / 2 + 10 }; }
function drawGuide() {
  const { ctx, w, h } = fitCanvas(guide);
  tpl = makeTemplate('spiral', w * MM_PER_PX, (h - 200) * MM_PER_PX);
  const { cx, cy } = centre();
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#d0d0d6'; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
  tpl.polyline.forEach(([x, y], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, cx + x / MM_PER_PX, cy + y / MM_PER_PX));
  ctx.stroke();
  ctx.fillStyle = '#1f6b4e'; ctx.beginPath(); ctx.arc(cx + tpl.polyline[0][0] / MM_PER_PX, cy + tpl.polyline[0][1] / MM_PER_PX, 6, 0, 2 * Math.PI); ctx.fill();
}
window.addEventListener('resize', () => { drawGuide(); });
drawGuide();

function status(msg) {
  $('status').textContent = msg || (pad.strokes.length ? 'Keep going to the end of the spiral, then press Done.'
    : 'Start at the green dot and trace the grey spiral outwards. Then press Done.');
}

// ---------------------------------------------------------------- measuring
export function measure(strokes, sp, c) {
  const rel = (p) => [(p.x - c.cx) * MM_PER_PX, (p.y - c.cy) * MM_PER_PX];
  const raw = [], fin = [];
  let sq = 0, n = 0, dur = 0, maxTh = 0;
  for (const s of strokes) {
    if (s.t.length < 3) continue;
    dur += s.t[s.t.length - 1] - s.t[0];
    const xs = s.raw.map((p) => p.x * MM_PER_PX), ys = s.raw.map((p) => p.y * MM_PER_PX);
    const [lx, ly] = settle(s.t, xs, ys, 3.0);
    for (let i = 0; i < s.t.length; i++) {
      if (s.t[i] - s.t[0] < 0.25 || s.t[s.t.length - 1] - s.t[i] < 0.25) continue;
      sq += (xs[i] - lx[i]) ** 2 + (ys[i] - ly[i]) ** 2; n++;
    }
    for (const p of s.raw) { const q = rel(p); raw.push(q); }
    for (const p of s.pts) fin.push(rel(p));
  }
  // how far along the spiral the drawing reached (angle unwrapped by matching the nearest turn)
  for (const [x, y] of raw) {
    const r = Math.hypot(x, y); let th = Math.atan2(y, x); if (th < 0) th += 2 * Math.PI;
    const k = Math.max(0, Math.min(sp.turns - 1, Math.round((r - sp.r0) / (sp.b * 2 * Math.PI) - th / (2 * Math.PI))));
    maxTh = Math.max(maxTh, th + 2 * Math.PI * k);
  }
  return {
    shakeMm: n ? Math.SQRT2 * Math.sqrt(sq / n) : NaN,
    errRaw: errStats(spiralRadialErrors(raw, sp)).mean,
    errSteady: errStats(spiralRadialErrors(fin, sp)).mean,
    dur, coverage: Math.min(1, maxTh / (sp.turns * 2 * Math.PI)), samples: raw.length,
  };
}

function shakeHz() {
  const info = pad.filter.info();
  // Looser than the app's status line (conf 0.5): irregular tremor spreads its energy, and here the number is
  // shown as approximate next to a measured size, not as a claim that a tremor exists.
  return info && Number.isFinite(info.f0) && info.conf >= 0.3 && info.amp >= 0.15 ? info.f0 : null;
}
const fmt = (v, d = 1, u = ' mm') => (Number.isFinite(v) ? `${v.toFixed(d)}${u}` : '–');

$('done').onclick = () => {
  if (!pad.strokes.length) return;
  const m = measure(pad.strokes, tpl.spiral, centre());
  result = { ...m, hz: shakeHz(), steady: pad.steady, demo: pad.syn.on ? pad.syn.preset : null };
  $('rShake').textContent = fmt(m.shakeMm, m.shakeMm < 1 ? 2 : 1);
  $('rShakeNote').textContent = 'shake size (peak, approx.)';
  $('rHz').textContent = result.hz ? `about ${result.hz.toFixed(1)} Hz` : 'no clear shake';
  $('rDur').textContent = `${m.dur.toFixed(1)} s`;
  $('rErrRaw').textContent = fmt(m.errRaw, 2);
  $('rErrSteady').textContent = pad.steady ? fmt(m.errSteady, 2) : 'Steady was off';
  const warn = m.coverage < 0.75 ? `You traced about ${Math.round(m.coverage * 100)} % of the spiral. Trace all of it so check-ins compare fairly.` : '';
  $('rWarn').textContent = warn; $('rWarn').hidden = !warn;
  $('saveEntry').disabled = false; $('saveEntry').textContent = 'Save to my log';
  $('sheet').hidden = false; pad.enabled = false;
  status('Here is your result. Save it, or try again.');
};
function restart() { pad.clear(); result = null; $('sheet').hidden = true; pad.enabled = true; $('done').disabled = true; status(); }
$('restart').onclick = restart; $('again').onclick = restart;

// ---------------------------------------------------------------- log (localStorage, this device only)
function readLog() { try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function writeLog(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); return true; } catch { return false; } }
$('saveEntry').onclick = () => {
  if (!result) return;
  const log = readLog();
  log.push({ id: Date.now(), date: new Date().toISOString(), shake_mm: +result.shakeMm.toFixed(3), hz: result.hz ? +result.hz.toFixed(2) : null,
    err_raw_mm: +result.errRaw.toFixed(3), err_steady_mm: result.steady ? +result.errSteady.toFixed(3) : null,
    dur_s: +result.dur.toFixed(2), coverage: +result.coverage.toFixed(2), demo: result.demo });
  const ok = writeLog(log);
  $('saveEntry').textContent = ok ? 'Saved' : 'Could not save (storage blocked)'; $('saveEntry').disabled = true;
};

function renderLog() {
  const log = readLog(), body = $('logBody');
  body.textContent = '';
  $('logEmpty').hidden = log.length > 0; $('exportCsv').disabled = !log.length;
  for (const e of [...log].reverse()) {
    const tr = document.createElement('tr');
    const d = new Date(e.date);
    const cells = [d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      fmt(e.shake_mm, 2), e.hz ? `${e.hz.toFixed(1)} Hz` : '–', `${fmt(e.err_raw_mm, 2, '')} / ${fmt(e.err_steady_mm, 2, '')} mm`,
      [e.demo ? `demo (${e.demo})` : '', e.coverage < 0.75 ? 'partial' : ''].filter(Boolean).join(', ')];
    cells.forEach((c, i) => { const td = document.createElement('td'); td.textContent = c; if (i && i < 4) td.className = 'num'; tr.appendChild(td); });
    const td = document.createElement('td'), b = document.createElement('button');
    b.className = 'del'; b.textContent = 'Delete'; b.setAttribute('aria-label', `Delete check-in from ${cells[0]}`);
    let armed = null;
    b.onclick = () => {
      if (!armed) { b.classList.add('armed'); b.textContent = 'Tap again'; armed = setTimeout(() => { armed = null; b.classList.remove('armed'); b.textContent = 'Delete'; }, 3000); return; }
      clearTimeout(armed); writeLog(readLog().filter((x) => x.id !== e.id)); renderLog();
    };
    td.appendChild(b); tr.appendChild(td); body.appendChild(tr);
  }
  drawChart(log);
}
function drawChart(log) {
  const { ctx, w, h } = fitCanvas($('chart'));
  ctx.clearRect(0, 0, w, h);
  const L = 44, R = 12, T = 14, B = 26, pw = w - L - R, ph = h - T - B;
  const vals = log.map((e) => e.shake_mm).filter(Number.isFinite);
  const top = Math.max(0.5, ...vals) * 1.15;
  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif'; ctx.fillStyle = '#5f6066'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = top * i / 4, y = T + ph - ph * i / 4;
    ctx.fillStyle = '#ececf0'; ctx.fillRect(L, Math.round(y), pw, 1);
    ctx.fillStyle = '#5f6066'; ctx.textAlign = 'right'; ctx.fillText(v.toFixed(v < 1 ? 2 : 1), L - 6, y);
  }
  if (!log.length) { ctx.textAlign = 'center'; ctx.fillText('No check-ins yet', L + pw / 2, T + ph / 2); return; }
  const X = (i) => L + (log.length === 1 ? pw / 2 : pw * i / (log.length - 1));
  const Y = (v) => T + ph - ph * v / top;
  ctx.strokeStyle = '#1f6b4e'; ctx.lineWidth = 2; ctx.beginPath();
  log.forEach((e, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(i), Y(e.shake_mm))); ctx.stroke();
  log.forEach((e, i) => {
    ctx.beginPath(); ctx.arc(X(i), Y(e.shake_mm), 4.5, 0, 2 * Math.PI);
    if (e.demo) { ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#1f6b4e'; ctx.lineWidth = 1.5; ctx.stroke(); } else { ctx.fillStyle = '#1f6b4e'; ctx.fill(); }
  });
  ctx.fillStyle = '#5f6066'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const d0 = new Date(log[0].date), d1 = new Date(log[log.length - 1].date), o = { month: 'short', day: 'numeric' };
  ctx.textAlign = 'left'; ctx.fillText(d0.toLocaleDateString(undefined, o), L, T + ph + 8);
  if (log.length > 1) { ctx.textAlign = 'right'; ctx.fillText(d1.toLocaleDateString(undefined, o), L + pw, T + ph + 8); }
}
$('logBtn').onclick = () => { ui.close(); $('logPanel').hidden = false; renderLog(); $('logClose').focus(); };
$('logClose').onclick = () => { $('logPanel').hidden = true; $('logBtn').focus(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('logPanel').hidden) $('logClose').click(); });
$('exportCsv').onclick = () => {
  const cols = ['date', 'shake_mm', 'hz', 'err_raw_mm', 'err_steady_mm', 'dur_s', 'coverage', 'demo'];
  download('steady-checkins', [cols.join(',')].concat(readLog().map((e) => cols.map((c) => e[c] ?? '').join(','))).join('\n') + '\n');
};

status();
window.__steadyCheckin = { pad, measure, centre, get tpl() { return tpl; } }; // automated checks only
