// Site menu, shared by every page except the start page. The "Steady" name at the top left is a button that opens a
// list of all pages (current one marked), so you can always get home or anywhere else. Self-contained: it adds its
// own styles and works with each page's header. Close with Esc, a tap outside, or the button again.
const PAGES = [
  ['', [['index.html', 'Home', 'Start page']]],
  ['Draw', [['draw.html', 'Draw', 'The drawing app with Steady'], ['booth.html', 'Try Steady', 'Booth demo: three versions side by side']]],
  ['Practise and measure', [['trace.html', 'Trace and colour', 'Stay in the lines, get a score'], ['checkin.html', 'Spiral check-in', 'Measure your shake, keep a log']]],
  ['For testing', [['lab.html', 'Lab', 'Compare filters, studies, tremor pen']]],
  ['About the project', [['judges.html', 'For judges', 'Results, how it works, limits'], ['participants.html', 'For participants', 'What a test session involves'], ['testers.html', 'For testers', 'Checklist and report']]],
];
const CSS = `
.site-menu { font: inherit; color: inherit; background: none; border: 0; padding: 0 8px 0 4px; margin-left: -4px; min-height: 40px;
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer; border-radius: 10px; font-weight: 650; letter-spacing: -.01em; }
.site-menu:hover, .site-menu[aria-expanded="true"] { background: rgba(27,27,31,.06); }
.site-menu:focus-visible { outline: 2px solid #1b1b1f; outline-offset: 2px; }
.site-menu svg { width: 20px; height: 20px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.site-panel { position: fixed; z-index: 90; background: #fff; color: #1b1b1f; border: 1px solid #d9d9de; border-radius: 14px;
  box-shadow: 0 8px 30px rgba(0,0,0,.14); padding: 6px; overflow-y: auto; -webkit-overflow-scrolling: touch;
  font: 15px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
.site-panel[hidden] { display: none; }
.site-panel p { margin: 10px 10px 4px; font-size: 12.5px; font-weight: 650; color: #5f6066; }
.site-panel a { display: flex; flex-direction: column; justify-content: center; min-height: 48px; padding: 6px 10px; border-radius: 10px;
  color: #1b1b1f; text-decoration: none; }
.site-panel a span { font-size: 13px; color: #5f6066; }
.site-panel a:hover { background: #f3f3f5; }
.site-panel a[aria-current="page"] { background: #f3f3f5; box-shadow: inset 3px 0 0 #1f6b4e; }
.site-panel a[aria-current="page"] b::after { content: "  · you are here"; font-weight: 400; color: #5f6066; font-size: 13px; }
.site-panel a:focus-visible { outline: 2px solid #1b1b1f; outline-offset: -2px; }
`;

function here() {
  const f = location.pathname.split('/').pop();
  return f === '' ? 'index.html' : f;
}

export function initSiteMenu(btn) {
  if (!btn || btn.dataset.ready) return;
  btn.dataset.ready = '1';
  if (!document.getElementById('site-menu-css')) {
    const st = document.createElement('style'); st.id = 'site-menu-css'; st.textContent = CSS; document.head.appendChild(st);
  }
  btn.setAttribute('aria-haspopup', 'true'); btn.setAttribute('aria-expanded', 'false');
  if (!btn.querySelector('svg')) btn.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>');
  if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', 'Menu: all pages');
  const panel = document.createElement('nav'); panel.className = 'site-panel'; panel.hidden = true; panel.id = 'sitePanel';
  panel.setAttribute('aria-label', 'All pages'); btn.setAttribute('aria-controls', panel.id);
  const cur = here();
  for (const [group, items] of PAGES) {
    if (group) { const p = document.createElement('p'); p.textContent = group; panel.appendChild(p); }
    for (const [href, name, note] of items) {
      const a = document.createElement('a'); a.href = href;
      const b = document.createElement('b'); b.textContent = name; const s = document.createElement('span'); s.textContent = note;
      a.append(b, s); if (href === cur) a.setAttribute('aria-current', 'page');
      panel.appendChild(a);
    }
  }
  document.body.appendChild(panel);
  const place = () => {
    const r = btn.getBoundingClientRect(), top = Math.round(r.bottom + 8), w = Math.min(340, innerWidth - 24);
    Object.assign(panel.style, { top: `${top}px`, left: `${Math.max(12, Math.min(r.left, innerWidth - w - 12))}px`, width: `${w}px`,
      maxHeight: `${innerHeight - top - 12}px` });
  };
  const open = () => { place(); panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); (panel.querySelector('[aria-current]') || panel.querySelector('a')).focus(); };
  const close = (focus) => { if (panel.hidden) return; panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (focus) btn.focus(); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); panel.hidden ? open() : close(false); });
  document.addEventListener('pointerdown', (e) => { if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) close(false); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { e.stopPropagation(); close(true); } }, true);
  window.addEventListener('resize', () => { if (!panel.hidden) place(); });
}

for (const b of document.querySelectorAll('[data-site-menu]')) initSiteMenu(b);
