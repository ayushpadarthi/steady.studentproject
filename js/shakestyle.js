// Shake style: reuse the tremor Steady separated out, instead of throwing it away.
// Exact port of software/core/steady/shake_style.py (parity vs software/shared/test_vectors/shake_style.json).
// Shake = input minus Steady's zero-lag inner estimate (SteadyV3.y2), in mm.
//   env  = smooth shake size, mm (peak-equivalent)
//   mark = > 0 where a brush mark goes (one per tremor beat; without clear tremor, every 3 mm of path) = its size, mm
export const TAU_ENV = 0.1, TAU_AXIS = 1.0, MIN_AMP = 0.15, HYST = 0.3, SPACING_MM = 3.0;

export class ShakeTracker {
  constructor() { this.reset(); }
  reset() { this.e2 = 0; this.cxx = 0; this.cyy = 0; this.cxy = 0; this.startStroke(); }
  startStroke() { this.t = null; this.armed = false; this.peak = 0; this.dist = SPACING_MM; this.lx = null; this.ly = null; }
  get env() { return Math.sqrt(2 * this.e2); }
  step(t, x, y, dx, dy) {
    if (![t, x, y, dx, dy].every(Number.isFinite)) return [this.env, 0];
    const dt = this.t === null ? 0 : Math.max(0, t - this.t);
    this.t = this.t === null ? t : Math.max(this.t, t);
    if (dt > 0) {
      const k = 1 - Math.exp(-dt / TAU_ENV);
      this.e2 += k * (dx * dx + dy * dy - this.e2);
      const ka = 1 - Math.exp(-dt / TAU_AXIS);
      this.cxx += ka * (dx * dx - this.cxx); this.cyy += ka * (dy * dy - this.cyy); this.cxy += ka * (dx * dy - this.cxy);
    }
    if (this.lx !== null) this.dist += Math.hypot(x - this.lx, y - this.ly);
    this.lx = x; this.ly = y;
    const th = 0.5 * Math.atan2(2 * this.cxy, this.cxx - this.cyy);
    const p = dx * Math.cos(th) + dy * Math.sin(th);
    this.peak = Math.max(this.peak, Math.abs(p));
    const env = this.env;
    let mark = 0;
    if (env >= MIN_AMP) {
      if (p < -HYST * env) this.armed = true;
      else if (this.armed && p > HYST * env) { mark = Math.max(this.peak, MIN_AMP); this.armed = false; this.peak = 0; this.dist = 0; }
    } else if (this.dist >= SPACING_MM) { mark = MIN_AMP; this.dist = 0; this.peak = 0; }
    return [env, mark];
  }
}

// [key, name, note]
export const STYLES = [
  ['none', 'None', 'A plain line'],
  ['soften', 'Keep 30 %', 'A little of your real wobble stays, so it looks hand-made'],
  ['pulse', 'Ink pulse', 'The line gets thicker where your hand shook more'],
  ['stipple', 'Stipple', 'One dot per shake beat; bigger shake, bigger dot'],
  ['hatch', 'Hatching', 'Each shake beat leaves a short sketch mark'],
];
export const KEEP = 0.3;
/** Brush width multiplier for Ink pulse from the shake size (mm). */
export const pulseWidth = (env) => 0.8 + 0.6 * Math.min(env, 3);
/** Stipple dot radius and hatch length from a mark size (mm), in units of the brush size. */
export const dotRadius = (m) => 0.45 * (0.8 + 0.8 * Math.min(m, 3));
export const hatchLenMm = (m) => 2 + 2.2 * Math.min(m, 3);
