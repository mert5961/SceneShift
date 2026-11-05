# Build log

Kept while building, in order. Short on purpose.

## 2026-11-05

**Goal.** Take one idea from the Pixel live wallpapers case study ("transform your photos into cinematic
scenes": depth analysis, subtle perspective shift synced with interaction) and see how far one day gets in the
browser: Next.js, a free depth model running locally, a GLSL shader, real inputs (pointer, tilt, mic).

**Setup.** `create-next-app` (Next.js 16, TypeScript, App Router), three.js, transformers.js. Static export, so it
can live on GitHub Pages: no server, no API key. Next 16 has breaking changes; read `node_modules/next/dist/docs`
first (dynamic import with `ssr: false` must sit in a client component; `new Worker(new URL(...))` is supported).

**Depth.** Depth Anything V2 small (`onnx-community/depth-anything-v2-small`) in a Web Worker so the UI never
blocks. WebGPU fp16 first, WASM q8 fallback. First result on a test photo of a ship (not in the repo): 739 ms cold, then ~98 ms warm.

**Shader v1: naive offset.** `p = s - offset * (D(s) - focus)`. Works and is cheap, but reads depth at the screen
position instead of the source position, so edges double.

**Shader v2: ray march.** Heightfield march from near to far, 40 steps + linear refine. Near surfaces win, like a
real camera move.

**Bug: image looked darker / more contrasty than the photo.** Isolated it to colour management: the texture was
tagged sRGB (decoded to linear on sample) but the custom `ShaderMaterial` never re-encodes. Fix: no colour space
tag, pass 8-bit values straight through. Verified by eye against the source.

**Can't judge edges by eye, so: an eval.** Real photos have no true depth, so I built synthetic layered scenes with
known depth and a true camera move, then scored every method with PSNR (whole frame + band around depth edges).
See `eval/RESULTS.md`. First numbers: ray march +4.6 dB over naive; thin "rigging" lines barely improved.

**Fault on thin lines.** Added a debug strip (truth / method / |diff| x4) to the eval page instead of guessing.
It showed each 3 px rope smeared into a band as wide as the parallax shift: the classic heightfield "wall"
(a depth edge is a vertical cliff, the ray hits the cliff and paints the rope's colour across it).
- Tried: matte clean-up (dilate the near side 4 px + 2 px soften), like an erode/dilate on a key. Rigging
  15.6 → 22.5 dB. Keeps the subject's silhouette; the error moves into a small sky halo.
- Tried: "wall fill" (treat steep crossings as see-through, fill disocclusions by edge-extending nearby
  background). +1.5 dB alone, +0.0 on top of the clean-up, adds speckle. Kept the code, off by default.

**Phone frame + auto-framing.** A square photo in a tall phone frame cropped to empty sea. Auto-frame v1 (centroid
of the nearest 15%) picked the sea at the bottom: the ground is always nearest. v2: compare each pixel with its
row's median depth, so the ground plane cancels out and what stands up from it wins. Frames the ship correctly.

**Life.** Critically damped spring on every input (nothing snaps). Pointer → tilt (DeviceOrientation, iOS permission)
→ idle drift. Mic = "breeze": RMS with fast attack / slow release adds a sway. Intro "bloom" replays on
`visibilitychange`, the browser's closest thing to picking the phone up.

**Recording GIFs.** Chrome blocked the second automatic download, so the page records its own canvas with
`MediaRecorder` and posts the clip to a localhost-only receiver; ffmpeg makes the GIFs.

**Sample photo + auto-focus.** Switched to my own photo (Lisbon street at night; far-background people blurred
with a feathered mask, not a hard box). The wall I lean on is nearer than me, so a fixed focus made the wall move
most. Added auto-focus = median depth of the auto-framed subject. v1 picked the wall (focus 0.82): a near framing
element also "stands out" from its row. v2 weights the pick with a soft centre bias, since framing elements run
into the border: focus 0.62 on me, and the earlier ship test still lands on the ship (0.21).

## Known limits / next
- Disocclusions are filled with stretched background, not real inpainting. Next: a small inpainting pass
  (or a second "clean plate" layer) generated once per photo.
- Model depth on stylised/flat images is weak (see eval). Real photos are much better but have no score yet:
  next is a small set of photo pairs (phone moved a few cm) to score novel views on real images.
- 40 fixed steps: could be adaptive (fewer on flat regions) for low-end phones.
