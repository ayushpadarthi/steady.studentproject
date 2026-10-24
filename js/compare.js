// "Compare filters on this drawing": re-run fresh filters over the identical recorded input samples.
// Two views of every filter:
//   While drawing  the line as it appears under the pen (what lag is about)
//   Final line     what stays on the page after pen-up. Only Steady has an after-pen-up step (ink settling with
//                  the shake-size limit, exactly as in the drawing app's "Smooth" setting); for the others the
//                  final line is the same as the live line.
// Numbers: wiggle (RMS distance from the line's own 0.33 s moving average: lower = smoother), lag while drawing
// (time shift vs the raw input), and accuracy (RMS distance from the intended line, only known when the shake is
// simulated, because then the lab also records where the hand really was).
import { Filter2D } from './filters.js?v=13';
import { adaptiveParams, adaptiveSettle, clampTo, clampMm, tremorAmp } from './settle.js?v=13';

export const COMPARE_FILTERS = [
  ['raw', 'No filter (raw)'], ['ema', 'Moving average (2 Hz)'], ['one_euro', 'One-Euro filter'], ['steady', 'Steady'],
];
export const WIGGLE_WINDOW_S = 0.33;
export const MAX_LAG_S = 0.2;

/** strokes: [{samples:[[t,x,y,(ix,iy)],...]}] -> {live, final}: per stroke [[t,x,y],...] (non-finite outputs dropped).
 *  One filter across strokes (like the app). Steady's final line = settled live line (k 0.5, base 8 Hz, limited). */
export function runFilter(name, strokes) {
  const f = new Filter2D(name), live = [], final = [];
  for (const s of strokes) {
    f.startStroke();
    const out = [];
    for (const [t, x, y] of s.samples) {
      const [fx, fy] = f.step(t, x, y);
      if (Number.isFinite(fx) && Number.isFinite(fy)) out.push([t, fx, fy]);
    }
    live.push(out);
    if (name === 'steady' && out.length >= 3) {
      const [xs, ys] = adaptiveSettle(out.map((p) => p[0]), out.map((p) => p[1]), out.map((p) => p[2]), adaptiveParams(f, 0.5));
      const lim = clampTo(out.map(([, x, y]) => ({ x, y })), xs, ys, clampMm(tremorAmp(f)));
      final.push(out.map(([t], i) => [t, lim[i].x, lim[i].y]));
    } else final.push(out);
  }
  return { live, final };
}

/** RMS distance (mm) of the output from its own centred moving average over `win` seconds (per stroke, window shrinks at the ends). */
export function wiggle(outStrokes, win = WIGGLE_WINDOW_S) {
  let sum = 0, n = 0;
  for (const p of outStrokes) {
    if (p.length < 3) continue;
    const pre = [[0, 0]];
    for (const [, x, y] of p) { const l = pre[pre.length - 1]; pre.push([l[0] + x, l[1] + y]); }
    let lo = 0, hi = 0; // window [lo, hi)
    for (let i = 0; i < p.length; i++) {
      const t = p[i][0];
      while (lo < p.length && p[lo][0] < t - win / 2) lo++;
      while (hi < p.length && p[hi][0] <= t + win / 2) hi++;
      const c = hi - lo;
      if (c < 3) continue;
      const mx = (pre[hi][0] - pre[lo][0]) / c, my = (pre[hi][1] - pre[lo][1]) / c;
      sum += (p[i][1] - mx) ** 2 + (p[i][2] - my) ** 2; n++;
    }
  }
  return n ? Math.sqrt(sum / n) : NaN;
}

function interp(p, t, cursor) {
  // p sorted by t; cursor.i is a monotone hint for increasing t
  let i = cursor.i;
  while (i + 1 < p.length && p[i + 1][0] <= t) i++;
  cursor.i = i;
  if (i + 1 >= p.length) return [p[p.length - 1][1], p[p.length - 1][2]];
  const a = p[i], b = p[i + 1], u = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
  return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

/** Time shift in ms (0..200) of the raw path that best matches the filtered path (min mean squared distance). */
export function lagVsRaw(outStrokes, rawStrokes, stepMs = 2) {
  let best = 0, bestErr = Infinity;
  for (let ms = 0; ms <= MAX_LAG_S * 1000; ms += stepMs) {
    const s = ms / 1000;
    let err = 0, n = 0;
    for (let k = 0; k < outStrokes.length; k++) {
      const o = outStrokes[k], r = rawStrokes[k];
      if (!o.length || r.length < 2) continue;
      const cur = { i: 0 };
      for (const [t, x, y] of o) {
        const tt = t - s;
        if (tt < r[0][0]) continue;
        const [rx, ry] = interp(r, tt, cur);
        err += (x - rx) ** 2 + (y - ry) ** 2; n++;
      }
    }
    if (n >= 5 && err / n < bestErr) { bestErr = err / n; best = ms; }
  }
  return bestErr === Infinity ? NaN : best;
}

/** RMS distance (mm) from each output point to the nearest point of the intended path (same stroke), or NaN. */
export function accuracy(outStrokes, intended) {
  if (!intended) return NaN;
  let sum = 0, n = 0;
  outStrokes.forEach((o, k) => {
    const ip = intended[k];
    if (!ip || ip.length < 2) return;
    for (const [, x, y] of o) {
      let best = Infinity;
      for (let j = 1; j < ip.length; j++) { // distance to segment j-1..j
        const [ax, ay] = ip[j - 1], [bx, by] = ip[j], vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy;
        const u = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L)) : 0;
        const d = (x - ax - u * vx) ** 2 + (y - ay - u * vy) ** 2;
        if (d < best) best = d;
      }
      sum += best; n++;
    }
  });
  return n ? Math.sqrt(sum / n) : NaN;
}

/** Full analysis: returns [{key,label,live,final,wiggle:{live,final},lag,acc:{live,final}}] */
export function analyse(rec) {
  const rawOut = rec.map((s) => s.samples.map(([t, x, y]) => [t, x, y]));
  const known = rec.length && rec.every((s) => s.samples.every((q) => q.length >= 5));
  const intended = known ? rec.map((s) => s.samples.map((q) => [q[3], q[4]])) : null;
  return COMPARE_FILTERS.map(([key, label]) => {
    const { live, final } = key === 'raw' ? { live: rawOut, final: rawOut } : runFilter(key, rec);
    return {
      key, label, live, final, settles: key === 'steady',
      wiggle: { live: wiggle(live), final: wiggle(final) },
      lag: key === 'raw' ? 0 : lagVsRaw(live, rawOut),
      acc: { live: accuracy(live, intended), final: accuracy(final, intended) },
    };
  });
}

function bounds(res) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of res) for (const p of r.live) for (const [, x, y] of p) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function drawPanel(canvas, paths, rawOut, b, isRaw, color = '#14213d') {
  const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  const pad = 12, bw = Math.max(b.x1 - b.x0, 1), bh = Math.max(b.y1 - b.y0, 1);
  const sc = Math.min((r.width - 2 * pad) / bw, (r.height - 2 * pad) / bh);
  const ox = (r.width - bw * sc) / 2 - b.x0 * sc, oy = (r.height - bh * sc) / 2 - b.y0 * sc;
  const line = (ps, col, w) => {
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineJoin = ctx.lineCap = 'round';
    for (const p of ps) {
      if (p.length < 2) continue;
      ctx.beginPath();
      p.forEach(([, x, y], i) => (i ? ctx.lineTo(x * sc + ox, y * sc + oy) : ctx.moveTo(x * sc + ox, y * sc + oy)));
      ctx.stroke();
    }
  };
  if (!isRaw) line(rawOut, '#d4d4d8', 1);
  line(paths, color, 1.8);
}

/** Opens the overlay. Returns a close function. `rec` = [{samples:[[t,x_mm,y_mm,(ix,iy)],...]}] */
export function openCompare(rec, onClose) {
  const ov = document.createElement('div');
  ov.id = 'cmpOverlay'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Compare filters on this drawing');
  const head = document.createElement('div'); head.className = 'cmp-head';
  const h = document.createElement('h2'); h.textContent = 'Compare filters on this drawing';
  const close = document.createElement('button'); close.textContent = 'Close'; close.id = 'cmpClose';
  head.append(h, close);
  const views = document.createElement('div'); views.className = 'cmp-views'; views.setAttribute('role', 'group'); views.setAttribute('aria-label', 'Which line to show');
  const bLive = document.createElement('button'), bFinal = document.createElement('button');
  bLive.textContent = 'While drawing'; bFinal.textContent = 'Final line (after pen-up)';
  views.append(bLive, bFinal);
  const cap = document.createElement('p'); cap.className = 'cmp-cap';
  const grid = document.createElement('div'); grid.className = 'cmp-grid';
  ov.append(head, views, cap, grid);
  document.body.appendChild(ov);

  const res = analyse(rec), b = bounds(res), rawOut = res[0].live;
  const known = Number.isFinite(res[0].acc.live);
  let view = 'final';
  const fmt = (v, d, u) => (Number.isFinite(v) ? `${v.toFixed(d)} ${u}` : '-');
  const panels = res.map((r) => {
    const panel = document.createElement('figure'); panel.className = 'cmp-panel';
    const title = document.createElement('figcaption'); title.className = 'cmp-title';
    const c = document.createElement('canvas');
    const st = document.createElement('div'); st.className = 'cmp-stats';
    const w = document.createElement('span'), a = document.createElement('span'), l = document.createElement('span');
    w.className = 'cmp-wig'; a.className = 'cmp-acc'; l.className = 'cmp-lag';
    st.append(w, a, l); panel.append(title, c, st); grid.appendChild(panel);
    return { r, title, c, w, a, l };
  });
  function paint() {
    bLive.setAttribute('aria-pressed', String(view === 'live')); bFinal.setAttribute('aria-pressed', String(view === 'final'));
    cap.textContent = (view === 'live'
      ? 'The line as it appears under the pen. Heavy smoothing looks calm here, but it trails your hand (lag).'
      : 'What stays on the page. Only Steady has an after-pen-up step (it settles the stroke); for the others the final line is the same as while drawing.')
      + (known ? ' Off the line = distance from where the hand really meant to go (known because the shake is simulated).'
        : ' Turn on simulated tremor to also measure accuracy (the true line is only known then).');
    for (const p of panels) {
      const { r } = p;
      p.title.textContent = r.label + (view === 'final' && r.settles ? ' (settled after pen-up)' : '');
      p.w.textContent = `wiggle ${fmt(r.wiggle[view], 2, 'mm')}`;
      p.a.textContent = known ? `off the line ${fmt(r.acc[view], 2, 'mm')}` : '';
      p.l.textContent = r.key === 'raw' ? 'lag 0 ms (reference)' : `lag while drawing ${fmt(r.lag, 0, 'ms')}`;
      drawPanel(p.c, r[view], rawOut, b, r.key === 'raw');
    }
  }
  paint();
  bLive.addEventListener('click', () => { view = 'live'; paint(); });
  bFinal.addEventListener('click', () => { view = 'final'; paint(); });
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeFn(); } };
  const onResize = () => paint();
  function closeFn() {
    document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize);
    ov.remove(); onClose && onClose();
  }
  document.addEventListener('keydown', onKey); window.addEventListener('resize', onResize);
  close.addEventListener('click', closeFn);
  close.focus();
  return { close: closeFn, results: res };
}
