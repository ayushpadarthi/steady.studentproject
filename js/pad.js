// Shared drawing pad for the check-in and tracing pages: the same input pipeline as the drawing app
// (coalesced pointer events, palm rejection, optional simulated tremor, one persistent Steady filter,
// ink settling after pen-up). Every stroke keeps three versions of the line so pages can score them:
//   raw  = what the hand (plus any simulated tremor) did
//   live = what Steady drew while the pen was down
//   pts  = the final line on screen (live, settled after pen-up when Smoothing is on; raw when Steady is off)
// All coordinates are CSS pixels on the canvas.
import { Filter2D } from './filters.js?v=18';
import { makeTremor, SpeedEstimator, PRESETS } from './tremor.js?v=18';
import { adaptiveParams, adaptiveSettle, clampTo, clampMm, tremorAmp } from './settle.js?v=18';
import { MM_PER_PX, onCalibrationChange } from './calib.js?v=18';

export { MM_PER_PX }; // live: follows the device's real-size calibration (js/calib.js)
export const SMOOTH_K = { off: null, smooth: 0.5, extra: 0.3 };
export const SMOOTH_BASE = { smooth: 8.0, extra: 4.0 };

export function createPad(ink, ghost, opts = {}) {
  const ictx = ink.getContext('2d'), gctx = ghost ? ghost.getContext('2d') : null;
  const pad = {
    steady: true, smooth: 'smooth', ghost: false, syn: { on: false, preset: 'et_moderate' },
    strokes: [], w: 0, h: 0, dpr: 1, enabled: true,
    width: opts.width || (() => 4), color: opts.color || (() => '#1b1b1f'),
    onEnd: opts.onEnd || (() => {}), onStart: opts.onStart || (() => {}),
  };
  pad.filter = new Filter2D('steady');
  pad.tremor = makeTremor(pad.syn.preset, {}, (Date.now() ^ Math.floor(Math.random() * 2 ** 31)) >>> 0);
  const speed = new SpeedEstimator(0.08);
  let cur = null, pointerId = null, sawPen = false, lastT = -Infinity;

  pad.setPreset = (k) => { pad.syn.preset = k; pad.tremor.p = { ...PRESETS[k] }; };

  function seg(ctx, p0, p1, p2, color, width) {
    const m0 = p0 ? [(p0.x + p1.x) / 2, (p0.y + p1.y) / 2] : [p1.x, p1.y];
    const m1 = [(p1.x + p2.x) / 2, (p1.y + p2.y) / 2];
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(m0[0], m0[1]); ctx.quadraticCurveTo(p1.x, p1.y, m1[0], m1[1]); ctx.stroke();
  }
  function tail(ctx, pts, i, color, width) {
    if (i === 0) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, width / 2, 0, 2 * Math.PI); ctx.fill(); return; }
    seg(ctx, i >= 2 ? pts[i - 2] : null, pts[i - 1], pts[i], color, width);
  }
  /** Draw a list of points as one smooth line (exported for replays and score pictures). */
  pad.drawLine = (ctx, pts, color, width) => { for (let i = 0; i < pts.length; i++) tail(ctx, pts, i, color, width); };

  pad.redraw = () => {
    for (const [c, x] of [[ink, ictx], [ghost, gctx]]) {
      if (!c) continue;
      x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height); x.restore();
    }
    for (const s of pad.strokes) {
      pad.drawLine(ictx, s.pts, s.color, s.w);
      if (gctx) pad.drawLine(gctx, s.raw, 'rgba(27,27,31,.28)', 1.25);
    }
    if (ghost) ghost.style.visibility = pad.ghost ? 'visible' : 'hidden';
  };
  pad.resize = () => {
    pad.dpr = Math.min(window.devicePixelRatio || 1, 3);
    const r = ink.getBoundingClientRect(); pad.w = r.width; pad.h = r.height;
    for (const c of [ink, ghost]) {
      if (!c) continue;
      c.width = Math.round(pad.w * pad.dpr); c.height = Math.round(pad.h * pad.dpr);
      c.getContext('2d').setTransform(pad.dpr, 0, 0, pad.dpr, 0, 0);
    }
    pad.redraw();
  };
  pad.clear = () => { pad.strokes = []; pad.redraw(); };
  pad.undo = () => { pad.strokes.pop(); pad.redraw(); };

  function ingest(ev) {
    const t = (ev.__testT ?? ev.timeStamp) / 1000; // __testT: synthetic events in automated checks only
    if (!(t > lastT)) return;
    lastT = t;
    const r = ink.getBoundingClientRect();
    let xm = (ev.clientX - r.left) * MM_PER_PX, ym = (ev.clientY - r.top) * MM_PER_PX;
    const spd = speed.update(t, xm, ym);
    if (pad.syn.on) { const [dx, dy] = pad.tremor.offset(t, spd); xm += dx; ym += dy; }
    const [fx, fy] = pad.filter.step(t, xm, ym);
    const ok = Number.isFinite(fx) && Number.isFinite(fy);
    const raw = { x: xm / MM_PER_PX, y: ym / MM_PER_PX }, live = ok ? { x: fx / MM_PER_PX, y: fy / MM_PER_PX } : raw;
    cur.t.push(t); cur.raw.push(raw); cur.live.push(live); cur.pts.push(pad.steady ? live : raw);
    tail(ictx, cur.pts, cur.pts.length - 1, cur.color, cur.w);
    if (gctx) tail(gctx, cur.raw, cur.raw.length - 1, 'rgba(27,27,31,.28)', 1.25);
  }
  ink.addEventListener('pointerdown', (e) => {
    if (!pad.enabled || pointerId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'pen') sawPen = true;
    if (e.pointerType === 'touch' && sawPen) return; // palm rejection once a pen has been used
    e.preventDefault();
    try { ink.setPointerCapture(e.pointerId); } catch {}
    pointerId = e.pointerId; speed.reset(); pad.filter.startStroke(); lastT = -Infinity;
    cur = { t: [], raw: [], live: [], pts: [], w: pad.width(), color: pad.color(), steady: pad.steady };
    pad.strokes.push(cur);
    document.body.classList.add('drawing');
    pad.onStart(cur);
    ingest(e);
  });
  ink.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId || !cur) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ce of (evs.length ? evs : [e])) ingest(ce);
  });
  const end = (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null; document.body.classList.remove('drawing');
    const s = cur; cur = null;
    if (!s || !s.pts.length) { if (s) pad.strokes.pop(); return; }
    const k = SMOOTH_K[pad.smooth];
    if (s.steady && k != null && s.pts.length >= 3) {
      const prm = adaptiveParams(pad.filter, k);
      prm.base = SMOOTH_BASE[pad.smooth];
      const [xs, ys] = settleWith(s.t, s.live, prm);
      s.pts = clampTo(s.live, xs, ys, clampMm(tremorAmp(pad.filter)) / MM_PER_PX);
      s.settle = prm;
    }
    pad.redraw();
    pad.onEnd(s);
  };
  ink.addEventListener('pointerup', end);
  ink.addEventListener('pointercancel', end);
  ink.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('resize', pad.resize);
  // new real size: the filter's millimetres changed meaning, so it relearns the tremor
  onCalibrationChange(() => { pad.filter.reset(); pad.resize(); });
  pad.resize();
  return pad;
}

/** Settle a list of {x, y} px points with adaptive parameters (+ optional base cutoff). */
export function settleWith(t, pts, prm) {
  return adaptiveSettle(t, pts.map((p) => p.x), pts.map((p) => p.y), prm);
}
