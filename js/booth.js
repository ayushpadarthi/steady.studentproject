// Booth demo ("Try Steady"): one movement drawn three ways at the same moment, side by side.
//   raw    = the hand (pen + simulated tremor), no help
//   ema    = a typical stabiliser (moving average, 2 Hz, the lab's 'ema'; about 75 ms behind the pen)
//   steady = Steady (the same filter as the drawing app, js/filters.js)
// The pen's own position (before the simulated tremor) is the path the person meant, so both numbers are exact:
//   Shakiness       = mean distance from the line to the meant path (nearest point, so lag alone does not count)
//   Behind your pen = mean distance the line trails the pen along the direction of movement (tremor averages out)
// When the pen lifts, Steady's stroke settles exactly as in the drawing app ("Smooth" mode), and Shakiness then
// scores that final line: it is what stays on the page. Behind your pen is always measured while drawing.
import { Filter2D } from './filters.js?v=24';
import { PRESETS, makeTremor, SpeedEstimator } from './tremor.js?v=24';
import { settle, adaptiveParams, adaptiveSettle, clampTo, clampMm, tremorAmp } from './settle.js?v=24';
import { shakePeriods, shakeSpectrum, frequencyFromPeriods } from './shakefreq.js?v=24';
import { MM_PER_PX } from './calib.js?v=24';

const $ = (sel, el = document) => el.querySelector(sel);
const KINDS = ['raw', 'ema', 'steady'];
const COLOR = { raw: '#c0392b', ema: '#2f6fce', steady: '#1f6b4e' };
const HANDS = [['none', 'No tremor added'], ['et_mild', 'Mild tremor'], ['et_moderate', 'Strong tremor'], ['et_severe', 'Severe tremor']];
const MOVING_MM_S = 20;   // "behind your pen" only counts while the pen is really moving
const NEAR_S = 0.5;       // shakiness: nearest point on the meant path within +-0.5 s (keeps it fast)
const CLAIM_MM = 0.4;     // same threshold as the drawing app's status line
const SETTLE_K = 0.5, SETTLE_BASE = 8.0, SETTLE_MS = 350;   // the drawing app's default "Smooth" setting

const S = {
  hand: 'et_moderate', strokes: [], cur: null, pointerId: null, lastT: -Infinity, dirty: true,
  sum: null, hist: [], hz: null, prompted: false,
};
const resetSums = () => { S.sum = Object.fromEntries(KINDS.map((k) => [k, { lag: 0, nL: 0 }])); };   // shakiness sums live per stroke
resetSums();

let steadyF, emaF, tremorGen;
const speedEst = new SpeedEstimator(0.08);
function freshFilters() {
  steadyF = new Filter2D('steady');   // persistent between strokes, like the drawing app: it keeps learning the tremor
  emaF = new Filter2D('ema');
  tremorGen = makeTremor(S.hand === 'none' ? 'et_moderate' : S.hand, {}, (Date.now() ^ Math.floor(Math.random() * 2 ** 31)) >>> 0);
}
freshFilters();

// ---------------------------------------------------------------- canvases
const panels = KINDS.map((k) => {
  const sec = $(`.panel[data-k="${k}"]`), cv = $('canvas', sec);
  return { k, sec, cv, ctx: cv.getContext('2d'), wob: $('[data-s="wob"]', sec), lag: $('[data-s="lag"]', sec) };
});
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  for (const p of panels) {
    const r = p.cv.getBoundingClientRect();
    p.cv.width = Math.max(1, Math.round(r.width * dpr)); p.cv.height = Math.max(1, Math.round(r.height * dpr));
    p.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  S.dirty = true;
}
new ResizeObserver(resize).observe($('.panels'));
resize();

function render() {
  if (S.dirty) {
    S.dirty = false;
    for (const p of panels) {
      const c = p.ctx, w = p.cv.clientWidth, h = p.cv.clientHeight;
      c.clearRect(0, 0, w, h);
      c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = 3; c.strokeStyle = COLOR[p.k];
      for (const s of S.strokes) {
        const L = p.k === 'steady' && s.anim ? s.anim : s[p.k]; if (!L.length) continue;
        c.beginPath(); c.moveTo(L[0].x / MM_PER_PX, L[0].y / MM_PER_PX);
        for (let i = 1; i < L.length; i++) c.lineTo(L[i].x / MM_PER_PX, L[i].y / MM_PER_PX);
        if (L.length === 1) c.lineTo(L[0].x / MM_PER_PX + 0.01, L[0].y / MM_PER_PX);
        c.stroke();
      }
      const s = S.cur;
      if (s && s.pen.length) {             // where the pen really is
        const q = s.pen[s.pen.length - 1];
        c.lineWidth = 2; c.strokeStyle = 'rgba(27,27,31,.75)';
        c.beginPath(); c.arc(q.x / MM_PER_PX, q.y / MM_PER_PX, 7, 0, Math.PI * 2); c.stroke();
      }
    }
  }
  for (const s of S.strokes) if (s.anim0 != null) {   // settling animation of Steady's line
    const u = Math.min(1, (performance.now() - s.anim0) / SETTLE_MS), e = 1 - (1 - u) ** 3;
    s.anim = s.from.map((q, i) => ({ x: q.x + (s.steady[i].x - q.x) * e, y: q.y + (s.steady[i].y - q.y) * e }));
    if (u >= 1) { s.anim0 = null; s.anim = null; }
    S.dirty = true;
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

// ---------------------------------------------------------------- measurement
// distance from point a to segment p-q
function segDist(a, p, q) {
  const vx = q.x - p.x, vy = q.y - p.y, L2 = vx * vx + vy * vy;
  const u = L2 > 0 ? Math.max(0, Math.min(1, ((a.x - p.x) * vx + (a.y - p.y) * vy) / L2)) : 0;
  return Math.hypot(a.x - p.x - u * vx, a.y - p.y - u * vy);
}
// Shakiness of sample i of line L: nearest distance to the meant path within +-NEAR_S. Scored once the path
// NEAR_S after it exists, so a line that is behind is compared with where the pen went, not with an unfinished path.
function scoreUpTo(s, upto) {
  for (const k of KINDS) {
    const L = s[k], acc = s.acc[k];
    while (s.scored[k] < L.length && (upto === Infinity || s.t[s.scored[k]] <= upto - NEAR_S)) {
      const i = s.scored[k], a = L[i];
      let lo = i, hi = i;
      while (lo > 0 && s.t[i] - s.t[lo - 1] <= NEAR_S) lo--;
      while (hi < s.pen.length - 1 && s.t[hi + 1] - s.t[i] <= NEAR_S) hi++;
      let d = Math.hypot(a.x - s.pen[lo].x, a.y - s.pen[lo].y);
      for (let j = lo; j < hi; j++) d = Math.min(d, segDist(a, s.pen[j], s.pen[j + 1]));
      acc.wob += d; acc.nW++; s.scored[k]++;
    }
  }
}
function showStats() {
  const v = {};
  for (const k of KINDS) {
    const a = { wob: 0, nW: 0, lag: S.sum[k].lag, nL: S.sum[k].nL };
    for (const s of S.strokes) { a.wob += s.acc[k].wob; a.nW += s.acc[k].nW; }
    v[k] = { wob: a.nW ? a.wob / a.nW : null, lag: a.nL ? Math.max(0, a.lag / a.nL) : null };
  }
  for (const key of ['wob', 'lag']) {
    const vals = KINDS.map((k) => v[k][key]).filter((x) => x != null), best = Math.min(...vals), worst = Math.max(...vals);
    for (const p of panels) {
      const x = v[p.k][key];
      p[key].textContent = x == null ? '–' : `${x < 10 ? x.toFixed(1) : x.toFixed(0)} mm`;
      p[key].className = x == null || vals.length < 3 || worst - best < 0.3 ? '' : x === best ? 'good' : x === worst ? 'bad' : '';
    }
  }
}
// Shake speed, measured from the drawn shake the way the drawing app does it (js/shakefreq.js)
function measureHz() {
  const H = S.hist, periods = []; let spec = null, sq = 0, n = 0, i = 0;
  while (i < H.length) {
    let j = i + 1; while (j < H.length && H[j].t - H[j - 1].t < 0.1) j++;
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
function showHz() {
  measureHz();
  const el = $('#hz'), info = steadyF.info();
  const drawing = steadyF.fx.intent ? Math.max(steadyF.fx.intent(), steadyF.fy.intent()) : 0;
  if (!S.strokes.length) el.textContent = '';
  else if (drawing > 0.5) el.textContent = 'keeping a big, slow movement as drawing';
  // claim a shake only when Steady has locked on AND a shake is measurable in the drawn line itself
  else if (S.hz && info && Number.isFinite(info.f0) && info.conf >= 0.5 && info.amp >= CLAIM_MM) el.textContent = `removing a ${S.hz.toFixed(1)} Hz shake`;
  else el.textContent = 'no shake found: leaving your line alone';
}
setInterval(() => { if (S.cur) scoreUpTo(S.cur, S.cur.t[S.cur.t.length - 1]); showStats(); showHz(); }, 250);

// ---------------------------------------------------------------- input
function ingest(ev, cv) {
  const t = (ev.__testT ?? ev.timeStamp) / 1000;   // __testT: synthetic events in automated checks only
  if (!(t > S.lastT)) return;
  S.lastT = t;
  const r = cv.getBoundingClientRect(), s = S.cur;
  const pen = { x: (ev.clientX - r.left) * MM_PER_PX, y: (ev.clientY - r.top) * MM_PER_PX };
  const spd = speedEst.update(t, pen.x, pen.y);
  let hx = pen.x, hy = pen.y;
  if (S.hand !== 'none') { const [dx, dy] = tremorGen.offset(t, spd); hx += dx; hy += dy; }
  const [sx, sy] = steadyF.step(t, hx, hy), [ex, ey] = emaF.step(t, hx, hy);
  const out = { raw: { x: hx, y: hy }, ema: { x: Number.isFinite(ex) ? ex : hx, y: Number.isFinite(ey) ? ey : hy },
    steady: { x: Number.isFinite(sx) ? sx : hx, y: Number.isFinite(sy) ? sy : hy } };
  // behind your pen: (line - pen) along the pen's direction of movement, negative = behind; only while moving
  const n = s.pen.length;
  if (n >= 3 && spd > MOVING_MM_S) {
    const a = s.pen[Math.max(0, n - 4)], vx = pen.x - a.x, vy = pen.y - a.y, L = Math.hypot(vx, vy);
    if (L > 0) for (const k of KINDS) { const acc = S.sum[k]; acc.lag -= ((out[k].x - pen.x) * vx + (out[k].y - pen.y) * vy) / L; acc.nL++; }
  }
  s.t.push(t); s.pen.push(pen);
  for (const k of KINDS) s[k].push(out[k]);
  S.hist.push({ t, x: hx, y: hy });
  while (S.hist.length && S.hist[0].t < t - 4) S.hist.shift();
  S.dirty = true;
}
for (const p of panels) {
  const cv = p.cv;
  cv.addEventListener('pointerdown', (e) => {
    if (S.pointerId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch {}
    S.pointerId = e.pointerId; S.lastT = -Infinity;
    speedEst.reset(); steadyF.startStroke(); emaF.startStroke();
    S.cur = { cv, t: [], pen: [], raw: [], ema: [], steady: [], scored: { raw: 0, ema: 0, steady: 0 },
      acc: Object.fromEntries(KINDS.map((k) => [k, { wob: 0, nW: 0 }])) };
    S.strokes.push(S.cur);
    ingest(e, cv);
  });
  cv.addEventListener('pointermove', (e) => {
    if (e.pointerId !== S.pointerId || !S.cur) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ce of (evs.length ? evs : [e])) ingest(ce, cv);
  });
  const end = (e) => {
    if (e.pointerId !== S.pointerId) return;
    S.pointerId = null;
    const s = S.cur; S.cur = null;
    if (s) { settleSteady(s); scoreUpTo(s, Infinity); }
    S.dirty = true; showStats(); showHz();
    if (!S.prompted && S.strokes.length >= 2) {
      S.prompted = true;
      $('#prompt').textContent = 'The ring is your pen. Normal smoothing trails behind it; Steady keeps up and still removes the shake.';
    }
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Pen up: Steady's stroke settles (zero-phase smoothing tuned to the detected tremor, limited to 2 x its size + 0.5 mm),
// the same call as the drawing app. Its shakiness is then re-scored on the settled line.
function settleSteady(s) {
  if (s.t.length < 3) return;
  const prm = { ...adaptiveParams(steadyF, SETTLE_K), base: SETTLE_BASE };
  const [xs, ys] = adaptiveSettle(s.t, s.steady.map((p) => p.x), s.steady.map((p) => p.y), prm);
  const to = clampTo(s.steady, xs, ys, clampMm(tremorAmp(steadyF)));
  s.from = s.steady; s.steady = to.map((p) => ({ x: p.x, y: p.y }));
  s.acc.steady = { wob: 0, nW: 0 }; s.scored.steady = 0;
  if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) s.anim0 = performance.now();
}

// ---------------------------------------------------------------- controls
const handBox = $('.hand');
for (const [k, name] of HANDS) {
  const b = document.createElement('button'); b.dataset.k = k; b.textContent = name;
  b.addEventListener('click', () => {
    S.hand = k;
    if (k !== 'none') tremorGen.p = { ...PRESETS[k] };
    syncHand();
  });
  handBox.appendChild(b);
}
function syncHand() { for (const b of handBox.children) b.setAttribute('aria-pressed', String(b.dataset.k === S.hand)); }
syncHand();
$('#next').addEventListener('click', () => {
  S.strokes = []; S.cur = null; S.pointerId = null; S.hist = []; S.hz = null; S.prompted = false; resetSums(); freshFilters();
  $('#prompt').textContent = 'Write your name, or draw a star, in any box.';
  S.dirty = true; showStats(); showHz();
});
showStats();

// Save picture: the three boxes side by side with their names and numbers, redrawn at 3x for printing on the board.
const NAMES = { raw: 'Your hand, no help', ema: 'Normal smoothing', steady: 'Steady' };
function picture(scale = 3) {
  const w = panels[0].cv.clientWidth, h = panels[0].cv.clientHeight, gap = 24, head = 44, foot = 56, pad = 24;
  const out = document.createElement('canvas');
  out.width = Math.round((pad * 2 + w * 3 + gap * 2) * scale); out.height = Math.round((pad * 2 + head + h + foot) * scale);
  const c = out.getContext('2d'); c.scale(scale, scale);
  c.fillStyle = '#fff'; c.fillRect(0, 0, out.width, out.height);
  panels.forEach((p, i) => {
    const x0 = pad + i * (w + gap), y0 = pad + head;
    c.fillStyle = COLOR[p.k]; c.font = '600 20px -apple-system, "Segoe UI", Roboto, Arial, sans-serif'; c.fillText(NAMES[p.k], x0, pad + 26);
    c.strokeStyle = '#d9d9de'; c.lineWidth = 1; c.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
    c.save(); c.beginPath(); c.rect(x0, y0, w, h); c.clip(); c.translate(x0, y0);
    c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = 3; c.strokeStyle = COLOR[p.k];
    for (const s of S.strokes) {
      const L = s[p.k]; if (!L.length) continue;
      c.beginPath(); c.moveTo(L[0].x / MM_PER_PX, L[0].y / MM_PER_PX);
      for (let j = 1; j < L.length; j++) c.lineTo(L[j].x / MM_PER_PX, L[j].y / MM_PER_PX);
      c.stroke();
    }
    c.restore();
    c.fillStyle = '#1b1b1f'; c.font = '16px -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
    c.fillText(`Shakiness ${p.wob.textContent}   ·   Behind your pen ${p.lag.textContent}`, x0, y0 + h + 30);
  });
  const hand = HANDS.find(([k]) => k === S.hand)[1];
  c.fillStyle = '#5f6066'; c.font = '13px -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  c.fillText(`Same movement, three ways. Hand: ${hand}${S.hand === 'none' ? '' : ' (simulated from published tremor data)'}. Steady science fair project.`, pad, pad + head + h + foot - 4);
  return out;
}
$('#savePic').addEventListener('click', () => {
  if (!S.strokes.length) { $('#prompt').textContent = 'Draw something first, then save the picture.'; return; }
  picture().toBlob((b) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'steady-three-ways.png';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
});

// automated checks only (tests drive synthetic events through the real handlers)
window.__booth = { S, panels, picture };
