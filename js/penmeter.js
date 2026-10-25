// "Truth meter" for the tremor pen (hardware/firmware/steady_pen v2): estimates the frequency (Hz) and peak size
// (mm at the stylus tip) of the shake from
//   - the pen's gyro (S lines): the servo rocks the stylus, so the rocking shows up as rotation about one gyro
//     axis. We pick the axis with the most 3-12 Hz energy, integrate it to an angle, and convert the angle to
//     tip movement with the arm length (shaft-to-tip distance): mm = arm_mm * angle_rad;
//   - the commanded tip offset (C lines), i.e. what the pen was asked to do.
// Method, both signals: last WINDOW_S seconds, remove slow motion with a zero-phase high-pass (signal minus its
// 2nd-order Butterworth low-pass at HP_HZ run forwards and backwards, js/settle.js), peak size = sqrt(2) x RMS,
// frequency = upward crossings with hysteresis (same idea as js/shakestyle.js). Leak from slow motion at 4 Hz is
// about 2 %; tremor below ~3 Hz is partly removed.
import { zeroPhase } from './settle.js?v=19';
export const WINDOW_S = 2.5, HP_HZ = 1.5;

function movingAvgRemove(t, v) {   // name kept: = high-pass. Assumes roughly even sampling (the pen's are).
  const n = v.length;
  if (n < 8) return Float64Array.from(v);
  const fs = (n - 1) / Math.max(1e-6, t[n - 1] - t[0]);
  const lp = zeroPhase(Float64Array.from(v), HP_HZ, fs, 0.5);
  return Float64Array.from(v, (x, i) => x - lp[i]);
}
/** {hz, mm} of a zero-mean oscillation x(t) (any unit; mm out = same unit). NaN when there is too little data. */
export function oscillation(t, x) {
  if (t.length < 20 || t[t.length - 1] - t[0] < 0.8) return { hz: NaN, mm: NaN };
  let s2 = 0; for (const v of x) s2 += v * v;
  const rms = Math.sqrt(s2 / x.length), env = Math.SQRT2 * rms;
  let armed = false, first = NaN, last = NaN, n = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] < -0.3 * env) armed = true;
    else if (armed && x[i] > 0.3 * env) { armed = false; if (!n) first = t[i]; last = t[i]; n++; }
  }
  return { hz: n > 2 ? (n - 1) / (last - first) : NaN, mm: env };
}

export class PenMeter {
  constructor(armMm = 25) { this.armMm = armMm; this.imu = []; this.cmd = []; }
  addSample(s) { this.imu.push([s.t_us * 1e-6, s.gx, s.gy, s.gz]); this._trim(this.imu); }
  addCommand(c) { this.cmd.push([c.t_us * 1e-6, c.mm]); this._trim(this.cmd); }
  _trim(a) { const end = a[a.length - 1][0]; while (a.length && a[0][0] < end - WINDOW_S) a.shift(); }
  /** What the pen was asked to do. */
  commanded() {
    const t = this.cmd.map((r) => r[0]);
    return oscillation(t, movingAvgRemove(t, this.cmd.map((r) => r[1])));
  }
  /** What the pen's own sensor measured at the tip. */
  measured() {
    if (this.imu.length < 20) return { hz: NaN, mm: NaN, axis: null };
    const t = this.imu.map((r) => r[0]);
    let best = null;
    for (let k = 1; k <= 3; k++) {
      const w = movingAvgRemove(t, this.imu.map((r) => r[k]));       // deg/s, slow hand rotation removed
      const ang = new Float64Array(w.length);                          // integrate -> deg
      for (let i = 1; i < w.length; i++) ang[i] = ang[i - 1] + 0.5 * (w[i] + w[i - 1]) * (t[i] - t[i - 1]);
      const a = movingAvgRemove(t, ang);
      let p = 0; for (const v of a) p += v * v;
      if (!best || p > best.p) best = { p, a, axis: 'xyz'[k - 1] };
    }
    const o = oscillation(t, best.a);
    return { hz: o.hz, mm: o.mm * Math.PI / 180 * this.armMm, axis: best.axis };
  }
}
