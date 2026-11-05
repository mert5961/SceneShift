// Depth matte clean-up before the shader uses it. Same idea as a compositor's matte work:
// 1) dilate the near (bright) side a few pixels so the depth edge sits just OUTSIDE the subject.
//    The rubber-sheet stretch then happens on background pixels, and the subject keeps its silhouette.
// 2) soften with a small box blur so the edge has no stair steps.

function maxFilter1D(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number, horizontal: boolean) {
  const lenA = horizontal ? h : w; // number of lines
  const lenB = horizontal ? w : h; // length of a line
  for (let a = 0; a < lenA; a++) {
    for (let b = 0; b < lenB; b++) {
      let m = 0;
      const lo = Math.max(0, b - r), hi = Math.min(lenB - 1, b + r);
      for (let k = lo; k <= hi; k++) {
        const v = horizontal ? src[a * w + k] : src[k * w + a];
        if (v > m) m = v;
      }
      if (horizontal) dst[a * w + b] = m;
      else dst[b * w + a] = m;
    }
  }
}

function boxBlur1D(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number, horizontal: boolean) {
  const lenA = horizontal ? h : w;
  const lenB = horizontal ? w : h;
  for (let a = 0; a < lenA; a++) {
    let sum = 0, n = 0;
    const at = (b: number) => (horizontal ? src[a * w + b] : src[b * w + a]);
    for (let k = 0; k <= Math.min(r, lenB - 1); k++) { sum += at(k); n++; }
    for (let b = 0; b < lenB; b++) {
      const v = Math.round(sum / n);
      if (horizontal) dst[a * w + b] = v; else dst[b * w + a] = v;
      const add = b + r + 1, rem = b - r;
      if (add < lenB) { sum += at(add); n++; }
      if (rem >= 0) { sum -= at(rem); n--; }
    }
  }
}

export function prepDepth(depth: Uint8Array, w: number, h: number, dilate = 4, soften = 2): Uint8Array {
  const tmp = new Uint8Array(depth.length);
  const out = new Uint8Array(depth.length);
  if (dilate > 0) {
    maxFilter1D(depth, tmp, w, h, dilate, true);
    maxFilter1D(tmp, out, w, h, dilate, false);
  } else out.set(depth);
  if (soften > 0) {
    boxBlur1D(out, tmp, w, h, soften, true);
    boxBlur1D(tmp, out, w, h, soften, false);
  }
  return out;
}
