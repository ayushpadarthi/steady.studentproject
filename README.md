# Steady web app

Static, dependency-free web app (plain HTML + JavaScript modules). No build step, no network calls: nothing the
user draws leaves the browser (preferences and the check-in log stay in `localStorage` on the device).
Live: https://ayushpadarthi.github.io/steady.studentproject/

## Pages
| Page | Role | Main files |
|---|---|---|
| `index.html` | Start page | (inline CSS) |
| **`draw.html`** | **The product:** full-screen drawing with the Steady filter | `js/draw.js`, `css/draw.css` |
| `trace.html` | Measurement task: trace (5 mm lane) and colouring pages, scored for the screen line and the raw hand | `js/trace.js` |
| `checkin.html` | Measurement task: spiral check-in with shake size/speed and a dated log on the device | `js/checkin.js` |
| `lab.html` | Evidence tool: compare filters on one drawing, study mode with CSV export, tremor-pen link + truth meter | `js/main.js`, `css/style.css` |

All pages use the **same** `js/filters.js`, so study results apply to the drawing app.

### Drawing app
- **Basics:** Steady on/off switch, brush and eraser, 10 colours, 4 sizes, pen pressure, undo/redo, two-tap clear,
  save PNG, palm rejection once a pen is used.
- **Shortcuts:** Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, Cmd/Ctrl+S, B, E, S, M (smoothing), K (shake style), R (replay), [ ].
- **Line menu:**
  - Smoothing: Off / Smooth / Extra. Each finished stroke settles after pen-up, scaled by the detected tremor and
    limited to a shake-sized movement.
  - Shake style (*experimental*, future work): None / Keep 30 % / Ink pulse / Stipple / Hatching.
- **Demo panel:**
  - simulated tremor presets (never restored as "on");
  - raw line in grey;
  - a "Your shake" card;
  - slow-motion replay;
  - a before/after picture;
  - links to the other pages.

### Design rules (keep them)
- Canvas first; tools fade while drawing.
- Targets at least 48 px in the drawing app and at least 40 px in the lab (44 px on touch screens).
- State shown in words, not colour alone.
- One accent colour (green = Steady); system font.
- No gradients, glows or decorative icons.
- Works at 375 px wide.

## Run locally
```
cd software
python3 -m http.server 8765      # then open http://localhost:8765/app/
```
Chrome or Edge are needed only for the tremor-pen link (Web Serial; `localhost` counts as secure). Everything else
works in any modern browser, including Safari on iPad.

## Tests
Serve `software/` (so `../../shared/test_vectors` is reachable), open any page, then in the console:
`(await import('/app/tests/filters.test.mjs')).runTests()`. That runs 45 checks:
- every filter, plus stroke semantics;
- parity with the Python reference vectors, v1-v4 (output, gate and zero-lag estimate to about 1e-12);
- settling and the shake-size limit;
- the shake-style tracker;
- the truth meter;
- a speed check (Steady on both axes must stay under 0.3 ms per sample; about 0.04 ms in Chrome).

With `node` installed: `node software/app/tests/filters.test.mjs`.

## Releases
Pages load files as `?v=N` so browsers never mix old and new code (GitHub Pages caches for 10 minutes). **Bump N in
every `.html` and every `import` line when publishing** (currently 13).

## Filters (`js/filters.js`)
| Name | What |
|---|---|
| `raw`, `ema` (2 Hz), `one_euro` (1.0 / 0.007 / 1.0) | Baselines |
| `steady` = **SteadyV4** | SteadyV3 algorithm with `V4_PARAMS` (retuned on realistic tremor). Parity: `shared/test_vectors/steady_v4_kalman.json` |
| `steady_v3` | Gated SteadyV2 (0.1→0.3 mm detected tremor) + 10 Hz finish; exposes `y2`, the zero-lag estimate used by shake style |
| `steady_v2` | Mix of 4 Kalman filters, each with 19 oscillators at 3-12 Hz |
| `steady_v1` | Original filter with an FFT frequency tracker (free play only) |

**Strokes:** tremor continues while the pen is lifted, so `pointerdown` calls `startStroke()`, which keeps the
learned tremor and restarts only the line. A new filter (forgetting the tremor) is created only when the filter
changes, a new study session starts, or a new study condition starts.

## Other files
| File | What |
|---|---|
| `js/settle.js` | After-pen-up settling: zero-phase low-pass, adaptive strength (thresholds 0.2/0.4 mm for v4), shake-size limit |
| `js/tremor.js` | Realistic simulated tremor (port of `software/core/steady/tremor_models.py`) |
| `js/compare.js` | Compare overlay: "While drawing" vs "Final line", with wiggle, lag, and distance off the intended line (when tremor is simulated) |
| `js/pad.js`, `js/pagekit.js`, `css/pages.css` | Shared input pipeline and Demo panel for the trace and check-in pages |
| `js/shakestyle.js`, `js/replay.js` | Shake style tracker; slow-motion replay |
| `js/serial.js`, `js/penmeter.js` | Tremor-pen link over USB; truth meter (frequency and tip size from the pen's gyro and from its commanded movement) |
| `js/tasks.js`, `js/study.js` | Spiral/line/square templates and metrics; Latin square and CSV writers |

## Study mode (lab)
1. Switch to **Study** and enter a participant ID (letters, digits, - and _ only; no other personal data). The Latin-square row comes from the ID.
2. Conditions run in a Williams-balanced 4×4 Latin square over raw / ema / one_euro / steady. The participant only sees "Condition k of 4".
3. Each condition has four tasks: spiral, then line, then square, then free drawing. After each one, press **Done** (or **Redo**). Each trial downloads `trial_<participant>_<condition>_<task>_<n>.csv`.
4. After each condition, the participant rates "How much control did you have?" from 0 to 10. This goes into `summary_<participant>.csv`.
5. **Only with an approved protocol.** Calibrate mm first and keep browser zoom at 100 %.

The CSV has `# ...` metadata lines, then these columns:
`t_ms,x_mm,y_mm,filtered_x_mm,filtered_y_mm,pressure,condition,task,participant,trial,synthetic_tremor_hz,synthetic_tremor_mm`.

## Tremor pen (lab, Chrome/Edge)
- **Connect** plots the pen's accelerometer and gyro.
- **"Shake the real pen"** sends `T,<Hz>,<mm>,<0|1>` with the simulated-tremor settings, refreshes every 5 s, and pauses the software tremor.
- **Arm length** sends `L,<mm>`.
- **Truth meter** shows three readings, saved with "Record this row" → CSV:
  - what the pen was asked to do (from its `C` lines);
  - what its gyro measured (zero-phase 1.5 Hz high-pass, integrated to an angle, then × arm length);
  - what Steady detected from the screen.

Protocol: `docs/04-architecture-spec.md`. Hardware: `hardware/README.md`.

`window.__steadyDraw`, `window.__steady`, `window.__steadyPen`, `window.__steadyCheckin`, `window.__steadyTrace` and
the `__testT` event property exist only for automated checks.
