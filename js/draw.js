// Steady drawing app. Uses the SAME filter code as the lab (js/filters.js), so study results apply to it.
import { Filter2D } from './filters.js?v=24';
import { PRESETS, makeTremor, SpeedEstimator } from './tremor.js?v=24';
import { adaptiveParams, adaptiveSettle, clampTo, clampMm, tremorAmp, settle } from './settle.js?v=24';
import { shakePeriods, shakeSpectrum, frequencyFromPeriods } from './shakefreq.js?v=24';
import { openReplay } from './replay.js?v=24';
import { ShakeTracker, STYLES, KEEP, pulseWidth, dotRadius, hatchLenMm } from './shakestyle.js?v=24';
// MM_PER_PX: the device's real size (js/calib.js); the filter's parameters are in millimetres
import { MM_PER_PX, onCalibrationChange, openCalibration, calibrationLabel, promptCalibrationIfNeeded } from './calib.js?v=24';
import { saveDrawing, loadDrawing } from './store.js?v=24';

const $ = (id) => document.getElementById(id);

const COLORS = [
  ['Ink', '#1b1b1f'], ['Graphite', '#6b6b70'], ['Ultramarine', '#2b4cc4'], ['Cerulean', '#2f8fce'], ['Viridian', '#1f7a5a'],
  ['Sap green', '#6f9a2e'], ['Ochre', '#d39b2a'], ['Vermilion', '#e0472b'], ['Crimson', '#b0203f'], ['Violet', '#6a3d9a'],
];
const SIZES = [2, 4, 8, 16]; // CSS px
// Demo tremor types offered in the Demo panel: [key, short name, one-line note]
const DEMO_PRESETS = [
  ['healthy', 'Healthy', 'Normal tiny shake, about 0.1 mm'],
  ['et_mild', 'ET mild', 'Essential tremor: a visible wobble'],
  ['et_moderate', 'ET moderate', 'Essential tremor: clearly shaky lines'],
  ['et_severe', 'ET severe', 'Large, slower shake; very hard to draw'],
  ['pd_rest', "Parkinson's rest", 'Fades while moving, returns when you pause'],
];
// Smoothing after the pen lifts ("ink settling", js/settle.js). k scales the detected tremor frequency.
// [key, name, note, k, base cutoff Hz used when no tremor is detected]
const SMOOTH = [
  ['off', 'Off', 'The line stays exactly as you drew it', null, null],
  ['smooth', 'Smooth', 'Each stroke settles a little when you lift the pen', 0.5, 8.0],
  ['extra', 'Extra smooth', 'Strong settling; small details get rounder', 0.3, 4.0],
];
const SETTLE_MS = 350; // length of the settling animation
const SHAKE_WIN = 2;   // seconds of trace on the "Your shake" card
// Smallest detected tremor size (mm) the status line and shake card call a shake. 0.4 since Steady v6, which reads a
// healthy hand as up to ~0.3 mm (ET mild reads ~0.7-1.1 mm).
const CLAIM_MM = 0.4;

// ---------------------------------------------------------------- state
const S = {
  steady: true, tool: 'brush', color: COLORS[0][1], size: 4,
  syn: { on: false, preset: 'et_moderate' }, ghost: false, smooth: 'smooth', style: 'none', shakeCard: false, race: false, exp: false, // exp: show the experimental shake styles (off for judging)
  raceStat: null,                      // lag race: {liveS, liveR, sumS, sumR, n, done} in mm (distance of each line from the pen)
  shake: [],                            // last 2 s of {t, dx, dy}: raw minus filtered position, mm (for the "Your shake" card)
  rawHist: [], hz: null,                // last 4 s of pen-down input {t, x, y} (mm) and the shake speed measured from it
  strokes: [], history: [], redo: [],   // history items: {kind:'stroke', stroke} | {kind:'clear', removed:[...]}
  cur: null, pointerId: null, sawPen: false, lastT: -Infinity,
  w: 0, h: 0, dpr: 1,
  baseN: 0,                             // strokes[0..baseN) are already painted on the base layer (see redrawInk)
};
load();
// One persistent Steady filter for the whole drawing session: it keeps learning the tremor between strokes.
// It is fed even when Steady is switched off, so switching it back on is instantly warm.
const steadyF = new Filter2D('steady');
// Shake style: the shake Steady separates out (input minus its zero-lag estimate) drives the brush.
const shakeT = new ShakeTracker();
// Lag race: a typical stabiliser (moving average, 2 Hz, the lab's 'ema'; ~75 ms behind the pen) fed the same input.
const raceF = new Filter2D('ema');
const RACE_COLOR = 'rgba(47,143,206,.6)';
const s0Race = () => ({ liveS: 0, liveR: 0, sumS: 0, sumR: 0, n: 0, done: false });
// Same speed-dependent tremor generator as the lab (one instance, continuous in time across strokes).
// Seeded differently on every page load, so the demo shake is never the same twice.
const tremorGen = makeTremor(S.syn.preset, {}, (Date.now() ^ Math.floor(Math.random() * 2 ** 31)) >>> 0), speedEst = new SpeedEstimator(0.08);

// ---------------------------------------------------------------- canvases
const ink = $('ink'), ghost = $('ghost'), race = $('race');
const ictx = ink.getContext('2d'), gctx = ghost.getContext('2d'), rctx = race.getContext('2d');
// Off-screen base layer holding every finished, settled stroke. A settling animation frame then costs one
// image copy plus the strokes still moving, instead of redrawing the whole picture (about 50 ms at 300 strokes).
const base = document.createElement('canvas'), bctx = base.getContext('2d');
function resize() {
  S.dpr = Math.min(window.devicePixelRatio || 1, 3);
  S.w = window.innerWidth; S.h = window.innerHeight;
  for (const c of [ink, ghost, base, race]) {
    c.width = Math.round(S.w * S.dpr); c.height = Math.round(S.h * S.dpr);
    c.getContext('2d').setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  }
  redrawAll();
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- rendering
// Strokes are drawn as quadratic curves through segment midpoints, one segment at a time, so the live
// drawing and a full redraw produce exactly the same pixels.
function segment(ctx, p0, p1, p2, color, width, erase) {
  const m0 = p0 ? [(p0.x + p1.x) / 2, (p0.y + p1.y) / 2] : [p1.x, p1.y];
  const m1 = [(p1.x + p2.x) / 2, (p1.y + p2.y) / 2];
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  ctx.strokeStyle = erase ? '#000' : color;
  ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(m0[0], m0[1]); ctx.quadraticCurveTo(p1.x, p1.y, m1[0], m1[1]); ctx.stroke();
}
function dotAt(ctx, p, color, width, erase) {
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  ctx.fillStyle = erase ? '#000' : color;
  ctx.beginPath(); ctx.arc(p.x, p.y, width / 2, 0, Math.PI * 2); ctx.fill();
}
// Shake style rendering for sample i of a brush stroke (geometry from s.pts, shake from s.dsh / s.env / s.mark).
function styledTail(ctx, s, i) {
  const P = s.pts, base = P[i].w, col = s.color;
  if (s.style === 'soften') {
    const Q = (j) => ({ x: P[j].x + KEEP * s.dsh[j].x, y: P[j].y + KEEP * s.dsh[j].y });
    if (i === 0) { dotAt(ctx, Q(0), col, base, false); return; }
    segment(ctx, i >= 2 ? Q(i - 2) : null, Q(i - 1), Q(i), col, (P[i - 1].w + base) / 2, false); return;
  }
  if (s.style === 'pulse') {
    const w = base * pulseWidth(s.env[i]);
    if (i === 0) { dotAt(ctx, P[0], col, w, false); return; }
    segment(ctx, i >= 2 ? P[i - 2] : null, P[i - 1], P[i], col, (base * pulseWidth(s.env[i - 1]) + w) / 2, false); return;
  }
  if (s.style === 'hatch' && i > 0) {
    ctx.globalAlpha = 0.45; segment(ctx, i >= 2 ? P[i - 2] : null, P[i - 1], P[i], col, Math.max(0.75, base * 0.3), false); ctx.globalAlpha = 1;
  }
  const m = s.mark[i]; if (!(m > 0)) return;
  if (s.style === 'stipple') { dotAt(ctx, P[i], col, 2 * Math.max(0.8, base * dotRadius(m)), false); return; }
  if (s.style === 'hatch') {
    const a = P[Math.max(0, i - 2)], b = P[Math.min(P.length - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y; const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
    const h = hatchLenMm(m) / MM_PER_PX / 2, nx = -ty, ny = tx, sl = 0.35;  // slight slant, like a sketched mark
    ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, base * 0.4); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(P[i].x - (nx + sl * tx) * h, P[i].y - (ny + sl * ty) * h); ctx.lineTo(P[i].x + (nx + sl * tx) * h, P[i].y + (ny + sl * ty) * h); ctx.stroke();
  }
}
function drawStrokeTail(ctx, s, pts, i, ghostLine) {
  if (!ghostLine && pts === s.pts && s.style && s.style !== 'none') { styledTail(ctx, s, i); return; }
  // draw the piece of stroke s that ends at point i
  const erase = !ghostLine && s.tool === 'eraser';
  const color = ghostLine ? 'rgba(27,27,31,.28)' : s.color;
  if (i === 0) { if (!ghostLine) dotAt(ctx, pts[0], color, pts[0].w, erase); return; }
  const w = ghostLine ? 1.25 : (pts[i - 1].w + pts[i].w) / 2;
  segment(ctx, i >= 2 ? pts[i - 2] : null, pts[i - 1], pts[i], color, w, erase);
}
// Lag race line for sample i of stroke s (brush: the stabiliser's line; eraser: erase it too).
function raceTail(s, i) {
  if (s.tool === 'eraser') { drawStrokeTail(rctx, s, s.pts, i, false); return; }
  const P = s.race; if (!P || !P[i]) return;
  if (i === 0) { dotAt(rctx, P[0], RACE_COLOR, P[0].w, false); return; }
  segment(rctx, i >= 2 ? P[i - 2] : null, P[i - 1], P[i], RACE_COLOR, (P[i - 1].w + P[i].w) / 2, false);
}
function drawRace(s) { const n = s.tool === 'eraser' ? s.pts.length : (s.race ? s.race.length : 0); for (let i = 0; i < n; i++) raceTail(s, i); }
function drawInk(ctx, s) { for (let i = 0; i < s.pts.length; i++) drawStrokeTail(ctx, s, s.pts, i, false); }
function drawGhost(s) {
  if (s.tool === 'brush') for (let i = 0; i < s.raw.length; i++) drawStrokeTail(gctx, s, s.raw, i, true);
  else for (let i = 0; i < s.pts.length; i++) drawStrokeTail(gctx, s, s.pts, i, false); // eraser clears the raw line too
}
function wipe(c) { const x = c.getContext('2d'); x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height); x.restore(); }
// Paint finished strokes onto the base layer, in order, up to the first one still settling or being drawn.
function bake() {
  while (S.baseN < S.strokes.length) {
    const s = S.strokes[S.baseN];
    if (s === S.cur || s.settling) break;
    drawInk(bctx, s); S.baseN++;
  }
  bctx.globalCompositeOperation = 'source-over';
}
// Ink canvas = base layer + the strokes after it (settling, or the one being drawn).
function redrawInk() {
  bake(); wipe(ink);
  if (base.width && base.height) { // a hidden tab can load with a 0 x 0 window
    ictx.save(); ictx.setTransform(1, 0, 0, 1, 0, 0); ictx.globalCompositeOperation = 'source-over'; ictx.drawImage(base, 0, 0); ictx.restore();
  }
  for (let i = S.baseN; i < S.strokes.length; i++) drawInk(ictx, S.strokes[i]);
  ictx.globalCompositeOperation = 'source-over';
}
// Full rebuild (undo, clear, resize, restore): the base layer and the raw line from scratch.
function redrawAll() {
  wipe(base); wipe(ghost); wipe(race); S.baseN = 0;
  for (const s of S.strokes) { drawGhost(s); if (S.race) drawRace(s); }
  gctx.globalCompositeOperation = 'source-over'; rctx.globalCompositeOperation = 'source-over';
  race.style.visibility = S.race ? 'visible' : 'hidden';
  redrawInk();
  ghost.style.visibility = S.ghost ? 'visible' : 'hidden';
}

// ---------------------------------------------------------------- input
function widthFor(ev, tool) {
  const base = tool === 'eraser' ? S.size * 3 : S.size;
  if (ev.pointerType !== 'pen' || !(ev.pressure > 0)) return base;
  return base * (0.35 + 0.95 * Math.min(1, ev.pressure));
}
function ingest(ev) {
  const t = (ev.__testT ?? ev.timeStamp) / 1000; // __testT: synthetic events in automated checks only
  if (!(t > S.lastT)) return; // duplicate / out-of-order events
  S.lastT = t;
  const r = ink.getBoundingClientRect();
  let xm = (ev.clientX - r.left) * MM_PER_PX, ym = (ev.clientY - r.top) * MM_PER_PX;
  const penX = xm, penY = ym;             // where the pen is (before any simulated tremor): the lag race measures from here
  const spd = speedEst.update(t, xm, ym); // speed of the intended (un-shaken) path, mm/s
  if (S.syn.on) { // demonstration only: same artificial tremor model as the lab
    const [dx, dy] = tremorGen.offset(t, spd);
    xm += dx; ym += dy;
  }
  const [fx, fy] = steadyF.step(t, xm, ym);
  // the shake Steady is removing, mm: hand minus the zero-lag estimate, times how much of it the gate removes
  // (so a slow, big wiggle that the drawing check keeps as drawing is not turned into shake marks)
  const dsx = (xm - steadyF.fx.y2) * steadyF.fx.g, dsy = (ym - steadyF.fy.y2) * steadyF.fy.g;
  const [env, mark] = shakeT.step(t, fx, fy, dsx, dsy);
  S.rawHist.push({ t, x: xm, y: ym });
  while (S.rawHist.length && S.rawHist[0].t < t - 4) S.rawHist.shift();
  if (Number.isFinite(fx) && Number.isFinite(fy)) {
    S.shake.push({ t, dx: xm - fx, dy: ym - fy });
    while (S.shake.length && S.shake[0].t < t - SHAKE_WIN) S.shake.shift();
  }
  const useF = S.steady && Number.isFinite(fx) && Number.isFinite(fy);
  const s = S.cur;
  const [rx, ry] = raceF.step(t, xm, ym);
  if (S.raceStat && Number.isFinite(rx) && Number.isFinite(ry)) {
    const st = S.raceStat, dS = Math.hypot((useF ? fx : xm) - penX, (useF ? fy : ym) - penY), dR = Math.hypot(rx - penX, ry - penY);
    st.liveS = dS; st.liveR = dR; st.sumS += dS; st.sumR += dR; st.n++;
  }
  const wRaw = widthFor(ev, s.tool);
  s.wSm = s.wSm == null ? wRaw : s.wSm * 0.7 + wRaw * 0.3; // soften pressure jitter
  s.t.push(t);
  s.live.push({ x: (useF ? fx : xm) / MM_PER_PX, y: (useF ? fy : ym) / MM_PER_PX, w: s.wSm });
  s.env.push(Number.isFinite(env) ? env : 0); s.mark.push(useF ? mark : 0);
  s.dsh.push(Number.isFinite(dsx) && Number.isFinite(dsy) ? { x: dsx / MM_PER_PX, y: dsy / MM_PER_PX } : { x: 0, y: 0 });
  s.raw.push({ x: xm / MM_PER_PX, y: ym / MM_PER_PX, w: s.wSm });
  s.race.push({ x: (Number.isFinite(rx) ? rx : xm) / MM_PER_PX, y: (Number.isFinite(ry) ? ry : ym) / MM_PER_PX, w: s.wSm });
  s.pts.push({ x: (useF ? fx : xm) / MM_PER_PX, y: (useF ? fy : ym) / MM_PER_PX, w: s.wSm });
  drawStrokeTail(ictx, s, s.pts, s.pts.length - 1, false);
  if (s.tool === 'brush') drawStrokeTail(gctx, s, s.raw, s.raw.length - 1, true);
  else drawStrokeTail(gctx, s, s.pts, s.pts.length - 1, false);
  if (S.race) raceTail(s, s.pts.length - 1);
}

ink.addEventListener('pointerdown', (e) => {
  if (S.pointerId !== null) return;                       // one stroke at a time
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.pointerType === 'pen') S.sawPen = true;
  if (e.pointerType === 'touch' && S.sawPen) return;       // palm rejection once a pen has been used
  closePops();
  e.preventDefault();
  try { ink.setPointerCapture(e.pointerId); } catch {}
  S.pointerId = e.pointerId;
  speedEst.reset();
  steadyF.startStroke();                                   // keeps the learned tremor, restarts the line
  shakeT.startStroke();
  raceF.startStroke();                                     // a stabiliser starts fresh at every pen-down
  S.raceStat = s0Race();
  // the eraser end of a stylus (or its eraser button) erases, whatever tool is selected
  const tool = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32)) ? 'eraser' : S.tool;
  S.cur = { tool, color: S.color, steady: S.steady, style: tool === 'brush' && S.steady ? S.style : 'none',
    pts: [], raw: [], live: [], race: [], t: [], env: [], mark: [], dsh: [], wSm: null };
  S.strokes.push(S.cur);
  S.lastT = -Infinity;
  document.body.classList.add('drawing');
  ingest(e);
});
ink.addEventListener('pointermove', (e) => {
  if (e.pointerId !== S.pointerId || !S.cur) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ce of (evs.length ? evs : [e])) ingest(ce);
});
function endStroke(e) {
  if (e.pointerId !== S.pointerId) return;
  S.pointerId = null;
  document.body.classList.remove('drawing');
  const s = S.cur; S.cur = null;
  if (S.raceStat) S.raceStat.done = true;
  if (s && s.pts.length) { S.history.push({ kind: 'stroke', stroke: s }); S.redo = []; settleStroke(s); }
  else if (s) S.strokes.pop();
  bake(); syncButtons(); saveSoon();
}

// ---------------------------------------------------------------- ink settling
// After pen-up the finished stroke is smoothed with a zero-phase filter (no lag, because the stroke is over).
// How much depends on the tremor Steady has detected: none detected -> only a light polish.
function settleStroke(s) {
  const mode = SMOOTH.find(([k]) => k === S.smooth);
  if (!mode || mode[3] == null || !s.steady || s.tool !== 'brush' || s.pts.length < 3) return;
  const prm = { ...adaptiveParams(steadyF, mode[3]), base: mode[4] };
  const [xs, ys] = adaptiveSettle(s.t, s.pts.map((p) => p.x), s.pts.map((p) => p.y), prm);
  const from = s.pts.map((p) => ({ ...p })), to = clampTo(s.pts, xs, ys, clampMm(tremorAmp(steadyF)) / MM_PER_PX);
  s.settle = prm;
  const t0 = performance.now();
  const frame = (now) => {
    if (!S.strokes.includes(s)) { s.pts = to; s.settling = false; return; } // undone mid-animation: redo shows the settled line
    const u = Math.min(1, (now - t0) / SETTLE_MS), e = 1 - (1 - u) ** 3;
    s.pts = u < 1 ? from.map((p, i) => ({ ...p, x: p.x + (to[i].x - p.x) * e, y: p.y + (to[i].y - p.y) * e })) : to;
    if (u >= 1) s.settling = false;
    redrawInk();
    if (u < 1) requestAnimationFrame(frame); else saveSoon();
  };
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { s.pts = to; redrawInk(); }
  else { s.settling = true; requestAnimationFrame(frame); }
}
ink.addEventListener('pointerup', endStroke);
ink.addEventListener('pointercancel', endStroke);
ink.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------- history
function undo() {
  const a = S.history.pop(); if (!a) return;
  if (a.kind === 'stroke') S.strokes.splice(S.strokes.lastIndexOf(a.stroke), 1);
  else S.strokes = a.removed.concat(S.strokes);
  S.redo.push(a); redrawAll(); syncButtons(); saveSoon();
}
function redo() {
  const a = S.redo.pop(); if (!a) return;
  if (a.kind === 'stroke') S.strokes.push(a.stroke);
  else { a.removed = S.strokes; S.strokes = []; }
  S.history.push(a); redrawAll(); syncButtons(); saveSoon();
}
let clearTimer = null;
function clearPage() {
  // Two taps on purpose: an accidental tap (common with tremor) never wipes a drawing. Undo also restores it.
  const btn = $('clear');
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed'); $('clearLbl').textContent = 'Tap again to clear';
    clearTimer = setTimeout(disarmClear, 3000); return;
  }
  disarmClear();
  if (!S.strokes.length) return;
  S.history.push({ kind: 'clear', removed: S.strokes }); S.strokes = []; S.redo = [];
  redrawAll(); syncButtons(); saveSoon();
}
function disarmClear() { clearTimeout(clearTimer); $('clear').classList.remove('armed'); $('clearLbl').textContent = 'Clear'; }

function save() {
  const out = document.createElement('canvas');
  out.width = ink.width; out.height = ink.height;
  const o = out.getContext('2d');
  o.fillStyle = '#ffffff'; o.fillRect(0, 0, out.width, out.height);
  o.drawImage(ink, 0, 0);
  download(out, 'steady-drawing');
}

// Before/after picture: the same strokes twice, raw input (left) and what Steady drew (right), one PNG.
// Uses the same segment()/drawStrokeTail rendering as the canvas, cropped to the drawing.
function saveBeforeAfter() {
  if (!S.strokes.length) return;
  const pad = 24, band = 48, gap = 2, sc = Math.max(2, S.dpr);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of S.strokes) for (const p of s.raw.concat(s.pts)) {
    x0 = Math.min(x0, p.x - p.w); y0 = Math.min(y0, p.y - p.w); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.w);
  }
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(S.w, x1 + pad); y1 = Math.min(S.h, y1 + pad);
  const w = Math.max(240, Math.ceil(x1 - x0)), h = Math.max(120, Math.ceil(y1 - y0));
  const side = (which) => { // each side on its own layer so the eraser only removes ink, never the white paper
    const c = document.createElement('canvas'); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
    const ctx = c.getContext('2d'); ctx.setTransform(sc, 0, 0, sc, -x0 * sc, -y0 * sc);
    for (const s of S.strokes) for (let i = 0; i < s[which].length; i++) drawStrokeTail(ctx, s, s[which], i, false);
    return c;
  };
  const out = document.createElement('canvas');
  out.width = Math.round((2 * w + gap) * sc); out.height = Math.round((h + band) * sc);
  const o = out.getContext('2d'); o.scale(sc, sc);
  o.fillStyle = '#ffffff'; o.fillRect(0, 0, 2 * w + gap, h + band);
  o.fillStyle = '#d9d9de'; o.fillRect(w, 0, gap, h + band);
  o.fillStyle = '#1b1b1f'; o.font = '600 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';
  o.textBaseline = 'middle'; o.textAlign = 'center';
  o.fillText('Without Steady', w / 2, band / 2); o.fillText('With Steady', w + gap + w / 2, band / 2);
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.drawImage(side('raw'), 0, band * sc); o.drawImage(side('pts'), Math.round((w + gap) * sc), band * sc);
  download(out, 'steady-before-after');
}
function download(canvas, prefix) {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const name = `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.png`;
  canvas.toBlob((blob) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
}

// ---------------------------------------------------------------- UI
function syncButtons() {
  $('undo').disabled = !S.history.length; $('redo').disabled = !S.redo.length;
  $('steady').setAttribute('aria-checked', String(S.steady)); $('steadyState').textContent = S.steady ? 'On' : 'Off';
  $('toolBrush').classList.toggle('on', S.tool === 'brush'); $('toolBrush').setAttribute('aria-pressed', String(S.tool === 'brush'));
  $('toolEraser').classList.toggle('on', S.tool === 'eraser'); $('toolEraser').setAttribute('aria-pressed', String(S.tool === 'eraser'));
  $('colorChip').style.background = S.color;
  const d = Math.max(6, Math.min(26, S.size * 1.4)); Object.assign($('sizeDot').style, { width: d + 'px', height: d + 'px' });
  for (const b of document.querySelectorAll('.swatch')) b.setAttribute('aria-pressed', String(b.dataset.c === S.color));
  for (const b of document.querySelectorAll('.size')) b.setAttribute('aria-pressed', String(+b.dataset.s === S.size));
  $('synOn').setAttribute('aria-checked', String(S.syn.on)); $('ghostOn').setAttribute('aria-checked', String(S.ghost));
  $('shakeOn').setAttribute('aria-checked', String(S.shakeCard)); $('shakeCard').hidden = !S.shakeCard;
  $('expOn').setAttribute('aria-checked', String(S.exp)); $('styleSection').hidden = !S.exp;
  $('raceOn').setAttribute('aria-checked', String(S.race)); $('raceCard').hidden = !S.race; $('raceSwatch').style.background = S.color;
  $('saveBA').disabled = !S.strokes.length;
  for (const b of document.querySelectorAll('#presetList .preset')) b.setAttribute('aria-pressed', String(b.dataset.k === S.syn.preset));
  for (const b of document.querySelectorAll('.smooth-opt')) b.setAttribute('aria-pressed', String(b.dataset.k === S.smooth));
  const sm = SMOOTH.find(([k]) => k === S.smooth);
  const st = STYLES.find(([k]) => k === S.style);
  for (const b of document.querySelectorAll('.style-opt')) b.setAttribute('aria-pressed', String(b.dataset.k === S.style));
  $('styleNote').hidden = S.steady;
  $('smoothLbl').textContent = S.style === 'none' ? sm[1] : `${sm[1]} \u00b7 ${st[1]}`; $('smoothBtn').dataset.mode = sm[0];
  $('smoothBtn').setAttribute('aria-label', `Line: smoothing ${sm[1]}, shake style ${st[1]}`); $('smoothBtn').title = `Smoothing: ${sm[1]} (M), shake style: ${st[1]} (K)`;
  $('smoothBtn').classList.toggle('styled', S.style !== 'none');
  $('smoothBadge').textContent = { off: 'Off', smooth: '1', extra: '2' }[sm[0]];
  $('replayBtn').disabled = !lastBrush();
  ghost.style.visibility = S.ghost ? 'visible' : 'hidden';
  persist();
}
// Short message in the middle of the screen, so a mode change is visible even when the button is small.
let flashTimer = null;
function flash(msg) {
  const el = $('flash'); el.textContent = msg; el.hidden = false; el.classList.add('show');
  clearTimeout(flashTimer); flashTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.hidden = true; }, 200); }, 1400);
  updateStatus();
}
function lastBrush() { for (let i = S.strokes.length - 1; i >= 0; i--) if (S.strokes[i].tool === 'brush' && S.strokes[i].pts.length > 2) return S.strokes[i]; return null; }
function replayLast() {
  const s = lastBrush(); if (!s) return;
  closePops();
  openReplay({ t: s.t, raw: s.raw, live: s.live || s.pts, final: s.pts, color: s.color, width: s.pts[0].w, steady: s.steady }, () => $('replayBtn').focus());
}
function setSteady(on) { S.steady = on; syncButtons(); updateStatus(); }
function setTool(t) { S.tool = t; syncButtons(); }

const pops = { colorBtn: 'colorPop', sizeBtn: 'sizePop', smoothBtn: 'smoothPop', demoBtn: 'demoPop' };
function closePops() {
  for (const [b, p] of Object.entries(pops)) { $(p).hidden = true; $(b).setAttribute('aria-expanded', 'false'); }
}
function togglePop(btnId) {
  const open = $(pops[btnId]).hidden;
  closePops();
  if (open) { $(pops[btnId]).hidden = false; $(btnId).setAttribute('aria-expanded', 'true'); }
}
for (const b of Object.keys(pops)) $(b).addEventListener('click', (e) => { e.stopPropagation(); togglePop(b); });
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.pop') && !e.target.closest('[aria-haspopup]')) closePops();
});

for (const [name, c] of COLORS) {
  const b = document.createElement('button');
  b.className = 'swatch'; b.style.background = c; b.dataset.c = c; b.title = name; b.setAttribute('aria-label', name);
  b.addEventListener('click', () => { S.color = c; if (S.tool === 'eraser') S.tool = 'brush'; syncButtons(); closePops(); });
  $('swatches').appendChild(b);
}
for (const s of SIZES) {
  const b = document.createElement('button');
  b.className = 'size'; b.dataset.s = s; b.setAttribute('aria-label', `Size ${s}`);
  const dot = document.createElement('span'); const d = Math.max(4, s * 1.4); Object.assign(dot.style, { width: d + 'px', height: d + 'px' });
  b.appendChild(dot);
  b.addEventListener('click', () => { S.size = s; syncButtons(); closePops(); });
  $('sizes').appendChild(b);
}
for (const [k, name, note] of SMOOTH) {
  const b = document.createElement('button');
  b.className = 'preset smooth-opt'; b.dataset.k = k; b.setAttribute('aria-pressed', 'false');
  b.innerHTML = '<span class="p-name"></span><span class="p-note"></span>';
  b.firstChild.textContent = name; b.lastChild.textContent = note;
  b.addEventListener('click', () => { S.smooth = k; syncButtons(); closePops(); flash(`Smoothing: ${name}`); });
  $('smoothList').appendChild(b);
}
for (const [k, name, note] of STYLES) {
  const b = document.createElement('button');
  b.className = 'preset style-opt'; b.dataset.k = k; b.setAttribute('aria-pressed', 'false');
  b.innerHTML = '<span class="p-name"></span><span class="p-note"></span>';
  b.firstChild.textContent = name; b.lastChild.textContent = note;
  b.addEventListener('click', () => { S.style = k; syncButtons(); closePops(); flash(`Shake style: ${name}`); });
  $('styleList').appendChild(b);
}
for (const [k, name, note] of DEMO_PRESETS) {
  const b = document.createElement('button');
  b.className = 'preset'; b.dataset.k = k; b.setAttribute('aria-pressed', 'false');
  b.innerHTML = '<span class="p-name"></span><span class="p-note"></span>';
  b.firstChild.textContent = name; b.lastChild.textContent = note;
  b.addEventListener('click', () => { S.syn.preset = k; tremorGen.p = { ...PRESETS[k] }; syncButtons(); });
  $('presetList').appendChild(b);
}
$('replayBtn').onclick = replayLast;
$('synOn').onclick = () => { S.syn.on = !S.syn.on; syncButtons(); };
$('ghostOn').onclick = () => { S.ghost = !S.ghost; syncButtons(); };
$('shakeOn').onclick = () => { S.shakeCard = !S.shakeCard; if (S.shakeCard) S.race = false; syncButtons(); redrawAll(); updateShakeCard(); };
$('expOn').onclick = () => { S.exp = !S.exp; if (!S.exp) S.style = 'none'; syncButtons(); updateStatus(); };
$('raceOn').onclick = () => {
  S.race = !S.race; if (S.race) S.shakeCard = false;   // both cards use the same spot
  syncButtons(); redrawAll(); updateRaceCard();
  if (S.race && !S.syn.on) flash('Tip: turn on Simulate tremor to see the difference');
};
$('saveBA').onclick = saveBeforeAfter;
$('calBtn').onclick = () => { closePops(); openCalibration(); };
const calSync = () => { $('calNote').textContent = calibrationLabel(); };
// new real size: the filter's millimetres changed meaning, so it relearns the tremor
onCalibrationChange(() => { steadyF.reset(); shakeT.startStroke(); calSync(); updateStatus(); flash('Real size updated'); });
calSync();
$('steady').onclick = () => setSteady(!S.steady);
$('toolBrush').onclick = () => setTool('brush');
$('toolEraser').onclick = () => setTool('eraser');
$('undo').onclick = undo; $('redo').onclick = redo; $('clear').onclick = clearPage; $('save').onclick = save;

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 's') { e.preventDefault(); save(); return; }
  if (mod || e.altKey) return;
  if (k === 'escape') closePops();
  else if (k === 'b') setTool('brush');
  else if (k === 'e') setTool('eraser');
  else if (k === 's') setSteady(!S.steady);
  else if (k === 'm') { const i = (SMOOTH.findIndex(([q]) => q === S.smooth) + 1) % SMOOTH.length; S.smooth = SMOOTH[i][0]; syncButtons(); updateStatus(); flash(`Smoothing: ${SMOOTH[i][1]}`); }
  else if (k === 'r') replayLast();
  else if (k === 'k' && S.exp) { const i = (STYLES.findIndex(([q]) => q === S.style) + 1) % STYLES.length; S.style = STYLES[i][0]; syncButtons(); flash(`Shake style: ${STYLES[i][1]}`); }
  else if (k === '[' || k === ']') {
    const i = SIZES.indexOf(S.size) + (k === ']' ? 1 : -1);
    S.size = SIZES[Math.max(0, Math.min(SIZES.length - 1, i))]; syncButtons();
  }
});

// Status line: says in plain words what the filter is doing. Only claims a tremor when it is clearly there.
// Shake speed measured from the last 4 s of what the pen actually drew (same method as the spiral check-in,
// js/shakefreq.js): raw minus 3 Hz zero-phase smoothing, cycles + energy check. Steady's own frequency read-out wanders
// with irregular tremor (it once read 7.9 Hz for a 6.5 Hz shake), so the number shown comes from here instead.
function measureHz() {
  const H = S.rawHist, periods = []; let spec = null, sq = 0, n = 0, i = 0;
  while (i < H.length) {
    let j = i + 1; while (j < H.length && H[j].t - H[j - 1].t < 0.1) j++;   // one pen-down segment
    if (j - i >= 90) {
      const seg = H.slice(i, j), t = seg.map((p) => p.t), xs = seg.map((p) => p.x), ys = seg.map((p) => p.y);
      const [lx, ly] = settle(t, xs, ys, 3.0), tt = [], rx = [], ry = [];
      for (let k = 0; k < t.length; k++) {
        if (t[k] - t[0] < 0.25 || t[t.length - 1] - t[k] < 0.25) continue;
        tt.push(t[k]); rx.push(xs[k] - lx[k]); ry.push(ys[k] - ly[k]); sq += rx[rx.length - 1] ** 2 + ry[ry.length - 1] ** 2; n++;
      }
      periods.push(...shakePeriods(tt, rx, ry));
      const sp = shakeSpectrum(tt, rx, ry); spec = spec ? spec.map((v, k) => v + sp[k]) : sp;
    }
    i = j;
  }
  const size = n ? Math.SQRT2 * Math.sqrt(sq / n) : 0;
  S.hz = size >= 0.2 ? frequencyFromPeriods(periods, spec) : null;
}
function updateStatus() {
  measureHz();
  const el = $('status');
  if (!S.steady) { el.textContent = 'Steady is off: drawing your raw input'; return; }
  const info = steadyF.info(), st = STYLES.find(([k]) => k === S.style)[1];
  const sm = SMOOTH.find(([k]) => k === S.smooth)[1] + (S.style === 'none' ? '' : ` \u00b7 Shake style: ${st}`);
  const drawing = steadyF.fx.intent ? Math.max(steadyF.fx.intent(), steadyF.fy.intent()) : 0;
  if (drawing > 0.5) el.textContent = `Too slow or too big for a tremor: keeping it as drawing \u00b7 Smoothing: ${sm}`;
  else if (info && Number.isFinite(info.f0) && info.conf >= 0.5 && info.amp >= CLAIM_MM) {
    el.textContent = (S.hz ? `Removing a ${S.hz.toFixed(1)} Hz shake` : 'Removing a shake') + ` \u00b7 Smoothing: ${sm}`;
  } else el.textContent = `Steady is on: no shake detected yet \u00b7 Smoothing: ${sm}`;
}
setInterval(() => { if (S.pointerId !== null || !document.hidden) updateStatus(); }, 300);

// "Your shake" card: live read-outs of what the filter measured. Same claim rule as updateStatus().
const traceCv = $('shakeTrace'), tctx = traceCv.getContext('2d');
function updateShakeCard() {
  if (!S.shakeCard) return;
  const info = steadyF.info();
  const amp = Math.max(steadyF.fx.tremor_amp_mm(), steadyF.fy.tremor_amp_mm());
  const drawing = steadyF.fx.intent ? Math.max(steadyF.fx.intent(), steadyF.fy.intent()) > 0.5 : false;
  const sure = !drawing && info && Number.isFinite(info.f0) && info.conf >= 0.5 && info.amp >= CLAIM_MM;
  $('shakeLine').textContent = drawing ? 'Too slow or too big for a tremor: treated as drawing' : sure ? 'Shake detected' : 'No clear shake yet';
  $('shakeHz').textContent = sure && S.hz ? `${S.hz.toFixed(1)} Hz` : '\u2013';
  $('shakeMm').textContent = sure ? `about ${amp.toFixed(1)} mm` : '\u2013';
  // trace
  const cw = traceCv.clientWidth, ch = traceCv.clientHeight, dpr = S.dpr;
  if (traceCv.width !== Math.round(cw * dpr)) { traceCv.width = Math.round(cw * dpr); traceCv.height = Math.round(ch * dpr); }
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0); tctx.clearRect(0, 0, cw, ch);
  tctx.fillStyle = '#d9d9de'; tctx.fillRect(0, Math.round(ch / 2), cw, 1);
  const tr = S.shake; if (tr.length < 2) return;
  const tEnd = tr[tr.length - 1].t;
  let m = 0.5; for (const q of tr) m = Math.max(m, Math.abs(q.dx), Math.abs(q.dy)); // mm at the card edge (at least 0.5)
  for (const [key, col] of [['dy', '#9a9aa0'], ['dx', '#1b1b1f']]) {
    tctx.strokeStyle = col; tctx.lineWidth = 1.25; tctx.lineJoin = 'round'; tctx.beginPath();
    let prev = null;
    for (const q of tr) {
      const x = cw - (tEnd - q.t) / SHAKE_WIN * cw, y = ch / 2 - q[key] / m * (ch / 2 - 2);
      if (prev && q.t - prev > 0.1) tctx.moveTo(x, y); else tctx.lineTo(x, y); // gap between strokes
      prev = q.t;
    }
    tctx.stroke();
  }
}
setInterval(() => { if (!document.hidden) { updateShakeCard(); updateRaceCard(); } }, 100);

// Lag race card: how far each line is from the pen, now (while drawing) or on average (last stroke).
function updateRaceCard() {
  if (!S.race) return;
  const st = S.raceStat, mm = (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} mm`;
  if (!st || !st.n) { $('raceS').textContent = $('raceR').textContent = '\u2013'; return; }
  if (st.done) {
    $('raceS').textContent = `${mm(st.sumS / st.n)} avg`; $('raceR').textContent = `${mm(st.sumR / st.n)} avg`;
    $('raceCap').textContent = 'Last stroke: average distance of each line from your pen.';
  } else {
    $('raceS').textContent = `${mm(st.liveS)} behind`; $('raceR').textContent = `${mm(st.liveR)} behind`;
    $('raceCap').textContent = 'Right now: distance of each line from your pen.';
  }
}

// ---------------------------------------------------------------- the drawing itself (this device only, js/store.js)
// Saved a moment after every change and when the page is hidden, so a refresh or an accidental back-swipe
// never loses it. Undo history is rebuilt stroke by stroke on restore.
let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 600); }
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  const strokes = S.strokes.filter((s) => s !== S.cur).map(({ settling, wSm, ...rest }) => rest);
  saveDrawing({ v: 1, saved: Date.now(), w: S.w, h: S.h, strokes });
}
document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) saveNow(); });
window.addEventListener('pagehide', () => { if (saveTimer) saveNow(); });
function restoreDrawing() {
  loadDrawing().then((d) => {
    if (!d || !Array.isArray(d.strokes) || !d.strokes.length || S.strokes.length || S.pointerId !== null) return;
    const ok = d.strokes.filter((s) => s && Array.isArray(s.pts) && s.pts.length && Array.isArray(s.raw));
    S.strokes = ok; S.history = ok.map((stroke) => ({ kind: 'stroke', stroke })); S.redo = [];
    redrawAll(); syncButtons(); flash('Your last drawing is back');
  });
}

// ---------------------------------------------------------------- preferences (per device)
function persist() {
  try { localStorage.setItem('steady.draw.prefs', JSON.stringify({ steady: S.steady, color: S.color, size: S.size, syn: { preset: S.syn.preset }, ghost: S.ghost, smooth: S.smooth, style: S.style, shakeCard: S.shakeCard, race: S.race, exp: S.exp })); } catch {}
}
function load() {
  try {
    const p = JSON.parse(localStorage.getItem('steady.draw.prefs') || 'null');
    if (!p) return;
    if (typeof p.steady === 'boolean') S.steady = p.steady;
    if (COLORS.some(([, c]) => c === p.color)) S.color = p.color;
    if (SIZES.includes(p.size)) S.size = p.size;
    if (typeof p.ghost === 'boolean') S.ghost = p.ghost;
    if (typeof p.shakeCard === 'boolean') S.shakeCard = p.shakeCard;
    if (typeof p.race === 'boolean') S.race = p.race && !S.shakeCard;
    if (SMOOTH.some(([k]) => k === p.smooth)) S.smooth = p.smooth;
    if (typeof p.exp === 'boolean') S.exp = p.exp;
    if (S.exp && STYLES.some(([k]) => k === p.style)) S.style = p.style;
    if (p.syn && DEMO_PRESETS.some(([k]) => k === p.syn.preset)) S.syn.preset = p.syn.preset;
    // simulated tremor is never restored as "on": a real user should never be surprised by fake shake
  } catch {}
}

resize(); syncButtons(); updateStatus(); restoreDrawing(); promptCalibrationIfNeeded();
// test hook for automated checks (no effect on normal use)
window.__steadyDraw = { S, steadyF, tremorGen, shakeT, redrawInk, redrawAll };
