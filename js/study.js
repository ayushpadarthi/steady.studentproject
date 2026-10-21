// Study-mode helpers: counterbalancing and CSV builders (format per docs/04-architecture-spec.md).

export const CONDITIONS = ['raw', 'ema', 'one_euro', 'steady'];

// Williams (balanced) 4x4 Latin square: each condition appears once per row and column and
// follows every other condition equally often (first-order carry-over balanced).
export const LATIN_SQUARE = [
  [0, 1, 3, 2],
  [1, 2, 0, 3],
  [2, 3, 1, 0],
  [3, 0, 2, 1],
];

export function sanitizeId(s) { return String(s || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40); }

/** Row index from participant ID: trailing number (P07 -> row 6 mod 4) else a string hash. */
export function rowForParticipant(id) {
  const m = /(\d+)\s*$/.exec(id);
  if (m) return (parseInt(m[1], 10) - 1 + 4000000) % 4;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 4;
}
export const orderForRow = (row) => LATIN_SQUARE[row].map((i) => CONDITIONS[i]);

const f = (v, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : '');

export const TRIAL_HEADER = 't_ms,x_mm,y_mm,filtered_x_mm,filtered_y_mm,pressure,condition,task,participant,trial,synthetic_tremor_hz,synthetic_tremor_mm';

export function trialFilename(t) { return `trial_${t.participant}_${t.condition}_${t.task}_${t.n}.csv`; }

/** trial: {participant, condition, task, n, samples:[{t,x,y,fx,fy,p}], strokeStartsMs, meta:{...}} */
export function trialCsv(trial) {
  const m = trial.meta;
  const lines = [
    '# steady_trial v1',
    `# participant=${trial.participant}`,
    `# condition=${trial.condition}`,
    `# task=${trial.task}`,
    `# trial=${trial.n}`,
    `# created_utc=${m.created}`,
    `# mm_per_px=${m.mmPerPx}`,
    `# synthetic_tremor_hz=${m.synHz}`,
    `# synthetic_tremor_mm=${m.synMm}`,
    `# tremor_preset=${m.tremorPreset ?? 'none'}`,
    `# latin_square_row=${m.row ?? ''}`,
    `# condition_position=${m.position ?? ''}`,
    `# stroke_starts_ms=${trial.strokeStartsMs.map((v) => f(v, 3)).join(';')}`,
    `# template=${m.template ?? ''}`,
    '# t_ms is relative to the first sample of the trial; units are millimetres',
    TRIAL_HEADER,
  ];
  for (const s of trial.samples) {
    lines.push([f(s.t, 3), f(s.x), f(s.y), f(s.fx), f(s.fy), f(s.p, 3), trial.condition, trial.task,
      trial.participant, trial.n, m.synHz, m.synMm].join(','));
  }
  return lines.join('\n') + '\n';
}

export const SUMMARY_HEADER = 'participant,latin_square_row,position,condition,control_rating_0_10,n_trials,mean_spiral_rms_mm_filtered,mean_spiral_rms_mm_raw,mean_spiral_mean_abs_mm_filtered,synthetic_tremor_hz,synthetic_tremor_mm,saved_utc';

export function summaryCsv(rows) {
  const lines = ['# steady_summary v1', SUMMARY_HEADER];
  for (const r of rows) {
    lines.push([r.participant, r.row, r.position, r.condition, r.rating, r.nTrials, f(r.spiralRmsF), f(r.spiralRmsR),
      f(r.spiralMeanF), r.synHz, r.synMm, r.saved].join(','));
  }
  return lines.join('\n') + '\n';
}

export function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
