// Depth worker: runs Depth Anything V2 (small) fully in the browser with transformers.js.
// WebGPU first, WASM fallback. No server, no API key.
import { pipeline, RawImage, env } from "@huggingface/transformers";

env.allowLocalModels = false;

const MODEL = "onnx-community/depth-anything-v2-small";

type DepthPipe = (img: RawImage) => Promise<{ depth: RawImage }>;
let pipe: DepthPipe | null = null;
let device = "";

async function load(prefer: "webgpu" | "wasm") {
  const order = prefer === "webgpu" ? (["webgpu", "wasm"] as const) : (["wasm"] as const);
  for (const d of order) {
    try {
      const t0 = performance.now();
      pipe = (await pipeline("depth-estimation", MODEL, {
        device: d,
        dtype: d === "webgpu" ? "fp16" : "q8",
        progress_callback: (p: unknown) => postMessage({ type: "progress", p }),
      })) as unknown as DepthPipe;
      device = d;
      postMessage({ type: "ready", device, loadMs: performance.now() - t0 });
      return;
    } catch (err) {
      postMessage({ type: "log", msg: `${d} failed: ${String(err)}` });
    }
  }
  postMessage({ type: "error", msg: "no backend could load the depth model" });
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "load") {
    await load(msg.prefer ?? "webgpu");
    return;
  }
  if (msg.type === "depth") {
    if (!pipe) await load("webgpu");
    if (!pipe) return;
    const { id, width, height, buffer } = msg;
    const img = new RawImage(new Uint8ClampedArray(buffer), width, height, 4);
    const t0 = performance.now();
    const out = await pipe(img);
    const ms = performance.now() - t0;
    // out.depth: 8-bit relative inverse depth (bright = near), resized to the input size.
    const d = out.depth;
    const gray = d.channels === 1 ? d.data : (d.grayscale().data as Uint8Array | Uint8ClampedArray);
    const copy = new Uint8Array(gray);
    postMessage(
      { type: "depth", id, width: d.width, height: d.height, buffer: copy.buffer, ms, device },
      { transfer: [copy.buffer] },
    );
  }
};
