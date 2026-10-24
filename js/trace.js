// Trace and colour pages, scored automatically.
//   Trace:  follow a grey path (lane 5 mm wide). Score = share of your ink inside the lane; Covered = share of
//           the path (sampled every 2 mm) that has ink within half a lane.
//   Colour: fill a shape. Score = share of your ink inside the outline; Filled = share of the shape covered.
// Every score is computed twice: for the line on screen and for the raw hand (what it would have been without Steady).
// Masks are rasterised at half resolution; good enough for whole percentages.
import { createPad, MM_PER_PX } from './pad.js?v=13';
import { $, wireCommon, fitCanvas } from './pagekit.js?v=13';

const LANE_MM = 5, TRACE_W = 4, COLOUR_W = 18, MS = 0.5; // mask scale
const PAINTS = [['Viridian', '#1f7a5a'], ['Ultramarine', '#2b4cc4'], ['Ochre', '#d39b2a'], ['Vermilion', '#e0472b'], ['Violet', '#6a3d9a']];

// ---------------------------------------------------------------- pages (unit coordinates, about -1..1)
const range = (n, f) => Array.from({ length: n + 1 }, (_, i) => f(i / n));
const PAGES = [
  { key: 'wave', name: 'Wave', mode: 'trace', note: 'Gentle curves', path: () => range(300, (u) => [-1 + 2 * u, 0.35 * Math.sin(u * 3 * 2 * Math.PI)]) },
  { key: 'zigzag', name: 'Mountains', mode: 'trace', note: 'Sharp corners', path: () => { const p = []; for (let i = 0; i <= 8; i++) p.push([-1 + i / 4, i % 2 ? -0.4 : 0.4]); return densify(p); } },
  { key: 'loops', name: 'Loops', mode: 'trace', note: 'Like joined writing', path: () => range(500, (u) => { const a = u * 5 * 2 * Math.PI; return [-0.95 + 1.9 * u + 0.16 * Math.sin(a), -0.32 * Math.cos(a)]; }) },
  { key: 'star', name: 'Star', mode: 'trace', note: 'Five points, closed', path: () => densify(starPts(true)) },
  { key: 'flower', name: 'Flower', mode: 'trace', note: 'Round petals', path: () => range(600, (u) => { const a = u * 2 * Math.PI, r = 0.35 + 0.55 * Math.abs(Math.cos(2.5 * a)); return [r * Math.cos(a), r * Math.sin(a)]; }) },
  { key: 'circle', name: 'Circle', mode: 'colour', note: 'Fill it in', path: () => range(200, (u) => [0.8 * Math.cos(u * 2 * Math.PI), 0.8 * Math.sin(u * 2 * Math.PI)]) },
  { key: 'heart', name: 'Heart', mode: 'colour', note: 'Fill it in', path: () => range(300, (u) => { const a = u * 2 * Math.PI; return [0.055 * 16 * Math.sin(a) ** 3, -0.055 * (13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) - 0.05]; }) },
  { key: 'bigstar', name: 'Star', mode: 'colour', note: 'Points are hard', path: () => densify(starPts(true).map(([x, y]) => [x * 1.05, y * 1.05])) },
];
function starPts(closed) {
  const p = [];
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.4 : 0.95; p.push([r * Math.cos(a), r * Math.sin(a)]); }
  if (closed) p.push(p[0]);
  return p;
}
function densify(p, step = 0.01) {
  const out = [p[0]];
  for (let i = 1; i < p.length; i++) {
    const [ax, ay] = p[i - 1], [bx, by] = p[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
  }
  return out;
}

// ---------------------------------------------------------------- state
let page = PAGES[0], paint = PAINTS[0][1], tpl = []; // tpl = page path in CSS px
try { const k = localStorage.getItem('steady.trace.page'); page = PAGES.find((p) => p.key === k) || page; } catch {}
const pad = createPad($('ink'), $('ghost'), {
  width: () => (page.mode === 'colour' ? COLOUR_W : TRACE_W),
  color: () => (page.mode === 'colour' ? paint : '#1b1b1f'),
  onEnd: () => { $('scoreBtn').disabled = false; status(); },
});
pad.smooth = 'smooth';
const ui = wireCommon(pad);

function layout() {
  const w = pad.w, h = pad.h, top = 110, bottom = 110;
  const sc = Math.min(w * 0.42, (h - top - bottom) / 2 * 0.92), cx = w / 2, cy = top + (h - top - bottom) / 2;
  return { sc, cx, cy };
}
function shapePath(ctx) { ctx.beginPath(); tpl.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); }
function drawGuide() {
  const { ctx, w, h } = fitCanvas($('guide'));
  const { sc, cx, cy } = layout();
  tpl = page.path().map(([x, y]) => [cx + x * sc, cy + y * sc]);
  ctx.clearRect(0, 0, w, h); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (page.mode === 'trace') {
    shapePath(ctx); ctx.strokeStyle = '#e9e9ee'; ctx.lineWidth = LANE_MM / MM_PER_PX; ctx.stroke();
    shapePath(ctx); ctx.strokeStyle = '#c4c4cb'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 6]); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#1f6b4e'; ctx.beginPath(); ctx.arc(tpl[0][0], tpl[0][1], 6, 0, 2 * Math.PI); ctx.fill();
  } else {
    shapePath(ctx); ctx.closePath(); ctx.strokeStyle = '#3a3a40'; ctx.lineWidth = 3; ctx.stroke();
  }
  $('pageName').textContent = `${page.mode === 'trace' ? 'Trace' : 'Colour'}: ${page.name}`;
  $('paints').hidden = $('paintSep').hidden = page.mode !== 'colour';
}
function status(msg) {
  $('status').textContent = msg || (page.mode === 'trace'
    ? (pad.strokes.length ? 'Keep following the path. Press Score when you are done.' : 'Start at the green dot and follow the grey path.')
    : (pad.strokes.length ? 'Fill the whole shape, staying inside the outline. Then press Score.' : 'Colour in the shape. Try to stay inside the outline.'));
}

// ---------------------------------------------------------------- scoring
function mask(draw) {
  const c = document.createElement('canvas'); c.width = Math.ceil(pad.w * MS); c.height = Math.ceil(pad.h * MS);
  const x = c.getContext('2d', { willReadFrequently: true }); x.scale(MS, MS); x.lineCap = 'round'; x.lineJoin = 'round';
  x.strokeStyle = x.fillStyle = '#000'; draw(x);
  const d = x.getImageData(0, 0, c.width, c.height).data, out = new Uint8Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  return out;
}
function inkMask(which) {
  return mask((x) => {
    for (const s of pad.strokes) {
      const p = s[which]; x.lineWidth = s.w;
      if (p.length === 1) { x.beginPath(); x.arc(p[0].x, p[0].y, s.w / 2, 0, 2 * Math.PI); x.fill(); continue; }
      x.beginPath(); p.forEach((q, i) => (i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y))); x.stroke();
    }
  });
}
export function score(which) {
  const area = mask((x) => { if (page.mode === 'trace') { x.lineWidth = LANE_MM / MM_PER_PX; shapePath(x); x.stroke(); } else { shapePath(x); x.closePath(); x.fill(); } });
  const ink = inkMask(which);
  let nInk = 0, nIn = 0, nArea = 0, nCov = 0;
  for (let i = 0; i < ink.length; i++) { nInk += ink[i]; nIn += ink[i] & area[i]; nArea += area[i]; }
  const inside = nInk ? nIn / nInk : NaN;
  if (page.mode === 'colour') { for (let i = 0; i < ink.length; i++) nCov += ink[i] & area[i]; return { inside, second: nArea ? nCov / nArea : NaN }; }
  // coverage of the path: sample every 2 mm, covered if any ink point lies within half a lane
  const r2 = (LANE_MM / 2 / MM_PER_PX) ** 2, step = 2 / MM_PER_PX, samples = [];
  let acc = 0;
  for (let i = 1; i < tpl.length; i++) { acc += Math.hypot(tpl[i][0] - tpl[i - 1][0], tpl[i][1] - tpl[i - 1][1]); if (acc >= step || i === 1) { samples.push(tpl[i]); acc = 0; } }
  const pts = pad.strokes.flatMap((s) => s[which]);
  for (const [sx, sy] of samples) if (pts.some((q) => (q.x - sx) ** 2 + (q.y - sy) ** 2 <= r2)) nCov++;
  return { inside, second: samples.length ? nCov / samples.length : NaN };
}
const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)} %` : '–');
$('scoreBtn').onclick = () => {
  if (!pad.strokes.length) return;
  const a = score('pts'), r = score('raw'), steadyUsed = pad.strokes.some((s) => s.steady);
  $('sMain').textContent = pct(a.inside);
  $('sMainNote').textContent = 'of your ink inside the lines';
  $('sSecondLbl').textContent = page.mode === 'trace' ? 'Path covered' : 'Shape filled';
  $('sSecond').textContent = pct(a.second);
  $('sRaw').textContent = steadyUsed ? `${pct(r.inside)} inside` : 'Steady was off';
  $('sNote').textContent = steadyUsed && Number.isFinite(r.inside)
    ? (a.inside - r.inside >= 0.02 ? `Steady kept ${Math.round((a.inside - r.inside) * 100)} more points of every 100 inside the lines.` : 'With this little shake, Steady and your raw hand score about the same.')
    : 'Turn Steady on and try again to compare.';
  $('sheet').hidden = false; pad.enabled = false;
  status('Here is your score.');
  window.__steadyTraceLast = { a, r };
};
function restart() { pad.clear(); $('sheet').hidden = true; pad.enabled = true; $('scoreBtn').disabled = true; status(); }
$('restart').onclick = restart; $('again').onclick = restart;
$('nextPage').onclick = () => setPage(PAGES[(PAGES.indexOf(page) + 1) % PAGES.length]);

function setPage(p) {
  page = p; try { localStorage.setItem('steady.trace.page', p.key); } catch {}
  $('pickPanel').hidden = true; drawGuide(); restart(); renderPicks();
}

// ---------------------------------------------------------------- picker + paints
function renderPicks() {
  for (const [id, mode] of [['pickTrace', 'trace'], ['pickColour', 'colour']]) {
    const box = $(id); box.textContent = '';
    for (const p of PAGES.filter((q) => q.mode === mode)) {
      const b = document.createElement('button'); b.className = 'pick'; b.setAttribute('aria-pressed', String(p === page));
      const c = document.createElement('canvas'); c.setAttribute('aria-hidden', 'true');
      const n = document.createElement('span'); n.textContent = p.name; const sm = document.createElement('small'); sm.textContent = p.note;
      b.append(c, n, sm); b.onclick = () => setPage(p); box.appendChild(b);
      requestAnimationFrame(() => {
        const { ctx, w, h } = fitCanvas(c), s = Math.min(w, h) * 0.45;
        ctx.strokeStyle = '#3a3a40'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.beginPath();
        p.path().forEach(([x, y], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, w / 2 + x * s, h / 2 + y * s)); ctx.stroke();
      });
    }
  }
}
for (const [name, c] of PAINTS) {
  const b = document.createElement('button'); b.className = 'swatch'; b.style.background = c; b.title = name; b.setAttribute('aria-label', name);
  b.onclick = () => { paint = c; syncPaints(); };
  $('paints').appendChild(b);
}
function syncPaints() { for (const b of $('paints').children) b.setAttribute('aria-pressed', String(b.style.background && b.title === PAINTS.find(([, c]) => c === paint)[0])); }
$('pickBtn').onclick = () => { ui.close(); $('pickPanel').hidden = false; renderPicks(); $('pickClose').focus(); };
$('pickClose').onclick = () => { $('pickPanel').hidden = true; $('pickBtn').focus(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('pickPanel').hidden) $('pickClose').click(); });
window.addEventListener('resize', () => { drawGuide(); });

drawGuide(); syncPaints(); status();
window.__steadyTrace = { pad, score, get tpl() { return tpl; }, setPage, PAGES }; // automated checks only
