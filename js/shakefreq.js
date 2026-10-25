// Shake speed (Hz) measured from the drawn shake itself, independent of Steady (spiral check-in, since 2026-10-25).
// Two checks before a speed is shown: the cycles must be regular enough (zero crossings), and the shake's energy must
// be concentrated near one frequency (a tremor is; random noise is not: in tests noise scored <= 0.21, simulated
// tremor presets >= 0.41, so the cut-off is 0.3).
const FREQS = []; for (let f = 2; f <= 15.0001; f += 0.25) FREQS.push(f);
export const CONC_MIN = 0.3;

function mainDirection(x, y) {
  const n = x.length; let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += x[i] * x[i]; syy += y[i] * y[i]; sxy += x[i] * y[i]; }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy), c = Math.cos(a), s = Math.sin(a);
  return x.map((v, i) => v * c + y[i] * s);
}
/** Power of the shake (main direction) at 2-15 Hz in 0.25 Hz steps; add strokes' arrays together. */
export function shakeSpectrum(t, x, y) {
  if (t.length < 20) return FREQS.map(() => 0);
  const u = mainDirection(x, y);
  return FREQS.map((f) => { let re = 0, im = 0; for (let i = 0; i < t.length; i++) { const w = 2 * Math.PI * f * t[i]; re += u[i] * Math.cos(w); im -= u[i] * Math.sin(w); } return re * re + im * im; });
}
/** Share of 2-15 Hz power within 1 Hz of the strongest 3-12 Hz frequency (1 = a pure tone). */
export function concentration(P) {
  let k = -1; for (let i = 0; i < P.length; i++) if (FREQS[i] >= 3 && FREQS[i] <= 12 && (k < 0 || P[i] > P[k])) k = i;
  const tot = P.reduce((a, b) => a + b, 0); if (!(tot > 0) || k < 0) return 0;
  let near = 0; for (let i = 0; i < P.length; i++) if (Math.abs(FREQS[i] - FREQS[k]) <= 1) near += P[i];
  return near / tot;
}
/** Cycle lengths (s) of the shake in one stroke: project the shake on its main direction, then time between upward
 *  zero crossings, with a small hysteresis so pixel-level noise does not count as cycles. Keeps 3-12 Hz only. */
export function shakePeriods(t, x, y) {
  const n = t.length; if (n < 20) return [];
  const u = mainDirection(x, y);
  const h = 0.25 * Math.sqrt(u.reduce((q, v) => q + v * v, 0) / n);
  const out = []; let armed = false, last = null;
  for (let i = 1; i < n; i++) {
    if (u[i] < -h) armed = true;
    if (armed && u[i - 1] < h && u[i] >= h) {                     // upward crossing of +h after being below -h
      const tc = t[i - 1] + (t[i] - t[i - 1]) * (h - u[i - 1]) / (u[i] - u[i - 1]);
      if (last !== null) { const T = tc - last; if (T >= 1 / 12 && T <= 1 / 3) out.push(T); }
      last = tc; armed = false;
    }
  }
  return out;
}
/** Frequency (Hz) from cycle lengths, or null when there is no clear rhythm. spectrum: summed shakeSpectrum (optional). */
export function frequencyFromPeriods(P, spectrum = null) {
  if (P.length < 8) return null;
  if (spectrum && concentration(spectrum) < CONC_MIN) return null;
  const q = [...P].sort((a, b) => a - b), med = q[Math.floor(q.length / 2)];
  const steady = P.filter((T) => Math.abs(T - med) <= 0.25 * med).length / P.length;
  return steady >= 0.5 ? 1 / med : null;
}
