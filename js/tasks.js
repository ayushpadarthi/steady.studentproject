// Task templates (all geometry in mm, origin = canvas centre) and quick on-screen metrics.

export const TASKS = ['spiral', 'line', 'square', 'free'];
export const TASK_HELP = {
  spiral: 'Trace the faint spiral from the centre outwards (3 turns).',
  line: 'Draw a straight line along the guide, left to right.',
  square: 'Draw the square, starting at any corner. Keep corners sharp.',
  free: 'Draw anything you like (e.g. a simple sketch).',
};

/** Template for a task given the drawable area in mm. Returns {polyline, spiral?}. */
export function makeTemplate(task, wMm, hMm) {
  const m = Math.min(wMm, hMm);
  if (task === 'spiral') {
    const turns = 3, r0 = 3;
    const maxR = Math.max(20, Math.min(55, m / 2 - 6)); // never degenerate on tiny canvases
    const b = (maxR - r0) / (turns * 2 * Math.PI);
    const pts = [];
    const n = 720;
    for (let i = 0; i <= n; i++) {
      const th = (i / n) * turns * 2 * Math.PI;
      const r = r0 + b * th;
      pts.push([r * Math.cos(th), r * Math.sin(th)]);
    }
    return { polyline: pts, spiral: { cx: 0, cy: 0, r0, b, turns } };
  }
  if (task === 'line') {
    const h = Math.max(10, Math.min(45, wMm / 2 - 8));
    return { polyline: [[-h, 0], [h, 0]] };
  }
  if (task === 'square') {
    const h = Math.max(10, Math.min(35, m / 2 - 8));
    return { polyline: [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]] };
  }
  return { polyline: [] };
}

/** Signed radial error (mm) of each point against the Archimedean template r = r0 + b*theta. */
export function spiralRadialErrors(points, sp) {
  const out = [];
  for (const [x, y] of points) {
    const dx = x - sp.cx, dy = y - sp.cy;
    const r = Math.hypot(dx, dy);
    let th = Math.atan2(dy, dx);
    if (th < 0) th += 2 * Math.PI;
    let best = Infinity;
    for (let k = 0; k < sp.turns; k++) {
      const rt = sp.r0 + sp.b * (th + 2 * Math.PI * k);
      const e = r - rt;
      if (Math.abs(e) < Math.abs(best)) best = e;
    }
    out.push(best);
  }
  return out;
}

export function errStats(errs) {
  if (!errs.length) return { mean: NaN, rms: NaN };
  let a = 0, s = 0;
  for (const e of errs) { a += Math.abs(e); s += e * e; }
  return { mean: a / errs.length, rms: Math.sqrt(s / errs.length) };
}

/** RMS perpendicular deviation from the best-fit (PCA) line. */
export function lineStraightness(points) {
  const n = points.length;
  if (n < 3) return NaN;
  let mx = 0, my = 0;
  for (const [x, y] of points) { mx += x; my += y; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of points) { const a = x - mx, b = y - my; sxx += a * a; syy += b * b; sxy += a * b; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(th), ny = Math.cos(th);
  let s = 0;
  for (const [x, y] of points) { const d = (x - mx) * nx + (y - my) * ny; s += d * d; }
  return Math.sqrt(s / n);
}

export function pathLength(points) {
  let L = 0;
  for (let i = 1; i < points.length; i++) L += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return L;
}
