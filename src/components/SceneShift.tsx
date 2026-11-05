"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { vertexShader, fragmentShader } from "@/lib/shader";
import { prepDepth } from "@/lib/depthPrep";
import { Mic, Spring2, Tilt } from "@/lib/motion";
import styles from "./SceneShift.module.css";

const DEPTH_MAX_SIDE = 768; // depth model input; the colour texture keeps up to 2048 px
const COLOR_MAX_SIDE = 2048;
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const SAMPLES = [`${BASE}/samples/sample-1.jpg`];

type Mode = 0 | 1 | 2; // naive | ray march | compare
type Stats = { device: string; loadMs: number; inferMs: number[]; prepMs: number; fps: number };

function drawScaled(img: HTMLImageElement | ImageBitmap, maxSide: number) {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.round(img.width * s), h = Math.round(img.height * s);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h);
  return { canvas: c, ctx: g, w, h };
}

// Auto-frame: where is the subject? Plain "nearest pixels" finds the ground or sea at the bottom of
// the frame. So compare each pixel with the median depth of its own row: the ground plane cancels out and
// what stands up from it (a ship, a person) stays. Centroid of the strongest 8% of that, in GL uv (y up), plus the subject's median depth.
function subjectCenter(d: Uint8Array, w: number, h: number) {
  const res = new Int16Array(d.length);
  const row = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    row.set(d.subarray(y * w, (y + 1) * w));
    row.sort();
    const med = row[w >> 1];
    for (let x = 0; x < w; x++) res[y * w + x] = d[y * w + x] - med;
  }
  // Framing elements (a wall, a door frame) also stand out but run into the image border; subjects sit
  // nearer the middle. So weight the residual by a soft horizontal centre bias before picking the top 8%.
  const score = new Float32Array(d.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const cx = x / w - 0.5;
    score[y * w + x] = Math.max(0, res[y * w + x]) * Math.exp(-(cx * cx) / (2 * 0.22 * 0.22));
  }
  const sorted = Float32Array.from(score).sort();
  const cut = sorted[Math.floor(sorted.length * 0.92)];
  if (cut < 4) return null; // nothing stands out: keep the centre and the default focus
  let sx = 0, sy = 0, n = 0;
  const dh = new Uint32Array(256);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (score[y * w + x] >= cut) { sx += x; sy += y; n++; dh[d[y * w + x]]++; }
  if (!n) return null;
  let k = 0, med = 0;
  while (med < 255 && k + dh[med] < n / 2) k += dh[med++];
  // auto-focus: the subject's own depth stays still, the world moves around it
  return { x: sx / n / w, y: 1 - sy / n / h, depth: med / 255 };
}

function depthTexture(data: Uint8Array, w: number, h: number) {
  const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  t.flipY = true; // canvas rows run top-down, GL uv runs bottom-up
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export default function SceneShift() {
  const mount = useRef<HTMLDivElement>(null);
  const uniforms = useRef<Record<string, THREE.IUniform> | null>(null);
  const worker = useRef<Worker | null>(null);
  const imgAspect = useRef(1);
  const intro = useRef(1); // 0 -> 1 while the "pick up" move plays
  const pointer = useRef({ x: 0, y: 0, last: -1e9 });
  const mic = useRef(new Mic());
  const tilt = useRef(new Tilt());
  const stats = useRef<Stats>({ device: "", loadMs: 0, inferMs: [], prepMs: 0, fps: 0 });
  const rawDepth = useRef<{ data: Uint8Array; w: number; h: number } | null>(null);
  const reqId = useRef(0);

  const [query] = useState(() => new URLSearchParams(location.search));
  const [status, setStatus] = useState("Loading depth model…");
  const [hud, setHud] = useState("");
  const [mode, setMode] = useState<Mode>(() => (query.get("mode") !== null ? (Number(query.get("mode")) as Mode) : 2));
  const [split, setSplit] = useState(0.5);
  const [strength, setStrength] = useState(0.035);
  const [focus, setFocus] = useState(0.3);
  const [view, setView] = useState(0);
  const [cleanup, setCleanup] = useState(true);
  const [micOn, setMicOn] = useState(false);
  const [tiltOn, setTiltOn] = useState(false);
  const [ui, setUi] = useState(() => query.get("ui") !== "0");
  const [ready, setReady] = useState(false);
  // wallpapers live on phones: show a phone-shaped frame on wide screens
  const [phone, setPhone] = useState(() => query.get("frame") !== "full" && window.innerWidth >= 700);
  // the animation loop reads these without re-creating the scene
  const strengthRef = useRef(strength);
  const cleanupRef = useRef(cleanup);

  // --- three.js setup + render loop -------------------------------------------------------------
  useEffect(() => {
    const el = mount.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const blank = depthTexture(new Uint8Array([0]), 1, 1);
    const u: Record<string, THREE.IUniform> = {
      uImage: { value: null },
      uDepthRaw: { value: blank },
      uDepthMarch: { value: blank },
      uOffset: { value: new THREE.Vector2() },
      uFocus: { value: 0.3 },
      uCover: { value: new THREE.Vector2(1, 1) },
      uZoom: { value: 1.07 },
      uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uSplit: { value: 0.5 },
      uMode: { value: 2 },
      uView: { value: 0 },
      uExposure: { value: 1 },
      uHasImage: { value: 0 },
      uFill: { value: 0 }, // wall fill: measured, no gain on top of clean-up (see BUILD_LOG); ?fill=1 to try
      uWall: { value: 0.1 },
    };
    uniforms.current = u;
    const mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader, fragmentShader });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false);
      const as = w / h, ai = imgAspect.current;
      u.uCover.value.set(as > ai ? 1 : as / ai, as > ai ? ai / as : 1);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    (window as unknown as { __resize: () => void }).__resize = resize;

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      pointer.current = {
        x: ((e.clientX - r.left) / r.width) * 2 - 1,
        y: -(((e.clientY - r.top) / r.height) * 2 - 1),
        last: performance.now(),
      };
    };
    el.addEventListener("pointermove", onMove);

    // "They bloom as you pick up your phone": replay the intro whenever the page becomes visible again.
    const onVis = () => { if (document.visibilityState === "visible") intro.current = 0; };
    document.addEventListener("visibilitychange", onVis);

    const spring = new Spring2(6);
    let prev = performance.now(), raf = 0, fpsAcc = 0, fpsN = 0, fpsT = 0;
    const ease = (x: number) => 1 - Math.pow(1 - x, 3);
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const t = now / 1000;
      mic.current.update(dt);

      let tx = 0, ty = 0;
      if (now - pointer.current.last < 2500) { tx = pointer.current.x; ty = pointer.current.y; }
      else if (tilt.current.on) { tx = tilt.current.x; ty = tilt.current.y; }
      else { tx = Math.sin(t * 0.31) * 0.55; ty = Math.sin(t * 0.23 + 1.3) * 0.35; } // idle drift
      const m = mic.current.level; // breeze: the scene sways with sound
      tx += (Math.sin(t * 1.9) * 0.8 + Math.sin(t * 4.3) * 0.25) * m;
      ty += Math.sin(t * 2.6 + 0.7) * 0.35 * m;

      intro.current = Math.min(1, intro.current + dt / 1.8);
      const k = ease(intro.current);
      ty += (1 - k) * 0.9;
      spring.step(tx, ty, dt);

      u.uOffset.value.set(spring.x * strengthRef.current, spring.y * strengthRef.current);
      u.uZoom.value = 1.07 + (1 - k) * 0.12;
      u.uExposure.value = 0.35 + 0.65 * k;
      renderer.render(scene, cam);

      fpsAcc += dt; fpsN++; fpsT += dt;
      if (fpsT > 0.5) { stats.current.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; fpsT = 0; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVis);
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => { strengthRef.current = strength; }, [strength]);
  useEffect(() => {
    const u = uniforms.current; if (!u) return;
    u.uMode.value = mode; u.uSplit.value = split; u.uFocus.value = focus; u.uView.value = view;
  }, [mode, split, focus, view]);

  // matte clean-up on/off: rebuild the ray-march depth texture from the raw depth
  const applyDepth = useCallback((clean: boolean) => {
    const u = uniforms.current, r = rawDepth.current;
    if (!u || !r) return;
    const t0 = performance.now();
    const data = clean ? prepDepth(r.data, r.w, r.h, 4, 2) : r.data;
    stats.current.prepMs = performance.now() - t0;
    (u.uDepthMarch.value as THREE.Texture)?.dispose?.();
    u.uDepthMarch.value = depthTexture(new Uint8Array(data), r.w, r.h);
  }, []);
  useEffect(() => { applyDepth(cleanup); }, [cleanup, applyDepth]);

  // --- depth worker ----------------------------------------------------------------------------
  useEffect(() => {
    const w = new Worker(new URL("../workers/depth.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress" && m.p?.status === "progress" && m.p.file?.endsWith(".onnx")) {
        setStatus(`Downloading depth model… ${Math.round(m.p.progress)}%`);
      } else if (m.type === "ready") {
        stats.current.device = m.device; stats.current.loadMs = m.loadMs;
        setReady(true);
        setStatus(`Depth model ready (${m.device}). Drop a photo, or pick a sample.`);
      } else if (m.type === "log") {
        console.warn("[SceneShift]", m.msg);
      } else if (m.type === "error") {
        setStatus(`Error: ${m.msg}`);
      } else if (m.type === "depth") {
        if (m.id !== reqId.current) return; // a newer photo was dropped meanwhile
        stats.current.inferMs.push(m.ms);
        const data = new Uint8Array(m.buffer);
        rawDepth.current = { data, w: m.width, h: m.height };
        const u = uniforms.current!;
        (u.uDepthRaw.value as THREE.Texture)?.dispose?.();
        u.uDepthRaw.value = depthTexture(new Uint8Array(data), m.width, m.height);
        applyDepth(cleanupRef.current);
        const c = subjectCenter(data, m.width, m.height);
        u.uCenter.value.set(c?.x ?? 0.5, c?.y ?? 0.5);
        if (c) setFocus(Math.round(c.depth * 100) / 100);
        u.uHasImage.value = 1;
        intro.current = 0;
        setStatus(`Depth in ${Math.round(m.ms)} ms on ${m.device}.`);
        console.log("[SceneShift] depth", JSON.stringify({ ms: m.ms, device: m.device, w: m.width, h: m.height }));
      }
    };
    const prefer = new URLSearchParams(location.search).get("backend") === "wasm" ? "wasm" : "webgpu";
    w.postMessage({ type: "load", prefer });
    return () => w.terminate();
  }, [applyDepth]);
  useEffect(() => { cleanupRef.current = cleanup; }, [cleanup]);

  // --- photo in --------------------------------------------------------------------------------
  const loadImage = useCallback(async (src: string | File) => {
    const url = typeof src === "string" ? src : URL.createObjectURL(src);
    const img = new Image();
    img.src = url;
    await img.decode();
    imgAspect.current = img.width / img.height;
    (window as unknown as { __resize: () => void }).__resize();

    const col = drawScaled(img, COLOR_MAX_SIDE);
    const tex = new THREE.CanvasTexture(col.canvas);
    // no colour space tag: the custom shader passes 8-bit values straight through (sRGB in, sRGB out)
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    const u = uniforms.current!;
    (u.uImage.value as THREE.Texture | null)?.dispose();
    u.uImage.value = tex;

    const dep = drawScaled(img, DEPTH_MAX_SIDE);
    const px = dep.ctx.getImageData(0, 0, dep.w, dep.h);
    const id = ++reqId.current;
    setStatus("Estimating depth…");
    worker.current!.postMessage(
      { type: "depth", id, width: dep.w, height: dep.h, buffer: px.data.buffer },
      [px.data.buffer],
    );
  }, []);

  useEffect(() => {
    const api = {
      load: (url: string) => loadImage(url),
      stats: () => ({ ...stats.current }),
      // records the WebGL canvas for the README GIFs: await __sceneshift.record(6, "name")
      record: (seconds: number, name: string) => new Promise<void>((done) => {
        const canvas = mount.current!.querySelector("canvas")!;
        const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm;codecs=vp9", videoBitsPerSecond: 12e6 });
        const parts: Blob[] = [];
        rec.ondataavailable = (e) => parts.push(e.data);
        rec.onstop = () => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob(parts, { type: "video/webm" }));
          a.download = `${name}.webm`; a.click(); done();
        };
        rec.start(); setTimeout(() => rec.stop(), seconds * 1000);
      }),
      set: (o: { split?: number; strength?: number; focus?: number; mode?: Mode; view?: number; ui?: boolean }) => {
        if (o.split !== undefined) setSplit(o.split);
        if (o.strength !== undefined) setStrength(o.strength);
        if (o.focus !== undefined) setFocus(o.focus);
        if (o.mode !== undefined) setMode(o.mode);
        if (o.view !== undefined) setView(o.view);
        if (o.ui !== undefined) setUi(o.ui);
      },
    };
    (window as unknown as { __sceneshift: typeof api }).__sceneshift = api;
    if (query.get("fill") === "1" && uniforms.current) uniforms.current.uFill.value = 1;
  }, [loadImage, query]);

  useEffect(() => {
    const id = setInterval(() => {
      const s = stats.current;
      const last = s.inferMs.at(-1);
      setHud(`${s.device || "…"} · depth ${last ? Math.round(last) + " ms" : "–"} · ${Math.round(s.fps)} fps`);
    }, 500);
    const onKey = (e: KeyboardEvent) => { if (e.key === "h" || e.key === "H") setUi((v) => !v); };
    window.addEventListener("keydown", onKey);
    return () => { clearInterval(id); window.removeEventListener("keydown", onKey); };
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith("image/")) loadImage(f);
  };

  const toggleMic = async () => {
    if (mic.current.on) { mic.current.stop(); setMicOn(false); return; }
    try { await mic.current.start(); setMicOn(true); } catch { setStatus("Microphone not allowed."); }
  };
  const toggleTilt = async () => {
    if (tilt.current.on) { tilt.current.stop(); setTiltOn(false); return; }
    setTiltOn(await tilt.current.start());
  };

  return (
    <div className={styles.root} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className={phone ? styles.phone : styles.full}>
        <div ref={mount} className={styles.stage} />
        {mode === 2 && ui && (
          <div className={styles.labels}>
            <span style={{ left: `calc(${split * 100}% - 6px)`, transform: "translateX(-100%)" }}>naive</span>
            <span style={{ left: `calc(${split * 100}% + 6px)` }}>ray march{cleanup ? " + clean-up" : ""}</span>
          </div>
        )}
      </div>
      {ui && (
        <aside className={styles.panel}>
          <h1>SceneShift</h1>
          <p className={styles.sub}>Any photo becomes a living 2.5D scene. Depth runs in your browser.</p>
          <p className={styles.status}>{status}</p>
          <div className={styles.row}>
            <label className={styles.button}>
              Your photo
              <input type="file" accept="image/*" hidden disabled={!ready}
                onChange={(e) => e.target.files?.[0] && loadImage(e.target.files[0])} />
            </label>
            {SAMPLES.map((s, i) => (
              <button key={s} className={styles.button} disabled={!ready} onClick={() => loadImage(s)}>
                {SAMPLES.length > 1 ? `Sample ${i + 1}` : "Sample photo"}
              </button>
            ))}
          </div>
          <div className={styles.row}>
            {(["Naive", "Ray march", "Compare"] as const).map((n, i) => (
              <button key={n} className={`${styles.button} ${mode === i ? styles.on : ""}`}
                onClick={() => setMode(i as Mode)}>{n}</button>
            ))}
          </div>
          {mode === 2 && (
            <label className={styles.slider}>Split
              <input type="range" min={0.05} max={0.95} step={0.005} value={split}
                onChange={(e) => setSplit(+e.target.value)} />
            </label>
          )}
          <label className={styles.slider}>Strength
            <input type="range" min={0} max={0.09} step={0.001} value={strength}
              onChange={(e) => setStrength(+e.target.value)} />
          </label>
          <label className={styles.slider}>Focus depth
            <input type="range" min={0} max={1} step={0.01} value={focus}
              onChange={(e) => setFocus(+e.target.value)} />
          </label>
          <div className={styles.row}>
            <button className={`${styles.button} ${view === 1 ? styles.on : ""}`}
              onClick={() => setView(view ? 0 : 1)}>Depth pass</button>
            <button className={`${styles.button} ${cleanup ? styles.on : ""}`}
              onClick={() => setCleanup(!cleanup)}>Matte clean-up</button>
            <button className={`${styles.button} ${phone ? styles.on : ""}`}
              onClick={() => setPhone(!phone)}>Phone frame</button>
          </div>
          <div className={styles.row}>
            <button className={`${styles.button} ${micOn ? styles.on : ""}`} onClick={toggleMic}>
              Breeze (mic)
            </button>
            <button className={`${styles.button} ${tiltOn ? styles.on : ""}`} onClick={toggleTilt}>
              Tilt (phone)
            </button>
          </div>
          <p className={styles.hud}>{hud}</p>
          <p className={styles.foot}>H hides this panel · an outside experiment, not affiliated with Google or Feels Like</p>
        </aside>
      )}
    </div>
  );
}
