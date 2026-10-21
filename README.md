# Steady web app

Static, dependency-free web app (vanilla HTML + ES modules). No build step, no network access, nothing leaves the browser.

## Pages
- `index.html` — start page linking the two below.
- **`draw.html` — the drawing app** (what users and judges see): full-screen paper, Steady on/off switch, brush/eraser, 10 colours, 4 sizes, pen pressure, undo/redo, two-tap clear (undoable), save PNG, palm rejection after a pen is used, keyboard shortcuts (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, Cmd/Ctrl+S, B, E, S, [ ]). A **Demo** panel adds simulated tremor (a list of tremor-type buttons: Healthy, ET mild, ET moderate, ET severe, Parkinson's rest; the chosen type is remembered, the switch is never restored as on) and can show the raw shaky line in grey. A **Smoothing** button (Off / Smooth (default) / Extra smooth) settles each finished brush stroke after pen-up (`js/settle.js`, port of `steady/settle.py`, parity vs `shared/test_vectors/settle.json`); its strength follows the tremor Steady detected. Demo tremor is re-seeded on every page load. Files: `js/draw.js`, `css/draw.css`.
- **`lab.html` — the testing & study bench** (formerly `index.html`): filter comparison, synthetic tremor, calibration, study mode with CSV export, Web Serial pen link. Files: `js/main.js`, `css/style.css`.
- Both pages use the **same** `js/filters.js`, so study results apply to the drawing app.

Drawing-app design rules (keep them when editing): canvas first, tools fade while drawing; every target >= 48 px with >= 8 px gaps; steppers instead of sliders; state shown in words, not colour only; one accent colour (green = Steady on); system font; no gradients, glows, glass panels or decorative icons. Drawing-app preferences (not drawings) are kept in `localStorage`; simulated tremor is never restored as "on". `window.__steadyDraw` and the `__testT` event property exist only for automated checks.

## Run
```
cd software
python3 -m http.server 8000      # then open http://localhost:8000/app/ in Chrome or Edge
```
Chrome/Edge are needed only for the optional Web Serial pen link (`localhost` counts as a secure origin). The drawing/filter/study features work in any modern browser.

## Tests
```
node software/app/tests/filters.test.mjs
```
Sanity tests (every filter, FFT, v1 tracker, Filter2D/stroke semantics) plus parity with the Python reference vectors in `software/shared/test_vectors/`: `steady_kalman.json` (steady_v1, ema, one_euro; tol 1e-6, in practice ~1e-14) and `steady_v2_kalman.json` (steady = SteadyV2: output, tremor_hz and mixer weights, tol 1e-9, in practice ~2e-11, includes `start_stroke()` and NaN samples). It also times SteadyV2 x 2 axes (must stay < 0.3 ms/sample; measured ~0.04 ms in Chrome). Under `node` the vectors are read from disk; if a file is missing a SKIP line is printed.
Without `node`, run them in a browser: serve the `software/` directory so `../../shared` is reachable:
```
cd software && python3 -m http.server 8137      # any free port
```
open `http://localhost:8137/app/lab.html`, then in the console: `(await import('/app/tests/filters.test.mjs')).runTests()` (returns the result list; `.parity` holds max abs errors, `.perf` the timing).

## Filters
- `raw`, `ema` (fc 2 Hz), `one_euro` (1.0/0.007/1.0).
- `steady` = **SteadyV3** (since 2026-10-20): SteadyV2 below, applied only as far as clear tremor is detected (gate 0.1→0.3 mm), then a 10 Hz EMA; exact port of `SteadyV3` in `software/core/steady/filters.py`, parity vs `shared/test_vectors/steady_v3_kalman.json` (~1.5e-11). `steady_v2` = the ungated filter (free play only).
- SteadyV2 (exact port of `SteadyV2`/`SteadyBank` in `software/core/steady/filters.py`): 4 oscillator-bank Kalman models (q_i = 1e3, 5e3, 25e3, 125e3; oscillators 3-12 Hz at 0.5 Hz, K = 19, 40 states) mixed by a leaky likelihood window. No frequency tracker. Block-structured `F P F^T` (O(n^2)). One independent instance per axis (`Filter2D`). Read-outs: `tremor_hz` (argmax of the weight-mixed oscillator activity with parabolic refinement), `tremor_conf` (share within +-1 Hz of the peak), `tremor_amp_mm`. The page sums x and y activity for f0/conf and shows the per-axis amplitude.
- `steady_v1` = the old Kalman + FFT-tracker filter, kept for the v1 parity vector and selectable in free play only. Study conditions (`FILTER_NAMES`, `study.js`) are raw/ema/one_euro/steady.

## Stroke handling
Tremor does not stop when the pen lifts, so the filter must not forget it on every stroke. `pointerdown` calls `filter.startStroke()` (= `start_stroke()` in Python): SteadyV2 keeps its oscillator state and restarts the intended-motion state diffusely at the next sample. For raw/ema/one_euro/steady_v1 `startStroke()` is a full reset (they have no persistent state worth keeping). A new filter instance (= forgotten tremor state) is created only when the user changes the filter, starts a new study session/participant, or a new study condition starts. In study mode there is one filter per condition and `startStroke()` is called at each task start and each stroke.

## Files
- `js/settle.js` ink settling (zero-phase smoothing of finished strokes; `settle`, `adaptiveParams`, `adaptiveSettle`).
- `js/tremor.js` realistic synthetic tremor (irregular since 2026-10-20: fast amplitude changes, frequency wander, wandering axis) (port of `software/core/steady/tremor_models.py`; `PRESETS`, `PRESET_ORDER`, `makeTremor(key, overrides, seed)`, `SpeedEstimator`). `js/compare.js` the compare-filters overlay maths and view.
- `js/filters.js` filters above, `TremorTracker` (port of `tremor_estimator.py`, used by steady_v1 and as the read-out for ema/one_euro), `Filter2D`.
- `js/tasks.js` spiral/line/square templates and quick metrics. `js/study.js` Latin square + CSV writers. `js/serial.js` Web Serial. `js/main.js` UI.

## Using it
- **Free play**: pick a filter; the grey trace is the raw (tremor-injected) pointer path, the ink trace is the filtered output. Readouts show estimated tremor f0, confidence, mode (steady: tremor amplitude), an estimated lag (component of raw-minus-filtered along the filtered velocity, only when moving faster than 20 mm/s; includes tremor noise, so treat as approximate) and the pointer event rate.
- **Synthetic tremor**: toggle + preset dropdown (healthy, ET mild/moderate/severe, Parkinson's rest, old sine; default ET moderate) + editable frequency (3-12 Hz) and peak amplitude (0-10 mm). Choosing a preset fills both numbers; editing them shows "Custom (based on X)". The generator is the realistic model of `tremor_models.py`: frequency drifts (Ornstein-Uhlenbeck), amplitude waxes and wanes, the motion is an ellipse with a harmonic, essential tremor grows with drawing speed and Parkinson's rest tremor is suppressed while moving and re-emerges after a pause. Speed = magnitude of the pointer velocity of the UN-tremored path (EMA 80 ms). One generator runs continuously in time (not restarted per stroke) and is added to x and y before filtering. Frequency and amplitude go into every CSV row and the preset into a `# tremor_preset=` line (`none`, a preset key, or `custom(based_on=key)`); the CSV row format is unchanged. Parameters are plausible values from the literature, not patient measurements.
- **Compare filters on this drawing** (free play, button disabled until a stroke exists): every free-play stroke's raw input (after tremor injection, before filtering) is recorded; the overlay re-runs a fresh raw / ema / one_euro / steady filter over the identical samples (one instance, `startStroke()` at each stroke) in a 2x2 grid at one scale. Under each panel: **wiggle** = RMS distance (mm) of the output from its own centred 0.33 s moving average; **lag vs raw** = time shift 0-200 ms (2 ms steps) of the raw path that minimises mean squared difference to the filtered path (raw = 0 by definition). Lag estimates are approximate (the raw path contains the tremor). Esc or Close leaves it.
- **Calibration**: default 0.2646 mm per CSS px (96 px/in). "Calibrate with card" shows a 200 px bar; measure it with a ruler and enter mm. Do this on the study display (and keep browser zoom at 100%).

## Study protocol
1. Switch to **Study**, enter participant ID (letters/digits/-/_ only; no other personal data is collected), optionally pick the Latin-square row (default: derived from the ID's trailing number, else hash). Set tremor injection first if using Phase 1 synthetic tremor and keep it fixed for the whole session.
2. Condition order is a Williams-balanced 4x4 Latin square over raw/ema/one_euro/steady (index rows `[0,1,3,2] [1,2,0,3] [2,3,1,0] [3,0,2,1]` into raw,ema,one_euro,steady). The participant sees only "Condition k of 4" (single-blind); raw trace hidden unless ticked.
3. Per condition: spiral (3 turns, trace faint template) -> line -> square -> free draw, repeated `reps` times. Press **Done** after each task (**Redo** discards). Quick metrics appear (spiral radial error for filtered and raw, line straightness, path-length ratio). Each trial downloads `trial_<participant>_<condition>_<task>_<n>.csv` (auto-download can be turned off; use "Download all trial CSVs" later).
4. After each condition, the participant rates "how much control did you have" 0-10; this is stored in the summary CSV (`summary_<participant>.csv`) with mean spiral RMS error.
5. Sequence/preference questions are not in the app; ask verbally and record on paper.

CSV: `# ...` metadata lines, then `t_ms,x_mm,y_mm,filtered_x_mm,filtered_y_mm,pressure,condition,task,participant,trial,synthetic_tremor_hz,synthetic_tremor_mm`. `t_ms` is relative to trial start; x/y are mm from the canvas top-left (template centre is in `# template=`); `# stroke_starts_ms=` lists pen-down times (each pen-down calls `startStroke()`; the row format has no stroke column).

## Pen (Web Serial)
Connect (921600 baud) to see accel/gyro plotted live from `S,...` lines, `Ping` sends `P`, and "drive motor with synthetic tremor settings" sends `M,<Hz>,<pct>` (amplitude 0-4 mm maps to 0-100 %, larger values clamp to 100 %; `M,0,0` on stop). Do not enable both software injection and the motor for a trial unless intended. Unsupported browsers just get the button disabled.
