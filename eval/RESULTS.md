# Eval results (2026-11-05)

Run: `npm run dev`, open `http://localhost:3000/eval`. Deterministic: same numbers on every run.

Setup: 3 synthetic layered scenes (512 × 512) with known depth. For each scene, 12 camera moves
(6 directions × strength 0.035 and 0.06, focus 0.3). The truth is drawn by shifting each layer back to front.
Every method renders the same move through the real shader. PSNR in dB vs the truth, higher is better;
a 40 px border is ignored (all methods clamp there the same way). "Edge band" = pixels within 12 px of a
depth edge in the truth, where the methods actually differ.

"True depth" feeds the shader the exact layer depth (tests the warp alone).
"Model depth" feeds it Depth Anything V2 small run on the synthetic image (tests the full pipeline).

| Scene | Depth | Naive | Ray march | Ray march + clean-up | + wall fill | + wall fill + clean-up |
|---|---|---|---|---|---|---|
| portrait | true | 25.53 / 18.08 | 30.18 / 22.65 | **30.97 / 23.58** | 30.77 / 23.24 | 30.96 / 23.58 |
| rigging | true | 14.91 / 12.69 | 15.64 / 13.25 | **22.50 / 20.22** | 17.15 / 14.75 | 22.52 / 20.24 |
| three layers | true | 26.79 / 20.37 | 30.83 / 24.35 | **31.90 / 25.61** | 31.63 / 25.17 | 31.90 / 25.61 |
| portrait | model | 20.16 / 15.41 | 20.21 / 15.50 | **20.35 / 15.81** | 20.22 / 15.50 | 20.35 / 15.81 |
| rigging | model | 14.22 / 12.04 | 14.40 / 12.20 | **14.56 / 12.34** | 14.42 / 12.22 | 14.56 / 12.34 |
| three layers | model | 18.72 / 16.23 | 18.71 / 16.23 | **18.72 / 16.39** | 18.71 / 16.23 | 18.72 / 16.39 |

Cells: full frame / edge band.

## What it says
- With good depth, the ray march beats the naive offset by 4.0 to 4.6 dB (portrait, three layers).
- Matte clean-up (dilate near side 4 px + soften 2 px) adds about 1 dB, and **+6.9 dB on thin lines**:
  without it the ray march turns each 3 px line into a streak as wide as the parallax shift.
- Wall fill (look through depth walls + edge-extend fill) helps on its own (+1.5 dB on rigging) but adds
  nothing on top of the clean-up, so it stays off by default (`?fill=1` to try it).
- With model depth all methods are within 0.5 dB: on flat synthetic art the depth model, not the warp,
  is the bottleneck. These scenes say nothing about how good the model is on real photos.

## Speed (Apple M2 Max, Chrome, 768 px depth input)
| Step | WebGPU (fp16) | WASM (q8) |
|---|---|---|
| Model load (cached) | 0.5 s | 4.2 s |
| Depth per photo, warm | ~98 ms (138 ms first run) | ~2.8 s |
| Matte clean-up (JS) | 27 ms | 27 ms |
| Render | 60 fps (vsync) | 60 fps |
