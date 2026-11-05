"use client";

// Eval: does the ray march really beat the naive offset, and does the matte clean-up help?
// We can't know the true depth of a real photo, so we build synthetic layered scenes where we do:
// each layer has a known depth, the "true" camera move is drawn by shifting each layer back to front,
// and every method renders the same move through the real shader. Score = PSNR vs that truth,
// over the whole frame and in a 12 px band around depth edges (where the methods differ).

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { vertexShader, fragmentShader } from "@/lib/shader";
import { prepDepth } from "@/lib/depthPrep";

const WALL = Number(new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("wall") ?? 0.1);
const N = 512;            // eval resolution
const BORDER = 40;        // ignore the frame border: every method clamps there the same way
const FOCUS = 0.3;
const STRENGTHS = [0.035, 0.06];
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071]];

type Layer = { depth: number; draw: (g: CanvasRenderingContext2D) => void; fill: (g: CanvasRenderingContext2D) => string | CanvasPattern };
type Scene = { name: string; layers: Layer[] };

function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function pattern(g: CanvasRenderingContext2D, seed: number, base: [number, number, number], kind: "blobs" | "checker" | "stripes") {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const p = c.getContext("2d")!; const r = rng(seed);
  p.fillStyle = `rgb(${base.join(",")})`; p.fillRect(0, 0, 128, 128);
  if (kind === "checker") for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    if ((x + y) % 2) continue; p.fillStyle = `rgba(255,255,255,${0.25 + r() * 0.3})`; p.fillRect(x * 16, y * 16, 16, 16);
  }
  if (kind === "stripes") for (let i = 0; i < 16; i++) { p.fillStyle = `rgba(0,0,0,${0.15 + r() * 0.3})`; p.fillRect(i * 8, 0, 4, 128); }
  if (kind === "blobs") for (let i = 0; i < 40; i++) {
    p.fillStyle = `hsla(${Math.floor(r() * 360)},60%,${40 + r() * 40}%,0.55)`;
    p.beginPath(); p.arc(r() * 128, r() * 128, 4 + r() * 14, 0, Math.PI * 2); p.fill();
  }
  return g.createPattern(c, "repeat")!;
}

const bgRect = (g: CanvasRenderingContext2D) => g.fillRect(-100, -100, N + 200, N + 200);

const SCENES: Scene[] = [
  { name: "portrait (one subject)", layers: [
    { depth: 0.12, draw: bgRect, fill: (g) => pattern(g, 1, [70, 90, 120], "blobs") },
    { depth: 0.8, draw: (g) => { g.beginPath(); g.ellipse(256, 220, 80, 100, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(256, 470, 170, 150, 0, 0, Math.PI * 2); g.fill(); },
      fill: (g) => pattern(g, 2, [190, 140, 110], "checker") },
  ]},
  { name: "rigging (thin lines)", layers: [
    { depth: 0.08, draw: bgRect, fill: (g) => pattern(g, 3, [90, 150, 220], "blobs") },
    { depth: 0.85, draw: (g) => {
        const r = rng(9);
        for (let i = 0; i < 14; i++) { g.save(); g.translate(120 + r() * 300, 0); g.rotate(-0.5 + r()); g.fillRect(-1.5, -50, 3, 600); g.restore(); }
        g.fillRect(300, 380, 220, 140);
      }, fill: (g) => pattern(g, 4, [40, 30, 25], "stripes") },
  ]},
  { name: "three layers", layers: [
    { depth: 0.1, draw: bgRect, fill: (g) => pattern(g, 5, [120, 110, 90], "blobs") },
    { depth: 0.45, draw: (g) => g.fillRect(60, 120, 250, 300), fill: (g) => pattern(g, 6, [60, 120, 80], "stripes") },
    { depth: 0.9, draw: (g) => { g.beginPath(); g.arc(340, 300, 90, 0, Math.PI * 2); g.fill(); },
      fill: (g) => pattern(g, 7, [200, 80, 70], "checker") },
  ]},
];

// Draw the scene as the camera sees it after moving by `o` (uv units), back to front.
function renderTruth(scene: Scene, o: [number, number], depthOnly: boolean) {
  const c = document.createElement("canvas"); c.width = c.height = N;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  for (const L of scene.layers) {
    g.save();
    g.translate(o[0] * (L.depth - FOCUS) * N, -o[1] * (L.depth - FOCUS) * N); // uv y is up, canvas y is down
    const v = Math.round(L.depth * 255);
    g.fillStyle = depthOnly ? `rgb(${v},${v},${v})` : L.fill(g);
    L.draw(g);
    g.restore();
  }
  return { canvas: c, data: g.getImageData(0, 0, N, N).data };
}

function edgeBand(depthRGBA: Uint8ClampedArray, r = 12) {
  const edge = new Uint8Array(N * N);
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x, d = depthRGBA[i * 4];
    if (Math.abs(d - depthRGBA[(i + 1) * 4]) > 20 || Math.abs(d - depthRGBA[(i + N) * 4]) > 20) edge[i] = 1;
  }
  const band = new Uint8Array(N * N); // square dilation, fine for a mask
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!edge[y * N + x]) continue;
    for (let yy = Math.max(0, y - r); yy <= Math.min(N - 1, y + r); yy++)
      for (let xx = Math.max(0, x - r); xx <= Math.min(N - 1, x + r); xx++) band[yy * N + xx] = 1;
  }
  return band;
}

function psnr(a: Uint8ClampedArray | Uint8Array, b: Uint8ClampedArray, mask?: Uint8Array) {
  let se = 0, n = 0;
  for (let y = BORDER; y < N - BORDER; y++) for (let x = BORDER; x < N - BORDER; x++) {
    const i = y * N + x; if (mask && !mask[i]) continue;
    for (let c = 0; c < 3; c++) { const d = a[i * 4 + c] - b[i * 4 + c]; se += d * d; }
    n += 3;
  }
  return 10 * Math.log10((255 * 255) / (se / n));
}

type Row = { scene: string; depth: string; method: string; full: number; edge: number };

// debug strip: truth + each method + |diff| x4, for one camera move per scene (true depth)
function addDebug(label: string, imgs: [string, Uint8Array | Uint8ClampedArray][], truth: Uint8ClampedArray) {
  const host = document.getElementById("debug"); if (!host) return;
  const row = document.createElement("div"); row.style.cssText = "display:flex;gap:6px;margin:8px 0;flex-wrap:wrap";
  const add = (name: string, data: Uint8ClampedArray<ArrayBuffer>) => {
    const c = document.createElement("canvas"); c.width = c.height = N; c.style.width = "200px"; c.title = name;
    c.getContext("2d")!.putImageData(new ImageData(data, N, N), 0, 0);
    const f = document.createElement("figure"); f.style.margin = "0";
    const cap = document.createElement("figcaption"); cap.textContent = name; cap.style.fontSize = "11px";
    f.append(c, cap); row.append(f);
  };
  add(label + ": truth", new Uint8ClampedArray(truth));
  for (const [name, im] of imgs) {
    add(name, new Uint8ClampedArray(im));
    const d = new Uint8ClampedArray(N * N * 4);
    for (let i = 0; i < N * N; i++) { for (let c = 0; c < 3; c++) d[i * 4 + c] = Math.abs(im[i * 4 + c] - truth[i * 4 + c]) * 4; d[i * 4 + 3] = 255; }
    add(name + " |diff|x4", d);
  }
  host.append(row);
}

export default function Eval() {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState("Running…");
  const started = useRef(false); // React dev mode mounts twice; run the eval once

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
      renderer.setSize(N, N, false);
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // compare raw 8-bit values, no colour transform
      const target = new THREE.WebGLRenderTarget(N, N);
      const u: Record<string, THREE.IUniform> = {
        uImage: { value: null }, uDepthRaw: { value: null }, uDepthMarch: { value: null },
        uOffset: { value: new THREE.Vector2() }, uFocus: { value: FOCUS }, uCover: { value: new THREE.Vector2(1, 1) },
        uZoom: { value: 1 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uSplit: { value: 0.5 }, uMode: { value: 0 }, uView: { value: 0 },
        uExposure: { value: 1 }, uHasImage: { value: 1 }, uFill: { value: 0 }, uWall: { value: WALL },
      };
      const scene3 = new THREE.Scene();
      scene3.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: u, vertexShader, fragmentShader })));
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const px = new Uint8Array(N * N * 4), flipped = new Uint8Array(N * N * 4);
      const tex = (d: Uint8Array) => {
        const t = new THREE.DataTexture(d, N, N, THREE.RedFormat); t.flipY = true; t.unpackAlignment = 1;
        t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true; return t;
      };
      const render = () => {
        renderer.setRenderTarget(target); renderer.render(scene3, cam);
        renderer.readRenderTargetPixels(target, 0, 0, N, N, px);
        for (let y = 0; y < N; y++) flipped.set(px.subarray((N - 1 - y) * N * 4, (N - y) * N * 4), y * N * 4);
        return flipped;
      };

      // model depth comes from the same worker the app uses
      const worker = new Worker(new URL("../workers/depth.worker.ts", import.meta.url), { type: "module" });
      const modelDepth = (rgba: Uint8ClampedArray) => new Promise<Uint8Array>((res) => {
        worker.onmessage = (e) => { if (e.data.type === "depth") res(new Uint8Array(e.data.buffer)); };
        const copy = new Uint8ClampedArray(rgba);
        worker.postMessage({ type: "depth", id: 0, width: N, height: N, buffer: copy.buffer }, [copy.buffer]);
      });

      const out: Row[] = [];
      for (const sc of SCENES) {
        const src = renderTruth(sc, [0, 0], false);
        const srcDepthRGBA = renderTruth(sc, [0, 0], true).data;
        const gtDepth = new Uint8Array(N * N); for (let i = 0; i < N * N; i++) gtDepth[i] = srcDepthRGBA[i * 4];
        setStatus(`Depth model on "${sc.name}"…`);
        const mDepth = await modelDepth(src.data);
        const imgTex = new THREE.CanvasTexture(src.canvas); imgTex.flipY = true;
        imgTex.minFilter = THREE.LinearFilter; imgTex.generateMipmaps = false;
        u.uImage.value = imgTex;

        for (const [dname, raw] of [["true depth", gtDepth], ["model depth", mDepth]] as const) {
          const rawT = tex(raw), cleanT = tex(prepDepth(raw, N, N, 4, 2));
          const methods: [string, number, THREE.Texture, number][] = [
            ["naive", 0, rawT, 0], ["ray march", 1, rawT, 0], ["ray march + clean-up", 1, cleanT, 0],
            ["ray march + wall fill", 1, rawT, 1], ["ray march + wall fill + clean-up", 1, cleanT, 1]];
          const acc = methods.map(() => ({ full: 0, edge: 0 }));
          let n = 0;
          for (const s of STRENGTHS) for (const [dx, dy] of DIRS) {
            const o: [number, number] = [dx * s, dy * s];
            const truth = renderTruth(sc, o, false).data;
            const band = edgeBand(renderTruth(sc, o, true).data);
            u.uOffset.value.set(o[0], o[1]);
            const dbg: [string, Uint8Array][] = [];
            methods.forEach(([mname, mode, dt, fill], k) => {
              u.uFill.value = fill; u.uMode.value = mode; u.uDepthRaw.value = dt; u.uDepthMarch.value = dt;
              const img = render();
              if (n === 6 && dname === "true depth") dbg.push([mname, new Uint8Array(img)]);
              acc[k].full += psnr(img, truth); acc[k].edge += psnr(img, truth, band);
            });
            if (dbg.length) addDebug(sc.name, dbg, truth);
            n++;
          }
          methods.forEach(([name], k) => out.push({ scene: sc.name, depth: dname, method: name, full: acc[k].full / n, edge: acc[k].edge / n }));
          setRows([...out]);
        }
      }
      worker.terminate();
      setStatus(`Done: ${SCENES.length} scenes × ${STRENGTHS.length * DIRS.length} camera moves each.`);
      (window as unknown as { __eval: Row[] }).__eval = out;
      console.log("[SceneShift eval]", JSON.stringify(out));
    })();
  }, []);

  return (
    <main style={{ padding: 32, color: "#eee", background: "#111", minHeight: "100vh", font: "14px/1.5 system-ui" }}>
      <h1 style={{ fontSize: 20 }}>SceneShift eval: PSNR vs the true camera move (higher is better)</h1>
      <p>{status}</p>
      <table style={{ borderCollapse: "collapse" }}>
        <thead><tr>{["Scene", "Depth", "Method", "PSNR full (dB)", "PSNR edge band (dB)"].map((h) =>
          <th key={h} style={{ textAlign: "left", padding: "4px 14px 4px 0", borderBottom: "1px solid #444" }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}><td style={{ paddingRight: 14 }}>{r.scene}</td><td style={{ paddingRight: 14 }}>{r.depth}</td>
            <td style={{ paddingRight: 14 }}>{r.method}</td><td>{r.full.toFixed(2)}</td><td>{r.edge.toFixed(2)}</td></tr>
        ))}</tbody>
      </table>
      <div id="debug" />
    </main>
  );
}
