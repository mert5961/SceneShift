// Inputs that drive the wallpaper: pointer, phone tilt, microphone "breeze", idle drift.
// Every input writes a target; a critically damped spring follows it so nothing ever snaps.

export class Spring2 {
  x = 0; y = 0; vx = 0; vy = 0;
  constructor(public omega = 7) {}
  step(tx: number, ty: number, dt: number) {
    const w = this.omega, k = w * w, c = 2 * w;
    this.vx += (k * (tx - this.x) - c * this.vx) * dt;
    this.vy += (k * (ty - this.y) - c * this.vy) * dt;
    this.x += this.vx * dt; this.y += this.vy * dt;
  }
}

export class Mic {
  private analyser: AnalyserNode | null = null;
  private buf = new Float32Array(1024);
  private stream: MediaStream | null = null;
  level = 0; // smoothed loudness, about 0..1
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
  }
  stop() { this.stream?.getTracks().forEach((t) => t.stop()); this.analyser = null; this.level = 0; }
  get on() { return this.analyser !== null; }
  update(dt: number) {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    const rms = Math.min(1, Math.sqrt(s / this.buf.length) * 8);
    // fast attack, slow release: a gust picks the scene up, then it settles
    const k = rms > this.level ? 1 - Math.exp(-dt * 12) : 1 - Math.exp(-dt * 1.5);
    this.level += (rms - this.level) * k;
  }
}

export class Tilt {
  x = 0; y = 0; on = false;
  private base: { b: number; g: number } | null = null;
  private handler = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null) return;
    if (!this.base) this.base = { b: e.beta, g: e.gamma };
    this.x = Math.max(-1, Math.min(1, (e.gamma - this.base.g) / 20));
    this.y = Math.max(-1, Math.min(1, (e.beta - this.base.b) / 20));
  };
  async start() {
    const D = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof D.requestPermission === "function" && (await D.requestPermission()) !== "granted") return false;
    window.addEventListener("deviceorientation", this.handler);
    this.on = true; this.base = null;
    return true;
  }
  stop() { window.removeEventListener("deviceorientation", this.handler); this.on = false; }
}
