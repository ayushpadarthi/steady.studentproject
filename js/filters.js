// Steady filters: JS ports of the Python reference (see docs/04-architecture-spec.md).
// Every 1-D filter exposes reset() and step(t_s, z) -> estimate. No DOM / browser APIs here,
// so this module runs unchanged under plain `node`.

const TWO_PI = 2 * Math.PI;
const fin = Number.isFinite;

// ---------------------------------------------------------------- FFT
/** In-place iterative radix-2 complex FFT. re, im: Float64Array of power-of-two length. */
export function fft(re, im) {
  const n = re.length;
  if (n & (n - 1)) throw new Error('fft length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -TWO_PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// ---------------------------------------------------------------- simple filters
export class RawFilter {
  constructor() { this.reset(); }
  reset() { this.y = 0; }
  startStroke() { this.reset(); }
  step(t, z) { if (fin(z)) this.y = z; return this.y; }
}

export class EMAFilter {
  constructor({ fc = 2.0 } = {}) { this.fc = fc; this.reset(); }
  reset() { this.init = false; this.t = 0; this.y = 0; }
  startStroke() { this.reset(); } // memoryless across pen-ups: restart at the first sample
  step(t, z) {
    if (!fin(t) || !fin(z)) return this.y;
    if (!this.init) { this.init = true; this.t = t; this.y = z; return z; }
    const dt = t - this.t;
    if (dt <= 0) return this.y;
    const a = dt / (dt + 1 / (TWO_PI * this.fc));
    this.y += a * (z - this.y);
    this.t = t;
    return this.y;
  }
}

export class OneEuroFilter {
  constructor({ mincutoff = 1.0, beta = 0.007, dcutoff = 1.0 } = {}) {
    Object.assign(this, { mincutoff, beta, dcutoff });
    this.reset();
  }
  reset() { this.init = false; this.t = 0; this.x = 0; this.dx = 0; }
  startStroke() { this.reset(); }
  static alpha(dt, fc) { const tau = 1 / (TWO_PI * fc); return dt / (dt + tau); }
  step(t, z) {
    if (!fin(t) || !fin(z)) return this.x;
    if (!this.init) { this.init = true; this.t = t; this.x = z; this.dx = 0; return z; }
    const dt = t - this.t;
    if (dt <= 0) return this.x; // duplicate / out-of-order timestamp: hold
    const dRaw = (z - this.x) / dt; // reference implementation differentiates against the filtered value
    this.dx += OneEuroFilter.alpha(dt, this.dcutoff) * (dRaw - this.dx);
    const cutoff = this.mincutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuroFilter.alpha(dt, cutoff) * (z - this.x);
    this.t = t;
    return this.x;
  }
}

// ---------------------------------------------------------------- tremor frequency tracker
/** 4th-order Butterworth high-pass as two RBJ biquads (identical to bilinear design with prewarp). */
function butterHP4(fc, fs) {
  const w0 = (TWO_PI * fc) / fs, c = Math.cos(w0), s = Math.sin(w0);
  return [Math.cos(Math.PI / 8), Math.cos((3 * Math.PI) / 8)].map((cs) => {
    const al = s / (2 * (1 / (2 * cs))), a0 = 1 + al;
    return { b: [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0], a: [1, (-2 * c) / a0, (1 - al) / a0] };
  });
}
/** scipy.signal.sosfilt_zi equivalent (unit-step steady state per section). */
function sosZi(sos) {
  let scale = 1;
  return sos.map(({ b, a }) => {
    // solve (I - A) zi = B for order-2 DF2T; A = companion(a)^T
    const B = [b[1] - a[1] * b[0], b[2] - a[2] * b[0]];
    const m = [[1 + a[1], -1], [a[2], 1]];
    const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    const zi = [(B[0] * m[1][1] - m[0][1] * B[1]) / det, (m[0][0] * B[1] - m[1][0] * B[0]) / det];
    const out = [zi[0] * scale, zi[1] * scale];
    scale *= (b[0] + b[1] + b[2]) / (a[0] + a[1] + a[2]);
    return out;
  });
}

/**
 * Sliding-window FFT tracker, port of steady.tremor_estimator.TremorEstimator.
 * push(t_s, z) with z a number or an array (channels' spectra are summed) -> {f0, conf}.
 * Causal 4th-order Butterworth HP (2 Hz) -> 1.5 s window (analysis once 40 % full) -> every hop (0.1 s):
 * uniform resample, Hann, zero-padded FFT (>=1024), 3-12 Hz peak with log-parabolic refinement.
 * conf = share of 2-15 Hz power within +-1 Hz of the peak (0 if HP RMS < 0.03 mm). f0 locks on the first
 * confident peak, then moves by EMA (alpha 0.4) outside a 0.2 Hz deadband, slew-limited to 1 Hz/s.
 */
export class TremorTracker {
  constructor({
    fs = 120, window = 1.5, hop = 0.1, fmin = 3, fmax = 12, hpCutoff = 2.0, nfftMin = 1024,
    confThreshold = 0.35, slew = 1.0, deadband = 0.2, alpha = 0.4, minRms = 0.03, f0Init = 6, minSpanFrac = 0.4,
  } = {}) {
    Object.assign(this, { fs, window, hop, fmin, fmax, hpCutoff, nfftMin, confThreshold, slew, deadband, alpha, minRms, f0Init, minSpanFrac });
    this.sos = butterHP4(hpCutoff, fs);
    this.reset();
  }
  reset() {
    this.zi = null; this.ts = []; this.vs = []; this.lastIn = null; this.lastUpd = null;
    this.f0 = this.f0Init; this.conf = 0; this.locked = false;
  }
  push(t, z) {
    const zs = Array.isArray(z) ? z : [z];
    if (!fin(t) || !zs.every(fin)) return this.result();
    if (this.lastIn !== null && t <= this.lastIn) return this.result();
    if (!this.zi) this.zi = sosZi(this.sos).map((zi) => zs.map((v) => [zi[0] * v, zi[1] * v]));
    const hp = zs.map((v, c) => {
      let x = v;
      this.sos.forEach(({ b, a }, k) => {
        const st = this.zi[k][c];
        const y = b[0] * x + st[0];
        st[0] = b[1] * x - a[1] * y + st[1];
        st[1] = b[2] * x - a[2] * y;
        x = y;
      });
      return x;
    });
    this.lastIn = t; this.ts.push(t); this.vs.push(hp);
    let drop = 0;
    while (drop < this.ts.length && this.ts[drop] < t - this.window) drop++;
    if (drop) { this.ts.splice(0, drop); this.vs.splice(0, drop); }
    if (this.lastUpd === null) this.lastUpd = t;
    if (t - this.lastUpd >= this.hop - 1e-9) { const d = t - this.lastUpd; this.lastUpd = t; this._analyse(d); }
    return this.result();
  }
  result() { return { f0: this.f0, conf: this.conf }; }
  _analyse(dtUpd) {
    const ts = this.ts, n0 = ts.length, tEnd = ts[n0 - 1];
    if (tEnd - ts[0] < this.minSpanFrac * this.window) return;
    const n = Math.round(this.window * this.fs);
    const tg = [];
    for (let i = 0; i < n; i++) { const v = tEnd - (n - 1 - i) / this.fs; if (v >= ts[0]) tg.push(v); }
    const N = tg.length;
    if (N < 16) return;
    const C = this.vs[0].length;
    let nfft = Math.max(this.nfftMin, 2 ** Math.ceil(Math.log2(N * 4)));
    const spec = new Float64Array(nfft / 2 + 1);
    let rms2 = 0;
    for (let c = 0; c < C; c++) {
      const seg = new Float64Array(N);
      let j = 0, mean = 0, ms = 0;
      for (let i = 0; i < N; i++) {
        const x = tg[i];
        while (j < n0 - 2 && ts[j + 1] < x) j++;
        const w = (x - ts[j]) / (ts[j + 1] - ts[j]);
        seg[i] = x <= ts[0] ? this.vs[0][c] : x >= tEnd ? this.vs[n0 - 1][c] : this.vs[j][c] * (1 - w) + this.vs[j + 1][c] * w;
        mean += seg[i]; ms += seg[i] * seg[i];
      }
      mean /= N; rms2 += ms / N;
      const re = new Float64Array(nfft), im = new Float64Array(nfft);
      for (let i = 0; i < N; i++) re[i] = (seg[i] - mean) * (0.5 - 0.5 * Math.cos((TWO_PI * i) / (N - 1)));
      fft(re, im);
      for (let k = 0; k < spec.length; k++) spec[k] += re[k] * re[k] + im[k] * im[k];
    }
    const df = this.fs / nfft;
    let kp = -1;
    for (let k = Math.ceil(this.fmin / df - 1e-9); k * df <= this.fmax + 1e-9; k++) if (kp < 0 || spec[k] > spec[kp]) kp = k;
    let fpk = kp * df;
    if (kp > 0 && kp < spec.length - 1) {
      const a = Math.log(spec[kp - 1] + 1e-30), b = Math.log(spec[kp] + 1e-30), c = Math.log(spec[kp + 1] + 1e-30);
      const den = a - 2 * b + c;
      if (den < 0) fpk += ((0.5 * (a - c)) / den) * df;
    }
    let tot = 0, near = 0;
    const lo = Math.max(fpk - 1, 2), hi = Math.min(fpk + 1, 15);
    for (let k = 0; k < spec.length; k++) {
      const f = k * df;
      if (f >= 2 && f <= 15) tot += spec[k];
      if (f >= lo && f <= hi) near += spec[k];
    }
    let conf = tot > 0 ? near / tot : 0;
    if (Math.sqrt(rms2 / C) < this.minRms) conf = 0;
    this.conf = conf;
    if (conf < this.confThreshold) return;
    if (!this.locked) { this.f0 = fpk; this.locked = true; return; }
    if (Math.abs(fpk - this.f0) <= this.deadband) return;
    const target = this.f0 + this.alpha * (fpk - this.f0);
    const lim = this.slew * dtUpd;
    this.f0 += Math.min(lim, Math.max(-lim, target - this.f0));
  }
}

// ---------------------------------------------------------------- Steady (Kalman + tremor oscillator)
const I4 = () => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
function mul(A, B) {
  const C = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) {
    const a = A[i][k];
    if (a !== 0) for (let j = 0; j < 4; j++) C[i][j] += a * B[k][j];
  }
  return C;
}
const tr4 = (A) => A[0].map((_, j) => A.map((row) => row[j]));

/**
 * Port of steady.filters.Steady. State x = [p, v, c, s]; z = p + c + n; k = dt * fsNom.
 * Confident: [c;s]' = rho^k R(2 pi f0 dt) [c;s], Q_tremor = qt*k. Not confident: tremor block of F is zero,
 * q_i *= fallbackMult, and P rows/cols 2,3 are reset to p0Tremor after predict.
 * Drive f0 either with setF0(f0, confident) (as Filter2D / parity tests do), a fixed `f0` option
 * (always confident), or - by default - an internal single-axis TremorTracker.
 */
export class SteadyFilter {
  constructor({
    qi = 100, qt = 0.005, r = 0.005, rho = 0.995, fsNom = 120, fallbackMult = 3, p0Tremor = 1,
    f0 = null, tracker = {}, confThreshold = 0.35,
  } = {}) {
    Object.assign(this, { qi, qt, r, rho, fsNom, fallbackMult, p0Tremor, fixedF0: f0, confThreshold });
    this.tracker = new TremorTracker({ confThreshold, ...tracker });
    this.external = false;
    this.reset();
  }
  reset() {
    this.init = false; this.t = 0; this.x = [0, 0, 0, 0]; this.P = I4(); this.last = 0;
    this.f0 = this.fixedF0 ?? this.tracker.f0Init; this.confident = true; this.conf = this.fixedF0 != null ? 1 : 0;
    this.tracker.reset();
  }
  startStroke() { this.reset(); } // v1 behaviour (what the old app did on pointer-down)
  get fallback() { return !this.confident; }
  /** Externally supply f0 (Hz) and whether it is confident. Non-finite / <=0 f0 keeps the previous value. */
  setF0(f, confident = true) {
    this.external = true;
    if (fin(f) && f > 0) this.f0 = f;
    this.confident = !!confident; this.conf = confident ? 1 : 0;
  }
  step(t, z) {
    if (!fin(t)) return this.last;
    if (!this.init) {
      if (!fin(z)) return this.last;
      this.x = [z, 0, 0, 0]; this.P = [[this.r, 0, 0, 0], [0, 100, 0, 0], [0, 0, this.p0Tremor, 0], [0, 0, 0, this.p0Tremor]];
      this.t = t; this.init = true; this.last = z;
      if (!this.external && this.fixedF0 == null) this.tracker.push(t, z);
      return z;
    }
    if (!this.external && this.fixedF0 == null) {
      const r = this.tracker.push(t, z);
      this.f0 = r.f0; this.conf = r.conf; this.confident = r.conf >= this.confThreshold;
    }
    const dt = t - this.t;
    if (dt <= 0) return this.last;
    const k = dt * this.fsNom;
    let qi = this.qi;
    const F = I4(); F[0][1] = dt;
    const Q = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    if (this.confident) {
      const rk = Math.pow(this.rho, k), w = TWO_PI * this.f0 * dt, cw = Math.cos(w), sw = Math.sin(w);
      F[2][2] = rk * cw; F[2][3] = -rk * sw; F[3][2] = rk * sw; F[3][3] = rk * cw;
      Q[2][2] = Q[3][3] = this.qt * k;
    } else {
      qi *= this.fallbackMult;
      F[2][2] = F[3][3] = 0;
    }
    const dt2 = dt * dt, dt3 = dt2 * dt;
    Q[0][0] = qi * dt3 / 3; Q[0][1] = Q[1][0] = qi * dt2 / 2; Q[1][1] = qi * dt;
    const x = this.x;
    let xp = [x[0] + dt * x[1], x[1], F[2][2] * x[2] + F[2][3] * x[3], F[3][2] * x[2] + F[3][3] * x[3]];
    const P = mul(mul(F, this.P), tr4(F));
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) P[i][j] += Q[i][j];
    if (!this.confident) {
      for (let i = 0; i < 4; i++) for (let j = 2; j < 4; j++) { P[i][j] = 0; P[j][i] = 0; }
      P[2][2] = P[3][3] = this.p0Tremor;
    }
    this.t = t;
    if (fin(z)) {
      const PH = [0, 1, 2, 3].map((i) => P[i][0] + P[i][2]); // P H^T
      const S = PH[0] + PH[2] + this.r;
      const K = PH.map((v) => v / S);
      const innov = z - (xp[0] + xp[2]);
      xp = xp.map((v, i) => v + K[i] * innov);
      const HP = [0, 1, 2, 3].map((j) => P[0][j] + P[2][j]); // H P
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) P[i][j] -= K[i] * HP[j];
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) { const m = 0.5 * (P[i][j] + P[j][i]); P[i][j] = P[j][i] = m; }
    }
    this.x = xp; this.P = P;
    this.last = xp[0];
    return this.last;
  }
}


// ---------------------------------------------------------------- SteadyV2 (oscillator-bank Kalman mix)
/**
 * One model of SteadyV2, exact port of steady.filters.SteadyBank (see the algorithm text in
 * shared/test_vectors/steady_v2_kalman.json). State x = [p, v, c_1, s_1, ..., c_K, s_K]; P is a flat
 * row-major n*n Float64Array. F is block diagonal, so F P F^T is done block-wise in O(n^2).
 * Parameter names are the Python ones (snake_case) so vector params can be passed straight in.
 */
export class SteadyBank {
  constructor({
    f_lo = 3.0, f_hi = 12.0, df = 0.5, q_i = 2.5e4, q_t = 1e-5, r = 0.006, rho = 0.992, fs_nom = 120.0,
    p0_t = 0.1, p0_v = 100.0, p0_p = 1e4, act_gain = 1.5e-2, act_cap = 1.5, ui_tau = 0.5,
  } = {}) {
    Object.assign(this, { f_lo, f_hi, df, q_i, q_t, r, rho, fs_nom, p0_t, p0_v, p0_p, act_gain, act_cap, ui_tau });
    const K = Math.floor((f_hi - f_lo) / df + 1e-9) + 1;
    this.K = K; this.n = 2 + 2 * K;
    this.freqs = new Float64Array(K);
    for (let j = 0; j < K; j++) this.freqs[j] = f_lo + df * j;
    const n = this.n;
    this.x = new Float64Array(n); this.P = new Float64Array(n * n);
    this.pw = new Float64Array(K); this.act = new Float64Array(K);
    this.cs = new Float64Array(K); this.sn = new Float64Array(K); // per-step rotation scratch
    this.pht = new Float64Array(n); this.kg = new Float64Array(n);
    this.reset();
  }
  reset() {
    const n = this.n;
    this.t = null; this.x.fill(0); this.P.fill(0);
    for (let i = 0; i < n; i++) this.P[i * n + i] = 1;
    this.nll = 0; this.pw.fill(0); this.act.fill(0);
    this.started = false; this.fresh = false; this.out = NaN;
  }
  /** Pen-down: keep the oscillator state, restart the intended-motion state at the next sample. */
  startStroke() { if (this.started) this.fresh = true; else this.reset(); }

  _predict(dt) {
    const { n, K, x, P, cs, sn } = this;
    const k = dt * this.fs_nom, rk = Math.pow(this.rho, k);
    for (let j = 0; j < K; j++) { const w = TWO_PI * this.freqs[j] * dt; cs[j] = rk * Math.cos(w); sn[j] = rk * Math.sin(w); }
    // x <- F x
    x[0] += dt * x[1];
    for (let j = 0; j < K; j++) {
      const a = 2 + 2 * j, c = cs[j], s = sn[j], xa = x[a], xb = x[a + 1];
      x[a] = c * xa - s * xb; x[a + 1] = s * xa + c * xb;
    }
    // A = F P (row operations)
    for (let col = 0; col < n; col++) P[col] += dt * P[n + col];
    for (let j = 0; j < K; j++) {
      const ra = (2 + 2 * j) * n, rb = ra + n, c = cs[j], s = sn[j];
      for (let col = 0; col < n; col++) {
        const pa = P[ra + col], pb = P[rb + col];
        P[ra + col] = c * pa - s * pb; P[rb + col] = s * pa + c * pb;
      }
    }
    // B = A F^T (column operations)
    for (let i = 0, o = 0; i < n; i++, o += n) {
      P[o] += dt * P[o + 1];
      for (let j = 0; j < K; j++) {
        const a = o + 2 + 2 * j, c = cs[j], s = sn[j], pa = P[a], pb = P[a + 1];
        P[a] = c * pa - s * pb; P[a + 1] = s * pa + c * pb;
      }
    }
    // + Q
    const gain = (1.0 - Math.pow(this.rho, 2 * k)) / (1.0 - this.rho * this.rho);
    const qi = this.q_i, dt2 = dt * dt;
    P[0] += qi * dt2 * dt / 3; P[1] += qi * dt2 / 2; P[n] += qi * dt2 / 2; P[n + 1] += qi * dt;
    for (let j = 0; j < K; j++) {
      const a = 2 + 2 * j, qt = (this.q_t + this.act_gain * Math.min(this.pw[j], this.act_cap)) * gain;
      P[a * n + a] += qt; P[(a + 1) * n + a + 1] += qt;
    }
  }

  step(t_s, z) {
    this.nll = 0;
    if (!fin(t_s)) return this.out;
    const { n, K, x, P } = this;
    if (!this.started) {
      if (!fin(z)) return NaN;
      x.fill(0); x[0] = z; P.fill(0);
      P[0] = this.r; P[n + 1] = this.p0_v;
      for (let i = 2; i < n; i++) P[i * n + i] = this.p0_t;
      this.t = t_s; this.started = true; this.out = z;
      return z;
    }
    const dt = t_s - this.t;
    if (!(dt > 0)) return this.out;
    const freshNow = this.fresh;
    if (this.fresh) {
      if (!fin(z)) return this.out;
      this._predict(dt);
      let sc = 0;
      for (let j = 0; j < K; j++) sc += x[2 + 2 * j];
      x[0] = z - sc; x[1] = 0;
      for (let i = 0; i < n; i++) { P[i] = 0; P[n + i] = 0; P[i * n] = 0; P[i * n + 1] = 0; }
      P[0] = this.p0_p; P[n + 1] = this.p0_v;
      this.fresh = false;
    } else this._predict(dt);
    this.t = t_s;
    if (fin(z)) {
      const pht = this.pht, kg = this.kg;
      for (let i = 0, o = 0; i < n; i++, o += n) {
        let s = P[o];
        for (let j = 0; j < K; j++) s += P[o + 2 + 2 * j];
        pht[i] = s;
      }
      let S = pht[0], xs = x[0];
      for (let j = 0; j < K; j++) { S += pht[2 + 2 * j]; xs += x[2 + 2 * j]; }
      S += this.r;
      const inn = z - xs;
      this.nll = freshNow ? 0 : 0.5 * (Math.log(S) + inn * inn / S);
      for (let i = 0; i < n; i++) { kg[i] = pht[i] / S; x[i] += kg[i] * inn; }
      for (let i = 0; i < n; i++) {
        const o = i * n;
        P[o + i] -= kg[i] * pht[i];
        for (let j = i + 1; j < n; j++) {
          const m = 0.5 * ((P[o + j] - kg[i] * pht[j]) + (P[j * n + i] - kg[j] * pht[i]));
          P[o + j] = m; P[j * n + i] = m;
        }
      }
      const g = Math.min(1.0, dt / this.ui_tau);
      for (let j = 0; j < K; j++) {
        const a = x[2 + 2 * j], b = x[3 + 2 * j];
        this.pw[j] = a * a + b * b;
        this.act[j] += g * (this.pw[j] - this.act[j]);
      }
    }
    this.out = x[0];
    return this.out;
  }
}

/** Dominant tremor frequency from oscillator activities (argmax + parabola on sqrt(act)); NaN if silent. */
export function tremorHzFromAct(act, freqs) {
  let any = false, k = 0;
  for (let j = 0; j < act.length; j++) { if (act[j] > 1e-6) any = true; if (act[j] > act[k]) k = j; }
  if (!any) return NaN;
  let f = freqs[k];
  if (k > 0 && k < freqs.length - 1) {
    const a0 = Math.sqrt(act[k - 1]), a1 = Math.sqrt(act[k]), a2 = Math.sqrt(act[k + 1]);
    const den = a0 - 2 * a1 + a2;
    if (den < 0) f += Math.min(0.5, Math.max(-0.5, 0.5 * (a0 - a2) / den)) * (freqs[1] - freqs[0]);
  }
  return f;
}
/** Share of total activity within +-1 Hz of the strongest oscillator (0 if silent). */
export function tremorConfFromAct(act, freqs) {
  let tot = 0, k = 0;
  for (let j = 0; j < act.length; j++) { tot += act[j]; if (act[j] > act[k]) k = j; }
  if (tot <= 1e-6) return 0;
  let near = 0;
  for (let j = 0; j < act.length; j++) if (Math.abs(freqs[j] - freqs[k]) <= 1.0 + 1e-9) near += act[j];
  return near / tot;
}

/** Exact port of steady.filters.SteadyV2: likelihood-weighted mix of M SteadyBank models (one axis). */
export class SteadyV2 {
  constructor({ q_list = [1e3, 5e3, 25e3, 125e3], tau_w = 0.4, w_floor = 1e-3, ...bank } = {}) {
    this.q_list = q_list.slice(); this.tau_w = tau_w; this.w_floor = w_floor;
    this.models = this.q_list.map((q) => new SteadyBank({ ...bank, q_i: q }));
    const m0 = this.models[0];
    this.freqs = m0.freqs; this.K = m0.K; this.fs_nom = m0.fs_nom;
    this.M = this.models.length;
    this.ev = new Float64Array(this.M); this.w = new Float64Array(this.M); this.ys = new Float64Array(this.M);
    this.actMix = new Float64Array(this.K);
    this.reset();
  }
  reset() {
    for (const m of this.models) m.reset();
    this.ev.fill(0); this.w.fill(1 / this.M); this.t = null; this.out = NaN;
  }
  /** Pen-down: every model keeps its tremor state; the evidence window restarts. */
  startStroke() { for (const m of this.models) m.startStroke(); this.ev.fill(0); }
  start_stroke() { this.startStroke(); }

  step(t_s, z) {
    const { M, ev, w, ys, models } = this;
    for (let m = 0; m < M; m++) ys[m] = models[m].step(t_s, z);
    if (!fin(t_s)) return this.out;
    if (this.t !== null && t_s > this.t) {
      const dt = t_s - this.t, kk = Math.min(dt * this.fs_nom, 4.0), d = Math.exp(-dt / this.tau_w);
      for (let m = 0; m < M; m++) ev[m] = ev[m] * d + kk * models[m].nll;
    }
    if (this.t === null || t_s > this.t) this.t = t_s;
    for (let m = 0; m < M; m++) if (!fin(ys[m])) return fin(this.out) ? this.out : ys[0];
    let emin = ev[0];
    for (let m = 1; m < M; m++) if (ev[m] < emin) emin = ev[m];
    let sum = 0;
    for (let m = 0; m < M; m++) { w[m] = Math.exp(-(ev[m] - emin)); sum += w[m]; }
    let sum2 = 0;
    for (let m = 0; m < M; m++) { w[m] = Math.max(w[m] / sum, this.w_floor); sum2 += w[m]; }
    let out = 0;
    for (let m = 0; m < M; m++) { w[m] /= sum2; out += w[m] * ys[m]; }
    this.out = out;
    return out;
  }

  // read-outs (UI only)
  get act() {
    const a = this.actMix; a.fill(0);
    for (let m = 0; m < this.M; m++) { const am = this.models[m].act, wm = this.w[m]; for (let j = 0; j < this.K; j++) a[j] += wm * am[j]; }
    return a;
  }
  tremor_hz() { return tremorHzFromAct(this.act, this.freqs); }
  tremor_conf() { return tremorConfFromAct(this.act, this.freqs); }
  tremor_amp_mm() { let s = 0; for (const v of this.act) s += v; return Math.sqrt(s); }
}

/**
 * Steady v3 = SteadyV2 tremor cancellation, applied only as far as clear tremor is present, then a 10 Hz EMA finish.
 * Exact port of SteadyV3 in software/core/steady/filters.py (parity: shared/test_vectors/steady_v3_kalman.json).
 *   y2 = v2.step(t,z); g_t = clip((amp - gate_lo)/(gate_hi - gate_lo), 0, 1), amp = v2.tremor_amp_mm()
 *   g += (g_t - g)(1 - exp(-dt/tau_g)) (first output: g = g_t);  out = EMA(fin_fc).step(t, g*y2 + (1-g)*z)
 * Why: on small or irregular tremor the oscillator bank has little to remove and can add error, so the gate falls
 * back to plain light smoothing; with real rhythmic tremor it cancels it (see docs/history/07-review-and-research.md).
 */
export class SteadyV3 {
  constructor({ gate_lo = 0.1, gate_hi = 0.3, tau_g = 0.3, fin_fc = 10.0, draw_fc = 0, draw_fw = 0.5, draw_ac = 1.0, draw_aw = 2.0, v2 = {}, ...rest } = {}) {
    this.inner = new SteadyV2({ ...v2, ...rest });
    this.gate_lo = gate_lo; this.gate_hi = gate_hi; this.tau_g = tau_g;
    Object.assign(this, { draw_fc, draw_fw, draw_ac, draw_aw });
    this.fin = new EMAFilter({ fc: fin_fc });
    this.freqs = this.inner.freqs;
    this.reset();
  }
  reset() { this.inner.reset(); this.fin.reset(); this.g = 0; this.gInit = false; this.t = null; this.out = NaN; this.y2 = NaN; }
  startStroke() { this.inner.startStroke(); this.fin.reset(); this.t = null; }
  start_stroke() { this.startStroke(); }
  /** Drawing check (v5; off when draw_fc <= 0): 0..1, how much the detected rhythm looks like deliberate drawing.
   *  A slow, big rhythm (under ~4 Hz, over ~1 mm) is far more likely a zigzag or wave than tremor. */
  intent() {
    if (this.draw_fc <= 0) return 0;
    const hz = this.inner.tremor_hz(), amp = this.inner.tremor_amp_mm();
    if (!(Number.isFinite(hz) && Number.isFinite(amp))) return 0;
    const slow = Math.min(1, Math.max(0, (this.draw_fc - hz) / this.draw_fw + 0.5));
    const big = Math.min(1, Math.max(0, (amp - this.draw_ac) / this.draw_aw + 0.5));
    return slow * big;
  }
  _gateTarget() {
    if (this.gate_lo < 0) return 1;
    const amp = this.inner.tremor_amp_mm();
    return Math.min(1, Math.max(0, (amp - this.gate_lo) / (this.gate_hi - this.gate_lo))) * (1 - this.intent());
  }
  step(t, z) {
    const y2 = this.inner.step(t, z);
    this.y2 = y2; // zero-lag tremor-cancelled position; z - y2 = the shake estimate (Shake style)
    if (!(Number.isFinite(y2) && Number.isFinite(t))) return this.out;
    if (!Number.isFinite(z)) z = y2;
    const gt = this._gateTarget();
    if (!this.gInit) { this.g = gt; this.gInit = true; }
    else if (this.t !== null && t > this.t) this.g += (gt - this.g) * (1 - Math.exp(-(t - this.t) / this.tau_g));
    if (this.t === null || t > this.t) this.t = t;
    this.out = this.fin.step(t, this.g * y2 + (1 - this.g) * z);
    return this.out;
  }
  get act() { return this.inner.act; }
  get w() { return this.inner.w; }
  tremor_hz() { return this.inner.tremor_hz(); }
  tremor_conf() { return this.inner.tremor_conf(); }
  tremor_amp_mm() { return this.inner.tremor_amp_mm(); }
}

// ---------------------------------------------------------------- factory / 2-D wrapper
/** Steady v4 (2026-10-21) = SteadyV3 algorithm with settings retuned on realistic tremor (same as V4_PARAMS in
 *  software/core/steady/filters.py; parity vs shared/test_vectors/steady_v4_kalman.json). */
export const V4_PARAMS = { gate_lo: 0.1, gate_hi: 0.3, tau_g: 0.3, fin_fc: 10.0, rho: 0.996, r: 0.024, q_t: 1e-4, act_gain: 1.5e-2 };
export class SteadyV4 extends SteadyV3 {
  constructor(opts = {}) { super({ ...V4_PARAMS, ...opts }); }
}
/** Steady v5 (2026-10-24) = v4 + the drawing check, so deliberate zigzags and waves are kept (V5_PARAMS in
 *  filters.py; parity vs shared/test_vectors/steady_v5_kalman.json). */
export const V5_PARAMS = { ...V4_PARAMS, draw_fc: 4.0, draw_fw: 0.5, draw_ac: 1.0, draw_aw: 2.0 };
export class SteadyV5 extends SteadyV3 {
  constructor(opts = {}) { super({ ...V5_PARAMS, ...opts }); }
}
/** Steady v6 (2026-10-24) = v5 + settings that follow variable tremor better (V6_PARAMS in filters.py; parity vs
 *  shared/test_vectors/steady_v6_kalman.json). Its settling thresholds are 0.6/1.0 mm (js/settle.js). */
export const V6_PARAMS = { ...V5_PARAMS, act_gain: 0.06, act_cap: 6.0, tau_w: 0.2, r: 0.012 };
export class SteadyV6 extends SteadyV3 {
  constructor(opts = {}) { super({ ...V6_PARAMS, ...opts }); }
}

/** Filters offered as study conditions (steady_v1 is deliberately absent). */
export const FILTER_NAMES = ['raw', 'ema', 'steady']; // the pilot user test's three versions (study.js CONDITIONS)
/** Filters selectable in free play. */
export const FREE_FILTER_NAMES = ['raw', 'ema', 'one_euro', 'steady', 'steady_v5', 'steady_v4', 'steady_v3', 'steady_v2', 'steady_v1'];

export function makeFilter(name, opts = {}) {
  switch (name) {
    case 'raw': return new RawFilter();
    case 'ema': return new EMAFilter(opts);
    case 'one_euro': return new OneEuroFilter(opts);
    case 'steady': return new SteadyV6(opts);
    case 'steady_v5': return new SteadyV5(opts);
    case 'steady_v4': return new SteadyV4(opts);
    case 'steady_v3': return new SteadyV3(opts);
    case 'steady_v2': return new SteadyV2(opts);
    case 'steady_v1': return new SteadyFilter(opts);
    default: throw new Error(`unknown filter ${name}`);
  }
}

/**
 * x/y filters with identical parameters. 'steady' (v2) = two independent SteadyV2, no shared state.
 * 'steady_v1' = old behaviour: one shared tremor tracker sees both axes and drives both Kalman filters.
 * startStroke() = pen-down: keeps tremor state for v2, full reset for the memoryless filters and v1.
 * reset() forgets everything (use on filter change / new participant / new study condition).
 */
export class Filter2D {
  constructor(name, opts = {}) {
    this.name = name; this.opts = opts;
    const v1 = name === 'steady_v1';
    this.fx = makeFilter(name, v1 ? { ...opts, f0: null } : opts);
    this.fy = makeFilter(name, v1 ? { ...opts, f0: null } : opts);
    if (v1) this.tracker = new TremorTracker(opts.tracker || {});
  }
  reset() { this.fx.reset(); this.fy.reset(); this.tracker?.reset(); }
  startStroke() { this.fx.startStroke(); this.fy.startStroke(); this.tracker?.reset(); }
  start_stroke() { this.startStroke(); }
  step(t, x, y) {
    if (this.tracker) {
      const r = this.tracker.push(t, [x, y]);
      const ok = r.conf >= this.tracker.confThreshold;
      this.fx.setF0(r.f0, ok); this.fy.setF0(r.f0, ok);
    }
    return [this.fx.step(t, x), this.fy.step(t, y)];
  }
  /**
   * Tremor read-outs (steady / steady_v1 only, else null).
   * v2: {kind:'v2', f0 (Hz or NaN), conf, amp (mm), locked, weights}; f0/conf from the x+y summed act_mix,
   * amp = sqrt(mean over axes of sum(act_mix)) (per-axis amplitude).
   */
  info() {
    if (this.name === 'steady' || this.name === 'steady_v5' || this.name === 'steady_v4' || this.name === 'steady_v3' || this.name === 'steady_v2') {
      const ax = this.fx.act, ay = this.fy.act, K = ax.length;
      if (!this._sum || this._sum.length !== K) this._sum = new Float64Array(K);
      const a = this._sum; let tot = 0;
      for (let j = 0; j < K; j++) { a[j] = ax[j] + ay[j]; tot += a[j]; }
      const f0 = tremorHzFromAct(a, this.fx.freqs);
      return { kind: 'v2', f0, conf: tremorConfFromAct(a, this.fx.freqs), amp: Math.sqrt(tot / 2), locked: Number.isFinite(f0), weights: Array.from(this.fx.w) };
    }
    if (!this.tracker) return null;
    return { kind: 'v1', f0: this.tracker.f0, conf: this.tracker.conf, fallback: this.fx.fallback, locked: this.tracker.locked };
  }
}
