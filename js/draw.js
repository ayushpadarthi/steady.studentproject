// Steady drawing app. Uses the SAME filter code as the lab (js/filters.js), so study results apply to it.
import { Filter2D } from './filters.js';
import { PRESETS, makeTremor, SpeedEstimator } from './tremor.js';

const $ = (id) => document.getElementById(id);
const MM_PER_PX = 0.2646; // same default as the lab (96 px/in); the filter's parameters are in millimetres

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

// ---------------------------------------------------------------- state
const S = {
  steady: true, tool: 'brush', color: COLORS[0][1], size: 4,
  syn: { on: false, preset: 'et_moderate' }, ghost: false,
  strokes: [], history: [], redo: [],   // history items: {kind:'stroke', stroke} | {kind:'clear', removed:[...]}
  cur: null, pointerId: null, sawPen: false, lastT: -Infinity,
  w: 0, h: 0, dpr: 1,
};
load();
// One persistent Steady filter for the whole drawing session: it keeps learning the tremor between strokes.
// It is fed even when Steady is switched off, so switching it back on is instantly warm.
const steadyF = new Filter2D('steady');
// Same speed-dependent tremor generator as the lab (one instance, continuous in time across strokes).
const tremorGen = makeTremor(S.syn.preset, {}, 20240607), speedEst = new SpeedEstimator(0.08);

// ---------------------------------------------------------------- canvases
const ink = $('ink'), ghost = $('ghost');
const ictx = ink.getContext('2d'), gctx = ghost.getContext('2d');
function resize() {
  S.dpr = Math.min(window.devicePixelRatio || 1, 3);
  S.w = window.innerWidth; S.h = window.innerHeight;
  for (const c of [ink, ghost]) {
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
function drawStrokeTail(ctx, s, pts, i, ghostLine) {
  // draw the piece of stroke s that ends at point i
  const erase = !ghostLine && s.tool === 'eraser';
  const color = ghostLine ? 'rgba(27,27,31,.28)' : s.color;
  if (i === 0) { if (!ghostLine) dotAt(ctx, pts[0], color, pts[0].w, erase); return; }
  const w = ghostLine ? 1.25 : (pts[i - 1].w + pts[i].w) / 2;
  segment(ctx, i >= 2 ? pts[i - 2] : null, pts[i - 1], pts[i], color, w, erase);
}
function drawStroke(s) {
  for (let i = 0; i < s.pts.length; i++) drawStrokeTail(ictx, s, s.pts, i, false);
  if (s.tool === 'brush') for (let i = 0; i < s.raw.length; i++) drawStrokeTail(gctx, s, s.raw, i, true);
  else for (let i = 0; i < s.pts.length; i++) drawStrokeTail(gctx, s, s.pts, i, false); // eraser clears the raw line too
}
function redrawAll() {
  ictx.save(); ictx.setTransform(1, 0, 0, 1, 0, 0); ictx.clearRect(0, 0, ink.width, ink.height); ictx.restore();
  gctx.save(); gctx.setTransform(1, 0, 0, 1, 0, 0); gctx.clearRect(0, 0, ghost.width, ghost.height); gctx.restore();
  for (const s of S.strokes) drawStroke(s);
  ictx.globalCompositeOperation = 'source-over';
  ghost.style.visibility = S.ghost ? 'visible' : 'hidden';
}

// ---------------------------------------------------------------- input
function widthFor(ev) {
  const base = S.tool === 'eraser' ? S.size * 3 : S.size;
  if (ev.pointerType !== 'pen' || !(ev.pressure > 0)) return base;
  return base * (0.35 + 0.95 * Math.min(1, ev.pressure));
}
function ingest(ev) {
  const t = (ev.__testT ?? ev.timeStamp) / 1000; // __testT: synthetic events in automated checks only
  if (!(t > S.lastT)) return; // duplicate / out-of-order events
  S.lastT = t;
  const r = ink.getBoundingClientRect();
  let xm = (ev.clientX - r.left) * MM_PER_PX, ym = (ev.clientY - r.top) * MM_PER_PX;
  const spd = speedEst.update(t, xm, ym); // speed of the intended (un-shaken) path, mm/s
  if (S.syn.on) { // demonstration only: same artificial tremor model as the lab
    const [dx, dy] = tremorGen.offset(t, spd);
    xm += dx; ym += dy;
  }
  const [fx, fy] = steadyF.step(t, xm, ym);
  const useF = S.steady && Number.isFinite(fx) && Number.isFinite(fy);
  const s = S.cur;
  const wRaw = widthFor(ev);
  s.wSm = s.wSm == null ? wRaw : s.wSm * 0.7 + wRaw * 0.3; // soften pressure jitter
  s.raw.push({ x: xm / MM_PER_PX, y: ym / MM_PER_PX, w: s.wSm });
  s.pts.push({ x: (useF ? fx : xm) / MM_PER_PX, y: (useF ? fy : ym) / MM_PER_PX, w: s.wSm });
  drawStrokeTail(ictx, s, s.pts, s.pts.length - 1, false);
  if (s.tool === 'brush') drawStrokeTail(gctx, s, s.raw, s.raw.length - 1, true);
  else drawStrokeTail(gctx, s, s.pts, s.pts.length - 1, false);
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
  S.cur = { tool: S.tool, color: S.color, steady: S.steady, pts: [], raw: [], wSm: null };
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
  if (s && s.pts.length) { S.history.push({ kind: 'stroke', stroke: s }); S.redo = []; }
  else if (s) S.strokes.pop();
  syncButtons();
}
ink.addEventListener('pointerup', endStroke);
ink.addEventListener('pointercancel', endStroke);
ink.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------- history
function undo() {
  const a = S.history.pop(); if (!a) return;
  if (a.kind === 'stroke') S.strokes.splice(S.strokes.lastIndexOf(a.stroke), 1);
  else S.strokes = a.removed.concat(S.strokes);
  S.redo.push(a); redrawAll(); syncButtons();
}
function redo() {
  const a = S.redo.pop(); if (!a) return;
  if (a.kind === 'stroke') S.strokes.push(a.stroke);
  else { a.removed = S.strokes; S.strokes = []; }
  S.history.push(a); redrawAll(); syncButtons();
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
  redrawAll(); syncButtons();
}
function disarmClear() { clearTimeout(clearTimer); $('clear').classList.remove('armed'); $('clearLbl').textContent = 'Clear'; }

function save() {
  const out = document.createElement('canvas');
  out.width = ink.width; out.height = ink.height;
  const o = out.getContext('2d');
  o.fillStyle = '#ffffff'; o.fillRect(0, 0, out.width, out.height);
  o.drawImage(ink, 0, 0);
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const name = `steady-drawing-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.png`;
  out.toBlob((blob) => {
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
  for (const b of document.querySelectorAll('.preset')) b.setAttribute('aria-pressed', String(b.dataset.k === S.syn.preset));
  ghost.style.visibility = S.ghost ? 'visible' : 'hidden';
  persist();
}
function setSteady(on) { S.steady = on; syncButtons(); updateStatus(); }
function setTool(t) { S.tool = t; syncButtons(); }

const pops = { colorBtn: 'colorPop', sizeBtn: 'sizePop', demoBtn: 'demoPop' };
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
for (const [k, name, note] of DEMO_PRESETS) {
  const b = document.createElement('button');
  b.className = 'preset'; b.dataset.k = k; b.setAttribute('aria-pressed', 'false');
  b.innerHTML = '<span class="p-name"></span><span class="p-note"></span>';
  b.firstChild.textContent = name; b.lastChild.textContent = note;
  b.addEventListener('click', () => { S.syn.preset = k; tremorGen.p = { ...PRESETS[k] }; syncButtons(); });
  $('presetList').appendChild(b);
}
$('synOn').onclick = () => { S.syn.on = !S.syn.on; syncButtons(); };
$('ghostOn').onclick = () => { S.ghost = !S.ghost; syncButtons(); };
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
  else if (k === '[' || k === ']') {
    const i = SIZES.indexOf(S.size) + (k === ']' ? 1 : -1);
    S.size = SIZES[Math.max(0, Math.min(SIZES.length - 1, i))]; syncButtons();
  }
});

// Status line: says in plain words what the filter is doing. Only claims a tremor when it is clearly there.
function updateStatus() {
  const el = $('status');
  if (!S.steady) { el.textContent = 'Steady is off: drawing your raw input'; return; }
  const info = steadyF.info();
  if (info && Number.isFinite(info.f0) && info.conf >= 0.5 && info.amp >= 0.15) {
    el.textContent = `Removing a ${info.f0.toFixed(1)} Hz shake`;
  } else el.textContent = 'Steady is on: no shake detected yet';
}
setInterval(() => { if (S.pointerId !== null || !document.hidden) updateStatus(); }, 300);

// ---------------------------------------------------------------- preferences (per device; drawing itself is not stored)
function persist() {
  try { localStorage.setItem('steady.draw.prefs', JSON.stringify({ steady: S.steady, color: S.color, size: S.size, syn: { preset: S.syn.preset }, ghost: S.ghost })); } catch {}
}
function load() {
  try {
    const p = JSON.parse(localStorage.getItem('steady.draw.prefs') || 'null');
    if (!p) return;
    if (typeof p.steady === 'boolean') S.steady = p.steady;
    if (COLORS.some(([, c]) => c === p.color)) S.color = p.color;
    if (SIZES.includes(p.size)) S.size = p.size;
    if (typeof p.ghost === 'boolean') S.ghost = p.ghost;
    if (p.syn && DEMO_PRESETS.some(([k]) => k === p.syn.preset)) S.syn.preset = p.syn.preset;
    // simulated tremor is never restored as "on": a real user should never be surprised by fake shake
  } catch {}
}

resize(); syncButtons(); updateStatus();
// test hook for automated checks (no effect on normal use)
window.__steadyDraw = { S, steadyF, tremorGen };
