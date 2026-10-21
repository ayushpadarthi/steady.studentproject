// Realistic synthetic tremor. Port of software/core/steady/tremor_models.py (same presets and equations).
// Random numbers come from a seedable mulberry32 + Box-Muller, so streams are not sample-identical to numpy.
//
// Model (continuous in time, evaluated at arbitrary sample times):
//   f(t) = f0 + sf*u(t) (u: unit OU, tau_f);  phi = 2*pi*integral f dt
//   A(t) = A0 * exp(sa*w(t) + sa_fast*w2(t) - ...) * g(context)   (w, w2: unit OU, slow tau_a, fast tau_a_fast)
//   direction = angle_deg + angle_sd_deg * v(t)   (v: unit OU, tau_angle; the shake axis wanders)
//   d(t) = A*[cos(phi) e_major + ecc*sin(phi) e_minor] + h*A*cos(2 phi + psi) e_major
//   g: ET 1 + kin*min(speed/50 mm/s, 1);  PD s(t) -> 0.15 while moving, recovers with t_re after stopping.
// Values are reasonable approximations from the literature, NOT measurements of specific patients.

// Cycle-to-cycle irregularity (2026-10-20), same values as IRREGULAR/_irr() in tremor_models.py: the old
// presets were far more regular than real drawings (period CV 5 % vs ~30 % in UCI 395).
const irr = (p) => ({ sf: 4.0 * 0.3 * p.f0 / 6.5, tau_f: 0.12, sa_fast: 0.45, tau_a_fast: 0.15, angle_sd_deg: 20.0, tau_angle: 1.5, ...p });
export const PRESETS = {
  healthy: { name: 'Healthy hand (physiological)', f0: 10.0, amp: 0.1, sf: 0.8, tau_f: 0.3, sa: 0.4, tau_a: 1.5, ecc: 0.7,
    angle_deg: 30.0, harmonic: 0.0, kind: 'phys', kin: 0.5, t_re: 2.0, note: 'everyone has this; ~0.1 mm, 8-12 Hz' },
  et_mild: irr({ name: 'Essential tremor, mild', f0: 8.0, amp: 0.8, sa: 0.3, tau_a: 1.5, ecc: 0.35,
    angle_deg: 30.0, harmonic: 0.1, kind: 'et', kin: 0.5, t_re: 2.0, note: 'action tremor; visible wobble' }),
  et_moderate: irr({ name: 'Essential tremor, moderate', f0: 6.5, amp: 2.5, sa: 0.3, tau_a: 1.5, ecc: 0.35,
    angle_deg: 30.0, harmonic: 0.1, kind: 'et', kin: 0.5, t_re: 2.0, note: '' }),
  et_severe: irr({ name: 'Essential tremor, severe', f0: 5.0, amp: 7.0, sa: 0.35, tau_a: 1.5, ecc: 0.35,
    angle_deg: 30.0, harmonic: 0.15, kind: 'et', kin: 0.5, t_re: 2.0, note: 'large, slower tremor; drawing is very hard' }),
  pd_rest: irr({ name: "Parkinson's rest tremor", f0: 4.8, amp: 2.0, sa: 0.3, tau_a: 1.5, ecc: 0.25,
    angle_deg: 30.0, harmonic: 0.15, kind: 'pd', kin: 0.5, t_re: 2.0, note: 'mostly fades while moving, returns when the hand pauses' }),
  sine: { name: 'Simple sine (old demo)', f0: 6.0, amp: 1.5, sf: 0.0, tau_f: 1.0, sa: 0.0, tau_a: 1.5, ecc: 1.0,
    angle_deg: 0.0, harmonic: 0.0, kind: 'sine', kin: 0.5, t_re: 2.0, note: 'unrealistic; kept for comparison' },
};
export const PRESET_ORDER = ['healthy', 'et_mild', 'et_moderate', 'et_severe', 'pd_rest', 'sine'];

/** Small seedable PRNG: mulberry32 uniform + Box-Muller normal. */
export function makeRng(seed = 0) {
  let a = (seed >>> 0) || 0x9e3779b9, spare = null;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0;
    while (u < 1e-12) u = uniform();
    const v = uniform(), r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return { uniform, normal };
}

export class TremorGenerator {
  constructor(preset, seed = 0) {
    this.p = preset;
    this.rng = makeRng(seed);
    this.t = null;
    this.u = this.rng.normal();          // frequency OU state
    this.w = this.rng.normal();          // amplitude OU state
    this.phi = this.rng.uniform() * 2 * Math.PI;
    this.psi = this.rng.uniform() * 2 * Math.PI;
    this.s = 1.0;                        // PD suppression state
    this.wf = preset.sa_fast > 0 ? this.rng.normal() : 0;      // fast amplitude OU state
    this.va = preset.angle_sd_deg > 0 ? this.rng.normal() : 0; // direction OU state
  }
  _ou(x, dt, tau) {
    if (tau <= 0) return 0.0;
    const k = Math.exp(-dt / tau);
    return x * k + Math.sqrt(Math.max(0, 1 - k * k)) * this.rng.normal();
  }
  /** t in seconds (non-decreasing; earlier values are treated as dt = 0), speed in mm/s. Returns [dx, dy] in mm. */
  offset(t, speedMmS = 0) {
    const p = this.p;
    const dt = this.t === null ? 0 : Math.max(0, t - this.t);
    this.t = this.t === null ? t : Math.max(this.t, t);
    if (dt > 0) {
      this.u = this._ou(this.u, dt, p.tau_f);
      this.w = this._ou(this.w, dt, p.tau_a);
      if (p.sa_fast > 0) this.wf = this._ou(this.wf, dt, p.tau_a_fast ?? 0.15);
      if (p.angle_sd_deg > 0) this.va = this._ou(this.va, dt, p.tau_angle ?? 1.5);
      const f = Math.max(1.0, p.f0 + p.sf * this.u);
      this.phi += 2 * Math.PI * f * dt;
      if (p.kind === 'pd') {
        const target = speedMmS > 15.0 ? 0.15 : 1.0;
        const tau = target < this.s ? 0.25 : p.t_re;
        this.s += (target - this.s) * (1 - Math.exp(-dt / tau));
      }
    }
    let g = 1.0;
    if (p.kind === 'et') g = 1.0 + p.kin * Math.min(speedMmS / 50.0, 1.0);
    else if (p.kind === 'pd') g = this.s;
    const sf = p.sa_fast || 0;
    const A = p.amp * Math.exp(p.sa * this.w - 0.5 * p.sa * p.sa + sf * this.wf - 0.5 * sf * sf) * g;
    const ang = ((p.angle_deg + (p.angle_sd_deg > 0 ? p.angle_sd_deg * this.va : 0)) * Math.PI) / 180;
    const ma = [Math.cos(ang), Math.sin(ang)], mi = [-Math.sin(ang), Math.cos(ang)];
    const c = Math.cos(this.phi), s = Math.sin(this.phi);
    const h = p.harmonic * A * Math.cos(2 * this.phi + this.psi);
    const dx = A * (c * ma[0] + p.ecc * s * mi[0]) + h * ma[0];
    const dy = A * (c * ma[1] + p.ecc * s * mi[1]) + h * ma[1];
    return [dx, dy];
  }
}

/** overrides may contain any TremorPreset field (e.g. {f0, amp}). */
export function makeTremor(presetKey, overrides = {}, seed = 0) {
  const base = PRESETS[presetKey] || PRESETS.et_moderate;
  return new TremorGenerator({ ...base, ...overrides }, seed);
}

/** Speed (mm/s) from the UN-tremored pointer position, smoothed with an EMA (default time constant 80 ms). */
export class SpeedEstimator {
  constructor(tau = 0.08) { this.tau = tau; this.reset(); }
  reset() { this.t = null; this.x = 0; this.y = 0; this.v = 0; }
  update(t, x, y) {
    if (this.t !== null && t > this.t) {
      const dt = t - this.t, inst = Math.hypot(x - this.x, y - this.y) / dt;
      const k = 1 - Math.exp(-dt / this.tau);
      this.v += (inst - this.v) * k;
    }
    if (this.t === null || t > this.t) { this.t = t; this.x = x; this.y = y; }
    return this.v;
  }
}
