// Ink settling: smooth a FINISHED stroke after the pen lifts. Exact port of software/core/steady/settle.py
// (parity vs software/shared/test_vectors/settle.json). While drawing, lag matters, so the live line stays fast;
// after pen-up there is no lag to worry about, so the whole stroke is low-passed forwards and backwards
// (zero phase). The amount follows the tremor Steady detected (same rule as steady/eval_settle.py).
export const FS = 120, PAD_S = 0.25;
export const K = 0.5, BASE_FC = 8.0, LO = 0.1, HI = 0.3;

export function butter2(fc, fs = FS) {
  const k = Math.tan(Math.PI * fc / fs), q = 1 / Math.sqrt(2), n = 1 / (1 + k / q + k * k), b0 = k * k * n;
  return { b: [b0, 2 * b0, b0], a: [2 * (k * k - 1) * n, (1 - k / q + k * k) * n] };
}

function biquad(x, { b, a }) {
  const y = new Float64Array(x.length);
  let x1 = x[0], x2 = x[0], y1 = x[0], y2 = x[0];
  for (let i = 0; i < x.length; i++) {
    const v = x[i], o = b[0] * v + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o;
  }
  return y;
}

export function zeroPhase(x, fc, fs = FS, padS = PAD_S) {
  const n = x.length, p = Math.min(n - 1, Math.round(padS * fs));
  let ext = Float64Array.from(x);
  if (p > 0) {
    ext = new Float64Array(n + 2 * p);
    for (let i = 0; i < p; i++) ext[i] = 2 * x[0] - x[p - i];
    ext.set(x, p);
    for (let i = 0; i < p; i++) ext[n + p + i] = 2 * x[n - 1] - x[n - 2 - i];
  }
  const co = butter2(fc, fs);
  const y = biquad(biquad(ext, co).reverse(), co).reverse();
  return p > 0 ? y.subarray(p, p + n) : y;
}

function interp(xq, xs, ys) { // numpy.interp for increasing xs and increasing xq
  const out = new Float64Array(xq.length); let j = 0;
  for (let i = 0; i < xq.length; i++) {
    const v = xq[i];
    if (v <= xs[0]) { out[i] = ys[0]; continue; }
    if (v >= xs[xs.length - 1]) { out[i] = ys[ys.length - 1]; continue; }
    while (xs[j + 1] < v) j++;
    while (j > 0 && xs[j] > v) j--;
    const u = (v - xs[j]) / (xs[j + 1] - xs[j]);
    out[i] = ys[j] + u * (ys[j + 1] - ys[j]);
  }
  return out;
}

/** t: increasing times (s); xs, ys: positions. Returns [xs', ys'] (Float64Array) at the same times. */
export function settle(t, xs, ys, fc = 3.0, fs = FS) {
  const n = t.length;
  if (n < 3 || ![...xs, ...ys].every(Number.isFinite)) return [Float64Array.from(xs), Float64Array.from(ys)];
  const m = Math.max(2, Math.floor((t[n - 1] - t[0]) * fs) + 1);
  const tg = new Float64Array(m); for (let i = 0; i < m; i++) tg[i] = t[0] + i / fs;
  return [xs, ys].map((v) => interp(t, tg, zeroPhase(interp(tg, t, v), fc, fs)));
}

/** {fc, w} from a Filter2D('steady') (per-axis read-outs; the axis with the larger tremor decides). */
export function adaptiveParams(f2d, k = K) {
  const amps = [f2d.fx.tremor_amp_mm(), f2d.fy.tremor_amp_mm()], i = amps[1] > amps[0] ? 1 : 0;
  const amp = amps[i], hz = (i ? f2d.fy : f2d.fx).tremor_hz();
  const w = Number.isFinite(amp) ? Math.min(1, Math.max(0, (amp - LO) / (HI - LO))) : 0;
  const fc = Number.isFinite(hz) ? Math.min(6, Math.max(2, k * hz)) : BASE_FC;
  return { fc, w };
}

/** Settled stroke: w * settle(fc) + (1 - w) * settle(base). base defaults to BASE_FC (the evaluated setting);
 *  the drawing app's "Extra smooth" passes a lower base so it smooths visibly even with no tremor detected. */
export function adaptiveSettle(t, xs, ys, { fc, w, base = BASE_FC }) {
  const [ax, ay] = settle(t, xs, ys, fc), [bx, by] = settle(t, xs, ys, base);
  return [ax.map((v, i) => w * v + (1 - w) * bx[i]), ay.map((v, i) => w * v + (1 - w) * by[i])];
}

// Shake-size limit (same as clamp_to/clamp_mm in settle.py): settling may move a point at most
// 2 x detected tremor amplitude + 0.5 mm, so fast intended motion (e.g. colouring back and forth) keeps its shape.
export const CLAMP_K = 2.0, CLAMP_MIN_MM = 0.5;
export function clampMm(ampMm) { return CLAMP_K * (Number.isFinite(ampMm) ? ampMm : 0) + CLAMP_MIN_MM; }
/** live, settled: arrays of {x, y} (any unit); max in the same unit. Returns new {x, y} points. */
export function clampTo(live, xs, ys, max) {
  return live.map((p, i) => {
    const dx = xs[i] - p.x, dy = ys[i] - p.y, n = Math.hypot(dx, dy), k = n > max ? max / n : 1;
    return { ...p, x: p.x + dx * k, y: p.y + dy * k };
  });
}
/** Max detected tremor amplitude (mm) of a Filter2D('steady'). */
export function tremorAmp(f2d) { return Math.max(f2d.fx.tremor_amp_mm(), f2d.fy.tremor_amp_mm()); }
