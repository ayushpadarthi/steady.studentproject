// "Compare filters on this drawing": re-run fresh filters over the identical recorded input samples
// and compute two honest numbers per filter: wiggle and lag vs raw.
import { Filter2D } from './filters.js';

export const COMPARE_FILTERS = [
  ['raw', 'Raw (no filter)'], ['ema', 'EMA (2 Hz)'], ['one_euro', 'One-euro'], ['steady', 'Steady'],
];
export const WIGGLE_WINDOW_S = 0.33;
export const MAX_LAG_S = 0.2;

/** strokes: [{samples:[[t,x,y],...]}] -> same shape with filtered samples (non-finite outputs dropped). One filter across strokes. */
export function runFilter(name, strokes) {
  const f = new Filter2D(name);
  return strokes.map((s) => {
    f.startStroke();
    const out = [];
    for (const [t, x, y] of s.samples) {
      const [fx, fy] = f.step(t, x, y);
      if (Number.isFinite(fx) && Number.isFinite(fy)) out.push([t, fx, fy]);
    }
    return out;
  });
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

/** Full analysis: returns [{key,label,out,wiggle,lag}] */
export function analyse(rec) {
  const rawOut = rec.map((s) => s.samples.map(([t, x, y]) => [t, x, y]));
  return COMPARE_FILTERS.map(([key, label]) => {
    const out = key === 'raw' ? rawOut : runFilter(key, rec);
    return { key, label, out, wiggle: wiggle(out), lag: key === 'raw' ? 0 : lagVsRaw(out, rawOut) };
  });
}

function bounds(res) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of res) for (const p of r.out) for (const [, x, y] of p) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function drawPanel(canvas, res, rawOut, b, color = '#14213d') {
  const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  const pad = 12, bw = Math.max(b.x1 - b.x0, 1), bh = Math.max(b.y1 - b.y0, 1);
  const sc = Math.min((r.width - 2 * pad) / bw, (r.height - 2 * pad) / bh);
  const ox = (r.width - bw * sc) / 2 - b.x0 * sc, oy = (r.height - bh * sc) / 2 - b.y0 * sc;
  const line = (paths, col, w) => {
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineJoin = ctx.lineCap = 'round';
    for (const p of paths) {
      if (p.length < 2) continue;
      ctx.beginPath();
      p.forEach(([, x, y], i) => (i ? ctx.lineTo(x * sc + ox, y * sc + oy) : ctx.moveTo(x * sc + ox, y * sc + oy)));
      ctx.stroke();
    }
  };
  if (res.key !== 'raw') line(rawOut, '#d4d4d8', 1);
  line(res.out, color, 1.8);
}

/** Opens the overlay. Returns a close function. `rec` = [{samples:[[t,x_mm,y_mm],...]}] */
export function openCompare(rec, onClose) {
  const ov = document.createElement('div');
  ov.id = 'cmpOverlay'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Compare filters on this drawing');
  const head = document.createElement('div'); head.className = 'cmp-head';
  const h = document.createElement('h2'); h.textContent = 'Compare filters on this drawing';
  const close = document.createElement('button'); close.textContent = 'Close'; close.id = 'cmpClose';
  head.append(h, close);
  const cap = document.createElement('p'); cap.className = 'cmp-cap';
  cap.textContent = 'Same hand movement, four filters. Smoother is not automatically better: lag means the line trails your hand.';
  const grid = document.createElement('div'); grid.className = 'cmp-grid';
  ov.append(head, cap, grid);
  document.body.appendChild(ov);

  const res = analyse(rec), b = bounds(res), rawOut = res[0].out;
  const canvases = res.map((r) => {
    const panel = document.createElement('figure'); panel.className = 'cmp-panel';
    const title = document.createElement('figcaption'); title.className = 'cmp-title'; title.textContent = r.label;
    const c = document.createElement('canvas');
    const st = document.createElement('div'); st.className = 'cmp-stats';
    const fmt = (v, d, u) => (Number.isFinite(v) ? `${v.toFixed(d)} ${u}` : '-');
    st.innerHTML = '';
    const w = document.createElement('span'); w.textContent = `wiggle ${fmt(r.wiggle, 3, 'mm')}`; w.className = 'cmp-wig';
    const l = document.createElement('span'); l.className = 'cmp-lag';
    l.textContent = r.key === 'raw' ? 'lag vs raw 0 ms (reference)' : `lag vs raw ${fmt(r.lag, 0, 'ms')}`;
    st.append(w, l);
    panel.append(title, c, st); grid.appendChild(panel);
    return c;
  });
  const paint = () => res.forEach((r, i) => drawPanel(canvases[i], r, rawOut, b));
  paint();
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
