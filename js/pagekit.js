// UI shared by the check-in and tracing pages: Steady switch, Demo popover (simulated tremor presets, raw line),
// popover open/close. Element ids follow draw.html (steady, steadyState, demoBtn, demoPop, synOn, presetList, ghostOn).
export const $ = (id) => document.getElementById(id);
export const DEMO_PRESETS = [
  ['healthy', 'Healthy', 'Normal tiny shake, about 0.1 mm'],
  ['et_mild', 'ET mild', 'Essential tremor: a visible wobble'],
  ['et_moderate', 'ET moderate', 'Essential tremor: clearly shaky lines'],
  ['et_severe', 'ET severe', 'Large, slower shake; very hard to draw'],
  ['pd_rest', "Parkinson's rest", 'Fades while moving, returns when you pause'],
];

export function wireCommon(pad, { onChange = () => {}, pops = { demoBtn: 'demoPop' } } = {}) {
  const sync = () => {
    $('steady').setAttribute('aria-checked', String(pad.steady)); $('steadyState').textContent = pad.steady ? 'On' : 'Off';
    $('synOn').setAttribute('aria-checked', String(pad.syn.on)); $('ghostOn').setAttribute('aria-checked', String(pad.ghost));
    for (const b of document.querySelectorAll('#presetList .preset')) b.setAttribute('aria-pressed', String(b.dataset.k === pad.syn.preset));
    pad.redraw(); onChange();
  };
  for (const [k, name, note] of DEMO_PRESETS) {
    const b = document.createElement('button');
    b.className = 'preset'; b.dataset.k = k; b.setAttribute('aria-pressed', 'false');
    b.innerHTML = '<span class="p-name"></span><span class="p-note"></span>';
    b.firstChild.textContent = name; b.lastChild.textContent = note;
    b.addEventListener('click', () => { pad.setPreset(k); sync(); });
    $('presetList').appendChild(b);
  }
  $('synOn').onclick = () => { pad.syn.on = !pad.syn.on; sync(); };
  $('ghostOn').onclick = () => { pad.ghost = !pad.ghost; sync(); };
  $('steady').onclick = () => { pad.steady = !pad.steady; sync(); };
  const close = () => { for (const [b, p] of Object.entries(pops)) { $(p).hidden = true; $(b).setAttribute('aria-expanded', 'false'); } };
  for (const [b, p] of Object.entries(pops)) $(b).addEventListener('click', (e) => {
    e.stopPropagation(); const open = $(p).hidden; close();
    if (open) { $(p).hidden = false; $(b).setAttribute('aria-expanded', 'true'); }
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.pop') && !e.target.closest('[aria-haspopup]')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  sync();
  return { sync, close };
}

/** Download text or a canvas as a file. */
export function download(nameOrPrefix, data) {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const go = (blob, name) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  if (data instanceof HTMLCanvasElement) data.toBlob((b) => go(b, `${nameOrPrefix}-${stamp}.png`), 'image/png');
  else go(new Blob([data], { type: 'text/csv' }), `${nameOrPrefix}-${stamp}.csv`);
}

/** Size a canvas to its CSS box at device pixel ratio; returns the 2d context in CSS-pixel units. */
export function fitCanvas(c) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3), r = c.getBoundingClientRect();
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}
