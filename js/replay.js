// Slow-motion replay of one stroke: the hand's raw path and Steady's live line grow together at real
// recorded timing (slowed down), with a dot for each, so you can see Steady ignore the shake without
// trailing behind. At the end the line settles into the final stroke (if Smoothing was on).
// Input: { t: [s], raw: [{x,y}], live: [{x,y}], final: [{x,y}], color, width, steady } in CSS px.
const SPEEDS = [0.25, 0.5, 1];
const SETTLE_S = 0.6; // seconds of the settle crossfade at the end

export function openReplay(st, onClose) {
  const ov = document.createElement('div');
  ov.className = 'replay'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Stroke replay');
  ov.innerHTML = `
    <div class="replay-head"><p class="pop-title">Replay</p>
      <p class="replay-legend"><span class="key raw"></span>Your hand <span class="key live"></span>Steady, while drawing
      <span class="key fin"></span>Final line</p></div>
    <canvas class="replay-cv" aria-label="Replay of the last stroke"></canvas>
    <div class="replay-bar">
      <button class="text rp-play">Play again</button>
      <button class="text rp-speed"></button>
      <span class="replay-time" aria-live="off"></span>
      <button class="text rp-close">Close</button>
    </div>`;
  document.body.appendChild(ov);
  const cv = ov.querySelector('canvas'), ctx = cv.getContext('2d');
  const $ = (q) => ov.querySelector(q);
  let speedI = 0, start = 0, raf = 0;
  const T0 = st.t[0], dur = st.t[st.t.length - 1] - T0;
  const all = st.raw.concat(st.live, st.final);
  const bx0 = Math.min(...all.map((p) => p.x)), bx1 = Math.max(...all.map((p) => p.x));
  const by0 = Math.min(...all.map((p) => p.y)), by1 = Math.max(...all.map((p) => p.y));

  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3), r = cv.getBoundingClientRect();
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    const sc = Math.min((r.width - 48) / Math.max(1, bx1 - bx0), (r.height - 48) / Math.max(1, by1 - by0), 4);
    const ox = (r.width - (bx1 - bx0) * sc) / 2 - bx0 * sc, oy = (r.height - (by1 - by0) * sc) / 2 - by0 * sc;
    return { dpr, sc, ox, oy, W: r.width, H: r.height };
  }
  let view = fit();
  const P = (p) => [view.ox + p.x * view.sc, view.oy + p.y * view.sc];
  function line(pts, n, color, width, alpha = 1) {
    if (n < 1) return;
    ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(...P(pts[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(...P(pts[i]));
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  function dot(p, color, r, ring) {
    const [x, y] = P(p); ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
    if (ring) { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); } else { ctx.fillStyle = color; ctx.fill(); }
  }
  function frame(now) {
    const speed = SPEEDS[speedI], el = (now - start) / 1000 * speed; // seconds of stroke time
    const tt = T0 + Math.min(el, dur);
    let n = 0; while (n < st.t.length && st.t[n] <= tt) n++;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0); ctx.clearRect(0, 0, view.W, view.H);
    const w = Math.max(1.5, st.width * Math.min(view.sc, 2));
    const settleU = st.steady ? Math.min(1, Math.max(0, (el - dur) / SETTLE_S)) : 0;
    line(st.raw, n, '#9a9aa0', 1.5);
    if (st.steady) line(st.live, n, st.color, w, 1 - settleU);
    if (settleU > 0) line(st.final, st.final.length, '#1f6b4e', w, settleU);
    if (n > 0 && el <= dur) {
      const a = P(st.raw[n - 1]), b = P(st.live[n - 1]);
      ctx.strokeStyle = '#c9c9cf'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      dot(st.raw[n - 1], '#6b6b70', 7, true);
      if (st.steady) dot(st.live[n - 1], st.color, 5, false);
    }
    $('.replay-time').textContent = `${Math.min(el, dur).toFixed(1)} s of ${dur.toFixed(1)} s, ${speed === 1 ? 'real speed' : `${1 / speed}x slower`}`;
    if (el < dur + (st.steady ? SETTLE_S : 0)) raf = requestAnimationFrame(frame);
  }
  function play() { cancelAnimationFrame(raf); start = performance.now(); raf = requestAnimationFrame(frame); }
  function setSpeedLabel() { const s = SPEEDS[speedI]; $('.rp-speed').textContent = `Speed: ${s === 1 ? 'real' : `${1 / s}x slower`}`; }
  function close() {
    cancelAnimationFrame(raf); ov.remove(); window.removeEventListener('resize', onResize); document.removeEventListener('keydown', onKey); onClose?.();
  }
  const onResize = () => { view = fit(); play(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  $('.rp-play').onclick = play;
  $('.rp-speed').onclick = () => { speedI = (speedI + 1) % SPEEDS.length; setSpeedLabel(); play(); };
  $('.rp-close').onclick = close;
  window.addEventListener('resize', onResize); document.addEventListener('keydown', onKey);
  setSpeedLabel(); play(); $('.rp-close').focus();
  return { close };
}
