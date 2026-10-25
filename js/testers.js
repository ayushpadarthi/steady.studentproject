// Tester checklist: steps grouped by page, each marked Works / Problem / Skip with an optional note.
// Saved in localStorage on this device; the report (text) includes device facts so bugs can be reproduced.
import { calibration } from './calib.js?v=22';

const KEY = 'steady.testers.v1';
const GROUPS = [
  ['Set up', [
    ['realsize', 'Set real size', 'In <a href="draw.html">Draw</a>: Demo → "Set real size (match a card)". Hold a card on the screen and match the green box. Does the box end up exactly card-sized?'],
    ['install', 'Works offline', 'Open the start page once with internet. Then turn Wi-Fi off and reload Draw. Does it still open?'],
  ]],
  ['Drawing app', [
    ['draw', 'Draw and undo', 'Draw a few lines with your finger or stylus. Undo and Redo. Do lines appear under the pen with no gaps?'],
    ['pressure', 'Pen pressure and palm', 'With a stylus: press harder for a thicker line. Rest your palm on the screen while drawing. Does the palm leave no marks?'],
    ['eraser', 'Eraser', 'Use the eraser tool. If your stylus has an eraser end, flip it over. Does it erase?'],
    ['autosave', 'Drawing kept', 'Draw something, then reload the page. Is the drawing back, with "Your last drawing is back"?'],
    ['clear', 'Clear needs two taps', 'Tap Clear once (nothing should happen except "Tap again"), then again. Does Undo bring the drawing back?'],
    ['save', 'Save picture', 'Press Save. Does a PNG of your drawing download?'],
  ]],
  ['Steady with a simulated tremor', [
    ['tremor', 'Tremor removed', 'Demo → Simulate tremor → ET moderate, and Show the raw, shaky line. Draw a spiral. Is the coloured line much steadier than the grey one? Does the top line say "Removing a … Hz shake"?'],
    ['lag', 'No lag feeling', 'Draw fast loops with Steady on. Does the line keep up with the pen?'],
    ['settle', 'Settling', 'Line button → Smoothing: Smooth, then Extra. Does each stroke smooth a little when you lift the pen, without changing its shape?'],
    ['zigzag', 'Deliberate zigzag kept', 'Turn the simulated tremor off. Draw a big, fast zigzag. Does the line keep the zigzag, and does the top line say "Slow, big wiggle: keeping it as drawing"?'],
    ['race', 'Lag race', 'Demo → Simulate tremor on, then Lag race on. Draw a fast spiral. Does a blue line trail behind your pen, and does the card show Steady much closer to the pen than the stabiliser?'],
    ['replay', 'Replay and before/after', 'Press R (or Demo → Replay). Then Demo → Save before/after picture. Do both work?'],
    ['healthy', 'Normal hand', 'Turn the simulated tremor off and write your name normally with Steady on and off. Does Steady ever make it look worse?'],
  ]],
  ['Lab', [
    ['compare', 'Compare filters', 'In the <a href="lab.html">Lab</a>: tick simulated tremor, draw a spiral, press "Compare filters on this drawing". Do four panels show, with numbers, in both views?'],
    ['study', 'Study mode runs', 'Switch to Study, enter a test code like TEST1, run one condition. Do CSV files download? (Practice only: no real participants.)'],
  ]],
  ['Measurement pages', [
    ['checkin', 'Spiral check-in', 'In <a href="checkin.html">Spiral check-in</a>: trace the spiral, press Done, then Save to my log, then open the log. Are the numbers and chart shown?'],
    ['trace', 'Trace and colour', 'In <a href="trace.html">Trace and colour</a>: do one trace page and one colouring page and press Score. Do the scores look sensible?'],
  ]],
  ['Layout and feel', [
    ['phone', 'Fits the screen', 'On this device, in portrait and landscape: is every button reachable, nothing cut off, no sideways scrolling?'],
    ['buttons', 'Easy to hit', 'Are buttons big enough to hit with a shaky hand? Note any that are too small or too close together.'],
    ['words', 'Clear words', 'Is any label or message confusing? Note the exact words.'],
  ]],
];
const ALL = GROUPS.flatMap(([, items]) => items);

let st = {};
try { st = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { st = {}; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} };
const $ = (id) => document.getElementById(id);

function render() {
  const list = $('list'); list.textContent = '';
  for (const [title, items] of GROUPS) {
    const h = document.createElement('h2'); h.textContent = title; list.appendChild(h);
    for (const [id, what, how] of items) {
      const s = st[id] || {};
      const box = document.createElement('div'); box.className = 'check'; box.dataset.id = id;
      box.innerHTML = `<div class="what"></div><div class="how">${how}</div>
        <div class="res" role="group"></div><textarea rows="2" placeholder="What did you do, and what happened?"></textarea>`;
      box.querySelector('.what').textContent = what;
      box.querySelector('.res').setAttribute('aria-label', `Result: ${what}`);
      const note = box.querySelector('textarea'); note.value = s.note || ''; note.setAttribute('aria-label', `Note: ${what}`);
      note.hidden = !(s.r === 'problem' || s.note);
      note.addEventListener('input', () => { st[id] = { ...(st[id] || {}), note: note.value }; save(); });
      for (const [r, label] of [['pass', 'Works'], ['problem', 'Problem'], ['skip', 'Skip']]) {
        const b = document.createElement('button'); b.dataset.r = r; b.textContent = label;
        b.setAttribute('aria-pressed', String(s.r === r));
        b.addEventListener('click', () => {
          const cur = (st[id] || {}).r === r ? undefined : r;              // a second press clears the mark
          st[id] = { ...(st[id] || {}), r: cur }; save();
          for (const o of box.querySelectorAll('.res button')) o.setAttribute('aria-pressed', String(o.dataset.r === cur));
          if (cur === 'problem') { note.hidden = false; note.focus(); }
          tally();
        });
        box.querySelector('.res').appendChild(b);
      }
      list.appendChild(box);
    }
  }
  tally();
}
function tally() {
  const done = ALL.filter(([id]) => st[id] && st[id].r).length, prob = ALL.filter(([id]) => st[id] && st[id].r === 'problem').length;
  $('tally').textContent = `${done} of ${ALL.length} done` + (prob ? ` · ${prob} problem${prob > 1 ? 's' : ''}` : '');
}

function report() {
  const c = calibration(), d = new Date();
  const mark = { pass: 'WORKS', problem: 'PROBLEM', skip: 'skip' };
  const L = [
    'Steady test report', `Date: ${d.toLocaleString()}`, `Tester / device: ${$('tester').value.trim() || '(not given)'}`,
    `Browser: ${navigator.userAgent}`,
    `Screen: ${screen.width}x${screen.height} CSS px, window ${innerWidth}x${innerHeight}, pixel ratio ${devicePixelRatio}`,
    `Input: ${matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse/trackpad'}${navigator.maxTouchPoints ? `, ${navigator.maxTouchPoints} touch points` : ''}`,
    `Real size: ${c.calibrated ? `set (${c.mmPerPx.toFixed(4)} mm per point, ${c.how})` : 'not set'}`,
    `Online: ${navigator.onLine ? 'yes' : 'no'}`, '',
  ];
  for (const [title, items] of GROUPS) {
    L.push(`## ${title}`);
    for (const [id, what] of items) {
      const s = st[id] || {};
      L.push(`- [${s.r ? mark[s.r] : '    '}] ${what}${s.note ? `\n    note: ${s.note.replace(/\n/g, ' ')}` : ''}`);
    }
    L.push('');
  }
  return L.join('\n');
}

$('tester').value = st.__tester || '';
$('tester').addEventListener('input', (e) => { st.__tester = e.target.value; save(); });
$('dl').onclick = () => {
  const a = document.createElement('a'), d = new Date(), p = (n) => String(n).padStart(2, '0');
  a.href = URL.createObjectURL(new Blob([report()], { type: 'text/plain' }));
  a.download = `steady-test-report-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(report()); $('copy').textContent = 'Copied'; }
  catch { $('copy').textContent = 'Could not copy: use Download'; }
  setTimeout(() => { $('copy').textContent = 'Copy report'; }, 2000);
};
let armed = null;
$('reset').onclick = () => {
  if (!armed) { $('reset').textContent = 'Tap again to clear'; armed = setTimeout(() => { armed = null; $('reset').textContent = 'Start over'; }, 3000); return; }
  clearTimeout(armed); armed = null; $('reset').textContent = 'Start over';
  const t = st.__tester; st = t ? { __tester: t } : {}; save(); render();
};
render();
window.__steadyTesters = { report, GROUPS }; // automated checks only
