// Real-size calibration, shared by every page. Steady's settings and every score are in millimetres, but screens
// differ: a CSS pixel is about 0.26 mm on a laptop, 0.19 mm on an iPad and 0.16 mm on a phone. Without this, an
// iPad reads every size about a third too big. The value is saved on this device only.
// MM_PER_PX is a live binding: modules that import it always see the current value.
const KEY = 'steady.calibration';
export const DEFAULT_MM_PER_PX = 25.4 / 96;           // the CSS standard: 96 px per inch
const CARD = [85.6, 53.98];                           // ID-1 card (bank, library, school ID): ISO/IEC 7810
const OK = (v) => Number.isFinite(v) && v > 0.05 && v < 1;

function read() {
  try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); if (c && OK(c.mmPerPx)) return c; } catch {}
  return null;
}
let saved = read();
export let MM_PER_PX = saved ? saved.mmPerPx : DEFAULT_MM_PER_PX;
const listeners = new Set();
function changed() { for (const fn of listeners) { try { fn(MM_PER_PX); } catch {} } }

/** {mmPerPx, calibrated, date, how} for the current device. */
export function calibration() {
  return { mmPerPx: MM_PER_PX, calibrated: !!saved, date: saved ? saved.date : null, how: saved ? saved.how : 'default' };
}
/** Save a measured value (how: 'card' | 'manual'), or pass null to go back to the standard guess. */
export function setMmPerPx(v, how = 'manual') {
  if (v == null) { saved = null; try { localStorage.removeItem(KEY); } catch {} }
  else {
    if (!OK(v)) return false;
    saved = { mmPerPx: v, date: new Date().toISOString(), how };
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch {}
  }
  MM_PER_PX = saved ? saved.mmPerPx : DEFAULT_MM_PER_PX; changed(); return true;
}
export function onCalibrationChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// another tab calibrated: follow it
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  saved = read(); MM_PER_PX = saved ? saved.mmPerPx : DEFAULT_MM_PER_PX; changed();
});

/** Short words for status lines. */
export function calibrationLabel() {
  return saved ? 'Real size set on this device' : 'Real size not set: sizes assume a standard laptop screen';
}

// ---------------------------------------------------------------- the dialog
const CSS = `
.cal-back { position: fixed; inset: 0; z-index: 100; background: rgba(27,27,31,.35); display: grid; place-items: center; padding: 12px; }
.cal { background: #fff; color: #1b1b1f; border-radius: 16px; padding: 18px 16px 16px; width: min(560px, 100%); max-height: 100%;
  overflow-y: auto; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.18);
  font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
.cal h2 { margin: 0; font-size: 18px; font-weight: 650; }
.cal p { margin: 0; color: #5f6066; font-size: 14px; }
.cal .cal-stage { display: grid; place-items: center; padding: 6px 0; }
.cal .cal-card { border: 3px solid #1f6b4e; border-radius: 3.2mm; background: rgba(31,107,78,.07); box-sizing: content-box;
  display: grid; place-items: center; color: #1f6b4e; font-weight: 600; font-size: 13px; }
.cal .cal-row { display: flex; gap: 8px; flex-wrap: wrap; }
.cal button { font: inherit; min-height: 48px; padding: 0 16px; border-radius: 12px; border: 1px solid #d9d9de; background: #fff;
  color: #1b1b1f; cursor: pointer; flex: 1 1 0; white-space: nowrap; }
.cal button.primary { background: #1f6b4e; border-color: #1f6b4e; color: #fff; font-weight: 600; }
.cal button:focus-visible { outline: 2px solid #1b1b1f; outline-offset: 2px; }
.cal .cal-val { font-variant-numeric: tabular-nums; color: #1b1b1f; }
/* phones: a card's short side (54 mm) is nearly the whole screen width, so use every pixel */
@media (max-width: 480px) {
  .cal-back { padding: 0; place-items: stretch; }
  .cal { border-radius: 0; padding: 14px 6px 10px; width: 100%; }
  .cal h2, .cal p { padding: 0 6px; }
  .cal .cal-stage { padding: 2px 0; }
}
`;
let styled = false;

/** Open the "match a card" dialog. onDone(saved: boolean) runs after it closes. */
export function openCalibration(onDone = () => {}) {
  if (!styled) { const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); styled = true; }
  const prevFocus = document.activeElement;
  let v = MM_PER_PX;
  const back = document.createElement('div'); back.className = 'cal-back';
  back.innerHTML = `<div class="cal" role="dialog" aria-modal="true" aria-labelledby="calTitle">
    <h2 id="calTitle">Set real size</h2>
    <p>Hold any bank, library or school ID card flat against the screen. Make the green box exactly the same size as the
      card. (No card? The box's long side should measure 85.6 mm with a ruler.)</p>
    <div class="cal-stage"><div class="cal-card"><span>card</span></div></div>
    <div class="cal-row">
      <button data-f="0.95">Smaller</button><button data-f="0.995">A little smaller</button>
      <button data-f="1.005">A little bigger</button><button data-f="1.05">Bigger</button>
    </div>
    <p class="cal-val"></p>
    <div class="cal-row">
      <button class="primary" data-act="save">Save</button><button data-act="cancel">Cancel</button>
      <button data-act="reset">Standard guess</button>
    </div></div>`;
  document.body.appendChild(back);
  const card = back.querySelector('.cal-card'), val = back.querySelector('.cal-val'), stage = back.querySelector('.cal-stage');
  const draw = () => {
    // long side across, unless it does not fit (phones): then turn the card upright
    const room = stage.clientWidth - 6, long = CARD[0] / v, short = CARD[1] / v;
    const [w, h] = long <= room ? [long, short] : [short, long];
    Object.assign(card.style, { width: `${w}px`, height: `${h}px` });
    val.textContent = `${v.toFixed(4)} mm per screen point` + (saved ? ` · saved ${new Date(saved.date).toLocaleDateString()}` : ' · not saved yet');
  };
  const close = (ok) => {
    back.remove(); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', draw);
    try { prevFocus && prevFocus.focus(); } catch {}
    onDone(ok);
  };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } };
  back.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) { if (e.target === back) close(false); return; }
    if (b.dataset.f) { v = Math.min(0.9, Math.max(0.06, v / +b.dataset.f)); draw(); }   // bigger box = fewer mm per point
    else if (b.dataset.act === 'save') { setMmPerPx(v, 'card'); close(true); }
    else if (b.dataset.act === 'reset') { setMmPerPx(null); close(true); }
    else close(false);
  });
  document.addEventListener('keydown', key, true); window.addEventListener('resize', draw);
  draw(); back.querySelector('button.primary').focus();
}
