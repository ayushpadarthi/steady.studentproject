// Run with:  node software/app/tests/filters.test.mjs   (no dependencies)
// Also importable from a browser page: `import { runTests } from './tests/filters.test.mjs'`.
import { settle } from '../js/settle.js';
import { RawFilter, EMAFilter, OneEuroFilter, SteadyFilter, SteadyV2, SteadyV3, Filter2D, FILTER_NAMES, FREE_FILTER_NAMES, TremorTracker, fft, makeFilter } from '../js/filters.js';

const results = [];
const defaultLoader = async (rel) => { // browser: fetch relative to this module (serve software/)
  if (typeof fetch === 'undefined' || typeof document === 'undefined') return null;
  const r = await fetch(new URL(rel, import.meta.url)); return r.ok ? r.text() : null;
};
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); }
const isNode = typeof process !== 'undefined' && !!process.versions?.node;

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

function sine(fs, secs, hz, amp, slope = 0) {
  const t = [], z = [];
  for (let i = 0; i < fs * secs; i++) { const ti = i / fs; t.push(ti); z.push(slope * ti + amp * Math.sin(2 * Math.PI * hz * ti)); }
  return { t, z };
}

export async function runTests(loadFile = defaultLoader) {
  results.length = 0;
  // --- identity & constants
  { const f = new RawFilter(); check('raw identity', [1, -3.5, 7].every((v, i) => f.step(i, v) === v)); }
  for (const name of ['ema', 'one_euro', 'steady', 'steady_v1']) {
    const f = makeFilter(name, name === 'steady_v1' ? { f0: 6 } : {});
    let y = 0;
    for (let i = 0; i < 600; i++) y = f.step(i / 120, 42.5);
    check(`${name}: constant input -> constant output`, Math.abs(y - 42.5) < 1e-6, `y=${y}`);
  }
  // --- no NaN under hostile input
  for (const name of ['raw', 'ema', 'one_euro', 'steady', 'steady_v1']) {
    const f = makeFilter(name); const r = rng(7); let t = 0, bad = 0, seen = false;
    for (let i = 0; i < 5000; i++) {
      const roll = r();
      t += roll < 0.05 ? 0 : (roll < 0.06 ? -0.01 : 0.002 + 0.02 * r()); // dup + backwards timestamps, irregular dt
      let z = 10 * Math.sin(i / 50) + r();
      if (i % 997 === 0) z = NaN;
      if (i % 1499 === 0) z = Infinity;
      const y = f.step(i % 1777 === 0 ? NaN : t, z);
      if (Number.isFinite(y)) seen = true; else if (seen || name !== 'steady') bad++; // SteadyV2 is NaN until the first finite sample (as in Python)
    }
    check(`${name}: finite output under NaN/Inf/irregular/dup timestamps`, bad === 0, `bad=${bad}`);
  }
  // --- FFT
  {
    const n = 256, re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 10 * i) / n);
    fft(re, im);
    let k = 0, m = 0;
    for (let i = 0; i <= n / 2; i++) { const p = re[i] ** 2 + im[i] ** 2; if (p > m) { m = p; k = i; } }
    check('fft: cosine at bin 10', k === 10 && Math.abs(Math.sqrt(m) - n / 2) < 1e-6, `bin=${k} mag=${Math.sqrt(m)}`);
  }
  // --- tracker recovers 6 Hz
  for (const hz of [4, 6, 9]) {
    const { t, z } = sine(120, 4, hz, 1.0, 5); // plus slow drift
    const tr = new TremorTracker(); let res;
    for (let i = 0; i < t.length; i++) res = tr.push(t[i], z[i]);
    check(`tracker recovers ${hz} Hz sine`, Math.abs(res.f0 - hz) < 0.25 && res.conf > 0.4, `f0=${res.f0.toFixed(3)} conf=${res.conf.toFixed(2)}`);
  }
  {
    const r = rng(3), tr = new TremorTracker(); let res;
    for (let i = 0; i < 600; i++) res = tr.push(i / 120, 0.5 * (r() - 0.5));
    check('tracker: low confidence on white noise', res.conf < 0.4, `conf=${res.conf.toFixed(2)}`);
  }
  {
    // slew limit: step from 5 Hz to 10 Hz must not move faster than 1 Hz/s (measured over 1 s)
    const tr = new TremorTracker(); const hist = []; let maxRate = 0, last = 0;
    for (let i = 0; i < 120 * 12; i++) {
      const t = i / 120, hz = t < 4 ? 5 : 10;
      last = tr.push(t, Math.sin(2 * Math.PI * hz * t)).f0;
      hist.push(last);
      if (i >= 120 * 3) maxRate = Math.max(maxRate, Math.abs(last - hist[i - 120]));
    }
    check('tracker: f0 slew <= 1 Hz/s after first lock, and reaches 10 Hz', maxRate <= 1.0 + 1 / 30 + 1e-6 && Math.abs(last - 10) < 0.3, `maxRate=${maxRate.toFixed(3)} final=${last.toFixed(2)}`);
  }
  // --- steady removes tremor from ramp better than raw, and with little lag
  {
    const { t, z } = sine(120, 10, 6, 1.0, 20); // 20 mm/s ramp + 6 Hz, 1 mm
    const f = new SteadyV2(); const e = [], eRaw = [];
    for (let i = 0; i < t.length; i++) { const y = f.step(t[i], z[i]); if (t[i] > 5) { e.push(y - 20 * t[i]); eRaw.push(z[i] - 20 * t[i]); } }
    check('steady (v2): suppresses 6 Hz tremor on ramp', rms(e) < 0.5 * rms(eRaw), `rms steady=${rms(e).toFixed(3)} raw=${rms(eRaw).toFixed(3)}`);
    const ema = new EMAFilter(); const ee = [];
    for (let i = 0; i < t.length; i++) { const y = ema.step(t[i], z[i]); if (t[i] > 5) ee.push(y - 20 * t[i]); }
    check('steady (v2): less lag than ema on ramp (mean error)', Math.abs(e.reduce((a, b) => a + b, 0) / e.length) < Math.abs(ee.reduce((a, b) => a + b, 0) / ee.length),
      `steady bias=${(e.reduce((a, b) => a + b, 0) / e.length).toFixed(3)} ema bias=${(ee.reduce((a, b) => a + b, 0) / ee.length).toFixed(3)}`);
    const v1 = new SteadyFilter(); const e1 = [];
    for (let i = 0; i < t.length; i++) { const y = v1.step(t[i], z[i]); if (t[i] > 5) e1.push(y - 20 * t[i]); }
    check('steady_v1: suppresses 6 Hz tremor on ramp', rms(e1) < 0.5 * rms(eRaw), `rms v1=${rms(e1).toFixed(3)}`);
    const sv = new SteadyV2(); for (let i = 0; i < t.length; i++) sv.step(t[i], z[i]);
    check('steady (v2): read-outs find 6 Hz, ~1 mm', Math.abs(sv.tremor_hz() - 6) < 0.3 && sv.tremor_conf() > 0.5 && Math.abs(sv.tremor_amp_mm() - 1) < 0.3,
      `hz=${sv.tremor_hz().toFixed(2)} conf=${sv.tremor_conf().toFixed(2)} amp=${sv.tremor_amp_mm().toFixed(2)}`);
    const oe = new OneEuroFilter(); let yy = 0;
    for (let i = 0; i < t.length; i++) yy = oe.step(t[i], z[i]);
    check('one_euro: finite on ramp', Number.isFinite(yy));
  }
  // --- filter lists and Filter2D / stroke semantics
  check('study conditions exclude steady_v1; free play includes it', FILTER_NAMES.join() === 'raw,ema,one_euro,steady' && FREE_FILTER_NAMES.includes('steady_v1'));
  {
    const f2 = new Filter2D('steady');
    check('Filter2D(steady) = two independent SteadyV3 (gated v2)', f2.fx instanceof SteadyV3 && f2.fy instanceof SteadyV3 && f2.fx !== f2.fy && new Filter2D('steady_v2').fx instanceof SteadyV2);
    const { t, z } = sine(120, 3, 6, 1.0);
    for (let i = 0; i < t.length; i++) f2.step(t[i], z[i], 0);
    const before = f2.info();
    f2.startStroke();
    const after = f2.info();
    check('startStroke keeps the tremor state (v2 read-outs unchanged)', after.f0 === before.f0 && after.amp === before.amp && after.amp > 0.5, `amp=${after.amp.toFixed(2)}`);
    f2.reset();
    check('reset forgets the tremor state', !Number.isFinite(f2.info().f0) || f2.info().amp === 0);
    const e = new Filter2D('ema'); e.step(0, 5, 5); e.startStroke();
    check('ema startStroke restarts at next sample', e.step(1, 9, 9)[0] === 9);
  }
  // --- parity with Python reference vectors (software/shared/test_vectors/steady_kalman.json)
  {
    const path = '../../shared/test_vectors/steady_kalman.json';
    let txt = null;
    try { txt = loadFile ? await loadFile(path) : null; } catch { txt = null; }
    if (txt == null) {
      console.log('SKIP parity: software/shared/test_vectors/steady_kalman.json not found (serve software/ or run under node).');
    } else {
      const v = JSON.parse(txt);
      const nn = (a) => a.map((x) => (x === null ? NaN : x));
            const run = (name, make, c, drive, tol = 1e-6) => {
        const t = nn(c.t), z = nn(c.z), e = nn(c.expected), f = make();
        let maxErr = 0, nanMis = 0;
        for (let i = 0; i < t.length; i++) {
          if (drive) drive(f, i);
          const y = f.step(t[i], z[i]);
          if (Number.isNaN(e[i])) { if (Number.isFinite(y) && i > 0) nanMis++; continue; } // JS holds last/0 before init
          maxErr = Math.max(maxErr, Math.abs(y - e[i]));
        }
        results.parity ??= {}; results.parity[name] = maxErr;
        check(`parity ${name} (n=${t.length}) max|err| < ${tol}`, maxErr < tol && nanMis === 0, `max|err|=${maxErr.toExponential(2)}`);
      };
      const p = v.steady.params;
      run('steady_v1', () => new SteadyFilter({ qi: p.q_i, qt: p.q_t, r: p.r, rho: p.rho, fsNom: p.fs_nom, fallbackMult: p.fallback_mult, p0Tremor: p.p0_tremor }), v.steady,
        (f, i) => f.setF0(v.steady.f0[i] ?? NaN, v.steady.confident[i]));
      run('ema', () => new EMAFilter({ fc: v.ema.params.fc }), v.ema);
      run('one_euro', () => new OneEuroFilter(v.one_euro.params), v.one_euro);
    }
  }
  // --- parity: SteadyV2 vs steady_v2_kalman.json (abs tol 1e-9), incl. start_stroke(), NaN, weights, read-outs
  {
    const path = '../../shared/test_vectors/steady_v2_kalman.json';
    let txt = null;
    try { txt = loadFile ? await loadFile(path) : null; } catch { txt = null; }
    if (txt == null) console.log('SKIP parity v2: steady_v2_kalman.json not found.');
    else {
      const c = JSON.parse(txt).steady_v2, nn = (a) => a.map((x) => (x === null ? NaN : x));
      const t = nn(c.t), z = nn(c.z), e = nn(c.expected), eh = nn(c.expected_tremor_hz), ew = c.expected_w;
      const f = new SteadyV2(c.params);
      let eOut = 0, eHz = 0, eW = 0, nanMis = 0, hzNanMis = 0, nStroke = 0;
      for (let i = 0; i < t.length; i++) {
        if (c.stroke_start[i]) { f.start_stroke(); nStroke++; }
        const y = f.step(t[i], z[i]);
        if (Number.isNaN(e[i]) || Number.isNaN(y)) { if (Number.isNaN(e[i]) !== Number.isNaN(y)) nanMis++; } else eOut = Math.max(eOut, Math.abs(y - e[i]));
        const h = f.tremor_hz();
        if (Number.isNaN(eh[i]) || Number.isNaN(h)) { if (Number.isNaN(eh[i]) !== Number.isNaN(h)) hzNanMis++; } else eHz = Math.max(eHz, Math.abs(h - eh[i]));
        for (let m = 0; m < ew[i].length; m++) eW = Math.max(eW, Math.abs(f.w[m] - ew[i][m]));
      }
      results.parity ??= {}; results.parity.steady_v2 = eOut; results.parity.steady_v2_hz = eHz; results.parity.steady_v2_w = eW;
      const d = `n=${t.length}, ${nStroke} stroke starts, max|err| out=${eOut.toExponential(2)} hz=${eHz.toExponential(2)} w=${eW.toExponential(2)}`;
      check('parity steady v2 output < 1e-9', eOut < 1e-9 && nanMis === 0, d);
      check('parity steady v2 tremor_hz < 1e-9 (NaN pattern equal)', eHz < 1e-9 && hzNanMis === 0, `hz err ${eHz.toExponential(2)} nanMismatch=${hzNanMis}`);
      check('parity steady v2 mixer weights < 1e-9', eW < 1e-9, `w err ${eW.toExponential(2)}`);
    }
  }
  // --- parity: SteadyV3 (gated v2 + EMA finish) vs steady_v3_kalman.json (abs tol 1e-9), incl. the gate value
  {
    const path = '../../shared/test_vectors/steady_v3_kalman.json';
    let txt = null;
    try { txt = loadFile ? await loadFile(path) : null; } catch { txt = null; }
    if (txt == null) console.log('SKIP parity v3: steady_v3_kalman.json not found.');
    else {
      const c = JSON.parse(txt).steady_v3, nn = (a) => a.map((x) => (x === null ? NaN : x));
      const t = nn(c.t), z = nn(c.z), e = nn(c.expected), eg = c.expected_g;
      const f = new SteadyV3(c.params);
      let eOut = 0, eG = 0, nanMis = 0;
      for (let i = 0; i < t.length; i++) {
        if (c.stroke_start[i]) f.start_stroke();
        const y = f.step(t[i], z[i]);
        if (Number.isNaN(e[i]) || Number.isNaN(y)) { if (Number.isNaN(e[i]) !== Number.isNaN(y)) nanMis++; } else eOut = Math.max(eOut, Math.abs(y - e[i]));
        eG = Math.max(eG, Math.abs(f.g - eg[i]));
      }
      results.parity ??= {}; results.parity.steady_v3 = eOut; results.parity.steady_v3_gate = eG;
      check('parity steady v3 output < 1e-9', eOut < 1e-9 && nanMis === 0, `n=${t.length} max|err| out=${eOut.toExponential(2)} gate=${eG.toExponential(2)} nanMismatch=${nanMis}`);
      check('parity steady v3 gate < 1e-9', eG < 1e-9, `gate err ${eG.toExponential(2)}`);
    }
  }
  // --- performance (informational): SteadyV2 x 2 axes, ms per sample, irregular 1000 Hz-ish stream
  // --- parity: ink settling vs settle.json (abs tol 1e-9)
  {
    let txt = null;
    try { txt = loadFile ? await loadFile('../../shared/test_vectors/settle.json') : null; } catch { txt = null; }
    if (txt == null) console.log('SKIP parity settle: settle.json not found.');
    else {
      let e = 0;
      for (const c of JSON.parse(txt).cases) {
        const [sx, sy] = settle(c.t, c.x, c.y, c.fc);
        c.expected.forEach(([ex, ey], i) => { e = Math.max(e, Math.abs(sx[i] - ex), Math.abs(sy[i] - ey)); });
      }
      check('parity settle (JS = Python) < 1e-9', e < 1e-9, `max err ${e.toExponential(2)}`);
    }
    const t = [], x = [], y = [];
    for (let i = 0; i < 240; i++) { t.push(i / 120); x.push(20 * i / 120 + 2 * Math.sin(2 * Math.PI * 6 * i / 120)); y.push(5); }
    const [sx, sy] = settle(t, x, y, 3);
    const resid = sx.slice(40, 200).map((v, i) => v - 20 * t[i + 40]);
    check('settle: removes 6 Hz wobble, keeps a straight line', rms(Array.from(resid)) < 0.15 && sy.every((v) => Math.abs(v - 5) < 1e-9), `rms=${rms(Array.from(resid)).toFixed(3)}`);
    check('settle: end points stay put', Math.abs(sx[0] - x[0]) < 0.3 && Math.abs(sx[239] - x[239]) < 0.3, `start ${sx[0].toFixed(2)} end ${sx[239].toFixed(2)} vs ${x[239].toFixed(2)}`);
  }
  {
    const f2 = new Filter2D('steady'); const now = (typeof performance !== 'undefined' ? performance : Date);
    const N = 20000; let t0 = 0; const r = rng(11);
    for (let i = 0; i < 2000; i++) f2.step(i / 1000, 5 * Math.sin(i / 90), 0);   // warm-up (JIT)
    const a = now.now();
    for (let i = 0; i < N; i++) { t0 = 2 + i / 1000; f2.step(t0, 5 * Math.sin(i / 90) + 1.5 * Math.sin(2 * Math.PI * 6 * t0) + 0.05 * r(), 3 * Math.cos(i / 70)); }
    const msPer = (now.now() - a) / N;
    results.perf = { msPerSample2Axes: msPer };
    check('perf: SteadyV2 x2 axes < 0.3 ms/sample', msPer < 0.3, `${msPer.toFixed(4)} ms/sample`);
  }
  return results;
}

async function main() {
  let loadFile = null;
  if (isNode) {
    const fs = await import('node:fs');
    const url = await import('node:url');
    loadFile = async (rel) => {
      const p = url.fileURLToPath(new URL(rel, import.meta.url));
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    };
  }
  const res = await runTests(loadFile);
  let fails = 0;
  for (const r of res) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`); if (!r.ok) fails++; }
  console.log(`\n${res.length - fails}/${res.length} passed`);
  if (isNode && fails) process.exit(1);
}
if (isNode && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) await main();
