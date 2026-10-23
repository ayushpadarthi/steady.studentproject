// Optional Web Serial link to the Steady pen (921600 baud, line-based ASCII; see spec).
// Everything degrades gracefully when navigator.serial is missing (Firefox/Safari, http origins).

export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

export class SteadySerial {
  constructor() {
    this.port = null; this.reader = null; this.writer = null; this.connected = false;
    this.onSample = () => {}; this.onCommand = () => {}; this.onLine = () => {}; this.onStatus = () => {};
    this.nSamples = 0;
  }
  async connect(baudRate = 921600) {
    if (!serialSupported()) throw new Error('Web Serial not supported in this browser');
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate });
    this.connected = true;
    this.writer = this.port.writable.getWriter();
    this.onStatus('connected');
    this._readLoop();
  }
  async _readLoop() {
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (this.port.readable && this.connected) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              this._line(buf.slice(0, i).trim());
              buf = buf.slice(i + 1);
            }
            if (buf.length > 4096) buf = '';
          }
        } finally { this.reader.releaseLock(); }
      }
    } catch (e) { this.onStatus('error: ' + e.message); }
    if (this.connected) await this.disconnect();
  }
  _line(s) {
    if (!s) return;
    if (s[0] === 'S') {
      const p = s.split(',');
      if (p.length === 8) {
        const v = p.slice(1).map(Number);
        if (v.every(Number.isFinite)) {
          this.nSamples++;
          this.onSample({ t_us: v[0], ax: v[1], ay: v[2], az: v[3], gx: v[4], gy: v[5], gz: v[6] });
        }
      }
      return;
    }
    if (s[0] === 'C') { // v2 pen: commanded tip offset "C,<t_us>,<mm>"
      const p = s.split(',');
      if (p.length === 3) { const t = Number(p[1]), mm = Number(p[2]); if (Number.isFinite(t) && Number.isFinite(mm)) this.onCommand({ t_us: t, mm }); }
      return;
    }
    this.onLine(s); // '# ...' comments, '# pong', etc.
  }
  async _send(str) {
    if (!this.writer) return false;
    await this.writer.write(new TextEncoder().encode(str));
    return true;
  }
  ping() { return this._send('P\n'); }
  /** v2 servo pen: shake at f0 Hz with peak tip offset ampMm; irregular = realistic (drifting) tremor. */
  shake(f0, ampMm, irregular) {
    const f = Math.max(0, +f0 || 0), a = Math.max(0, +ampMm || 0);
    return this._send(`T,${f.toFixed(2)},${a.toFixed(2)},${irregular ? 1 : 0}\n`);
  }
  stopShake() { return this._send('X\n'); }
  /** Shaft-to-tip distance of the servo pen, mm (10-120). */
  setArm(mm) { return this._send(`L,${(+mm).toFixed(1)}\n`); }
  /** v1 (motor) pen: drive the tremor-injector motor. freq_hz > 0, amp_pct 0-100. */
  setTremor(freq, ampPct) {
    const f = Math.max(0, +freq || 0), a = Math.min(100, Math.max(0, +ampPct || 0));
    return this._send(`M,${f.toFixed(2)},${a.toFixed(1)}\n`);
  }
  stopTremor() { return this._send('M,0,0\n'); }
  async disconnect() {
    this.connected = false;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
    this.port = this.reader = this.writer = null;
    this.onStatus('disconnected');
  }
}

/** Rolling 3-trace plot of IMU samples on a <canvas>. group: 'accel' | 'gyro'. */
export class ImuPlot {
  constructor(canvas, n = 600) {
    this.c = canvas; this.n = n; this.group = 'accel';
    this.buf = { accel: [[], [], []], gyro: [[], [], []] };
  }
  add(s) {
    const push = (arr, v) => { arr.push(v); if (arr.length > this.n) arr.shift(); };
    [s.ax, s.ay, s.az].forEach((v, i) => push(this.buf.accel[i], v));
    [s.gx, s.gy, s.gz].forEach((v, i) => push(this.buf.gyro[i], v));
  }
  draw() {
    const c = this.c, g = c.getContext('2d');
    const w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    const tr = this.buf[this.group];
    let lo = Infinity, hi = -Infinity;
    for (const a of tr) for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) return;
    if (hi - lo < 1e-3) { hi += 0.5; lo -= 0.5; }
    const cols = ['#c0392b', '#2e8b57', '#2f6fd0'];
    tr.forEach((a, k) => {
      g.strokeStyle = cols[k]; g.lineWidth = 1.25; g.beginPath();
      a.forEach((v, i) => {
        const x = (i / (this.n - 1)) * w, y = h - ((v - lo) / (hi - lo)) * (h - 8) - 4;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.stroke();
    });
    g.fillStyle = '#888'; g.font = '10px sans-serif';
    g.fillText(`${hi.toFixed(2)}`, 2, 10); g.fillText(`${lo.toFixed(2)}`, 2, h - 2);
  }
}
