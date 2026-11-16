// makefun-ai-excited-01 — "The Giant of the Night Tide"
// A fully procedural 1024x1024 painting, drawn pixel by pixel with no
// assets, no network and no randomness: a colossal luminous jellyfish
// drifting over a tiny neon coastal town at night. The scale twist — one
// glowing giant above a miniature lit-up town — is the surprise; the
// hot magenta / cyan palette, the diagonal sweep of the tentacles and the
// single huge dome silhouette are what hit first, even at 300px wide.
//
// Node 22, standard library only. Deterministic: two runs write
// byte-identical PNGs (seeded PRNG, fixed palette, zlib level 9).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — the only source of "randomness" in the program.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x9e3779b9);

// ---------------------------------------------------------------------------
// Canvas: a plain RGBA buffer with a small set of drawing primitives.
// ---------------------------------------------------------------------------
type RGB = [number, number, number];

class Canvas {
  readonly w = W;
  readonly h = H;
  readonly data = new Uint8ClampedArray(W * H * 4);

  private idx(x: number, y: number): number {
    return (y * W + x) * 4;
  }

  // Source-over blend of one pixel.
  put(x: number, y: number, r: number, g: number, b: number, a: number): void {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H || a <= 0) return;
    const i = this.idx(xi, yi);
    const d = this.data;
    if (a >= 1) {
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      return;
    }
    const ia = 1 - a;
    d[i] = r * a + d[i] * ia;
    d[i + 1] = g * a + d[i + 1] * ia;
    d[i + 2] = b * a + d[i + 2] * ia;
    d[i + 3] = 255;
  }

  // Additive light: pushes the pixel toward white-hot colour.
  add(x: number, y: number, r: number, g: number, b: number, a: number): void {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H || a <= 0) return;
    const i = this.idx(xi, yi);
    const d = this.data;
    d[i] = Math.min(255, d[i] + r * a);
    d[i + 1] = Math.min(255, d[i + 1] + g * a);
    d[i + 2] = Math.min(255, d[i + 2] + b * a);
    d[i + 3] = 255;
  }

  fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 1): void {
    const xa = Math.max(0, Math.floor(x0));
    const xb = Math.min(W - 1, Math.ceil(x1));
    const ya = Math.max(0, Math.floor(y0));
    const yb = Math.min(H - 1, Math.ceil(y1));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) this.put(x, y, c[0], c[1], c[2], a);
    }
  }

  // Vertical linear gradient over a rectangle.
  vGrad(x0: number, y0: number, x1: number, y1: number, stops: Array<[number, RGB]>): void {
    const ya = Math.max(0, Math.floor(y0));
    const yb = Math.min(H - 1, Math.ceil(y1));
    for (let y = ya; y <= yb; y++) {
      const t = (y - y0) / (y1 - y0);
      const c = sampleStops(stops, t);
      this.fillRect(x0, y, x1, y + 1, c, 1);
    }
  }

  // Filled disc; colour is a function of radius fraction t (0 centre, 1 rim).
  disc(cx: number, cy: number, r: number, colour: (t: number) => RGB, alpha = 1): void {
    const xa = Math.max(0, Math.floor(cx - r));
    const xb = Math.min(W - 1, Math.ceil(cx + r));
    const ya = Math.max(0, Math.floor(cy - r));
    const yb = Math.min(H - 1, Math.ceil(cy + r));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const dx = (x + 0.5 - cx) / r;
        const dy = (y + 0.5 - cy) / r;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1) continue;
        const c = colour(Math.sqrt(d2));
        // Soft 1px rim so discs never look aliased-hard.
        const edge = d2 > 0.94 ? (1 - d2) / 0.06 : 1;
        this.put(x, y, c[0], c[1], c[2], alpha * edge);
      }
    }
  }

  // Additive glow disc (light, not paint).
  glow(cx: number, cy: number, r: number, c: RGB, strength: number): void {
    const xa = Math.max(0, Math.floor(cx - r));
    const xb = Math.min(W - 1, Math.ceil(cx + r));
    const ya = Math.max(0, Math.floor(cy - r));
    const yb = Math.min(H - 1, Math.ceil(cy + r));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const dx = (x + 0.5 - cx) / r;
        const dy = (y + 0.5 - cy) / r;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1) continue;
        const fall = (1 - d2) * (1 - d2);
        this.add(x, y, c[0], c[1], c[2], strength * fall);
      }
    }
  }

  // Scanline polygon fill (even-odd).
  poly(points: Array<[number, number]>, c: RGB, a = 1): void {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of points) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const ya = Math.max(0, Math.floor(minY));
    const yb = Math.min(H - 1, Math.ceil(maxY));
    const n = points.length;
    for (let y = ya; y <= yb; y++) {
      const yc = y + 0.5;
      const xs: number[] = [];
      for (let i = 0; i < n; i++) {
        const [x0, y0] = points[i];
        const [x1, y1] = points[(i + 1) % n];
        if ((y0 <= yc && y1 > yc) || (y1 <= yc && y0 > yc)) {
          xs.push(x0 + ((yc - y0) * (x1 - x0)) / (y1 - y0));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.floor(xs[k]));
        const xb = Math.min(W - 1, Math.ceil(xs[k + 1]));
        for (let x = xa; x <= xb; x++) this.put(x, y, c[0], c[1], c[2], a);
      }
    }
  }

  // Thick polyline: stamped discs along the path, radius may taper.
  // Each segment is subdivided so the stamps overlap and the line reads
  // as one smooth ribbon, never as a string of beads.
  stroke(points: Array<[number, number]>, r0: number, r1: number, c: RGB, a = 1): void {
    const n = points.length;
    if (n === 0) return;
    if (n === 1) {
      this.disc(points[0][0], points[0][1], Math.max(0.6, r0), () => c, a);
      return;
    }
    for (let i = 0; i < n - 1; i++) {
      const [x0, y0] = points[i];
      const [x1, y1] = points[i + 1];
      const segLen = Math.hypot(x1 - x0, y1 - y0);
      const t0 = i / (n - 1);
      const t1 = (i + 1) / (n - 1);
      const steps = Math.max(1, Math.ceil(segLen / 1.1));
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        const t = t0 + (t1 - t0) * f;
        const r = r0 + (r1 - r0) * t;
        this.disc(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, Math.max(0.6, r), () => c, a);
      }
    }
  }

  // Cubic bezier sampled into a point list.
  static bezier(
    p0: [number, number], p1: [number, number],
    p2: [number, number], p3: [number, number],
    steps: number,
  ): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const x =
        u * u * u * p0[0] + 3 * u * u * t * p1[0] +
        3 * u * t * t * p2[0] + t * t * t * p3[0];
      const y =
        u * u * u * p0[1] + 3 * u * u * t * p1[1] +
        3 * u * t * t * p2[1] + t * t * t * p3[1];
      out.push([x, y]);
    }
    return out;
  }
}

// Interpolate a colour-stop list at t in [0,1].
function sampleStops(stops: Array<[number, RGB]>, t: number): RGB {
  const c = Math.min(1, Math.max(0, t));
  if (c <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (c <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (c - t0) / (t1 - t0);
      return [
        c0[0] + (c1[0] - c0[0]) * f,
        c0[1] + (c1[1] - c0[1]) * f,
        c0[2] + (c1[2] - c0[2]) * f,
      ];
    }
  }
  return stops[stops.length - 1][1];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
// The painting.
// ---------------------------------------------------------------------------
const SKY: Array<[number, RGB]> = [
  [0.0, [7, 4, 26]],
  [0.45, [22, 10, 58]],
  [0.72, [52, 18, 84]],
  [1.0, [104, 32, 96]],
];
const TENTACLE_COLOURS: RGB[] = [
  [64, 224, 255], // cyan
  [255, 92, 214], // hot pink
  [255, 176, 66], // amber
  [178, 120, 255], // violet
  [94, 255, 196], // mint
];

function paint(cv: Canvas): void {
  // --- Night sky -----------------------------------------------------------
  cv.vGrad(0, 0, W, 800, SKY);

  // Stars, denser and brighter away from the horizon glow.
  for (let i = 0; i < 420; i++) {
    const x = rnd() * W;
    const y = rnd() * 640;
    const b = 0.35 + rnd() * 0.65;
    const s = rnd();
    const col: RGB = s < 0.12 ? [255, 214, 150] : s < 0.3 ? [190, 220, 255] : [255, 255, 255];
    const r = rnd() < 0.08 ? 2.2 : 1.1;
    cv.disc(x, y, r, () => col, b * (1 - y / 1400));
    if (rnd() < 0.05) {
      // A few four-point sparkles.
      cv.stroke([[x - 6, y], [x + 6, y]], 0.7, 0.7, col, 0.5);
      cv.stroke([[x, y - 6], [x, y + 6]], 0.7, 0.7, col, 0.5);
    }
  }

  // Aurora ribbons: slow sine bands, teal over violet.
  const aurora: RGB[] = [[46, 255, 190], [64, 224, 255], [150, 255, 170]];
  for (let band = 0; band < 3; band++) {
    const baseY = 120 + band * 78;
    const amp = 34 + band * 12;
    const col = aurora[band];
    for (let x = 0; x < W; x += 2) {
      const y = baseY + Math.sin(x / 190 + band * 1.7) * amp + Math.sin(x / 61 + band) * 9;
      const thick = 26 - band * 5;
      for (let dy = -thick; dy <= thick; dy++) {
        const fall = 1 - Math.abs(dy) / thick;
        cv.add(x, y + dy, col[0], col[1], col[2], 0.05 * fall * fall);
      }
    }
  }

  // Moon, top right, with a wide halo.
  cv.glow(838, 138, 210, [255, 240, 200], 0.16);
  cv.glow(838, 138, 90, [255, 244, 214], 0.35);
  cv.disc(838, 138, 46, () => [255, 248, 224], 1);
  cv.disc(824, 128, 9, () => [232, 222, 196], 0.8);
  cv.disc(852, 152, 6, () => [232, 222, 196], 0.8);
  cv.disc(846, 122, 4, () => [232, 222, 196], 0.7);

  // Distant headland silhouettes, left and right, framing the bay.
  cv.poly([[0, 800], [0, 700], [70, 724], [150, 690], [235, 726], [300, 712], [330, 800]], [16, 8, 40], 1);
  cv.poly([[1024, 800], [1024, 716], [950, 700], [880, 736], [830, 720], [800, 800]], [16, 8, 40], 1);

  // --- Sea -----------------------------------------------------------------
  cv.vGrad(0, 800, W, H, [
    [0.0, [30, 12, 66]],
    [0.35, [16, 24, 74]],
    [1.0, [6, 8, 34]],
  ]);
  // Jellyfish light shimmering on the water: horizontal streaks under the dome.
  for (let i = 0; i < 90; i++) {
    const x = 512 + (rnd() - 0.5) * 560 * (0.4 + rnd() * 0.6);
    const y = 812 + rnd() * 190;
    const len = 14 + rnd() * 70;
    const col = TENTACLE_COLOURS[Math.floor(rnd() * TENTACLE_COLOURS.length)];
    const a = 0.10 + rnd() * 0.22;
    cv.stroke([[x - len / 2, y], [x + len / 2, y]], 1.1, 1.1, col, a);
  }
  // Tiny sailboat, far left — one more scale cue against the giant.
  cv.poly([[96, 876], [96, 838], [128, 876]], [245, 240, 255], 0.95);
  cv.poly([[92, 876], [140, 876], [132, 884], [98, 884]], [24, 12, 48], 1);
  cv.stroke([[96, 838], [96, 876]], 1.4, 1.4, [245, 240, 255], 0.95);

  // --- The tiny town -------------------------------------------------------
  // A miniature lit-up coastal town along the far shore, y ~ 748..800.
  const townBase = 800;
  let bx = 330;
  while (bx < 800) {
    const bw = 26 + rnd() * 30;
    const bh = 18 + rnd() * 42;
    const top = townBase - bh;
    cv.fillRect(bx, top, bx + bw, townBase, [12, 6, 34], 1);
    // Pitched roof on some houses.
    if (rnd() < 0.55) {
      cv.poly([[bx - 2, top], [bx + bw / 2, top - 12 - rnd() * 8], [bx + bw + 2, top]], [10, 5, 30], 1);
    }
    // Warm windows.
    const cols = Math.max(1, Math.floor(bw / 11));
    const rows = Math.max(1, Math.floor(bh / 14));
    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        if (rnd() < 0.55) {
          const wx = bx + 4 + cx * 11;
          const wy = top + 5 + cy * 14;
          const warm: RGB = rnd() < 0.75 ? [255, 190, 90] : [140, 220, 255];
          cv.fillRect(wx, wy, wx + 4, wy + 5, warm, 0.95);
        }
      }
    }
    bx += bw + 4 + rnd() * 10;
  }
  // Lighthouse on the right headland, beam sweeping up-left toward the giant.
  cv.fillRect(872, 716, 884, 800, [230, 225, 240], 1);
  cv.poly([[870, 716], [886, 716], [880, 704]], [255, 80, 120], 1);
  cv.glow(878, 710, 26, [255, 220, 130], 0.8);
  const beam: Array<[number, number]> = [[878, 710], [560, 470], [600, 560]];
  cv.poly(beam, [255, 226, 140], 0.10);
  cv.poly([[878, 710], [600, 500], [636, 580]], [255, 226, 140], 0.08);

  // --- The giant: a colossal luminous jellyfish ---------------------------
  const cx = 512;
  const cy = 452;
  const rx = 296;
  const ry = 262;

  // Halo of light behind the dome so it lifts off the sky.
  cv.glow(cx, cy - 20, 420, [255, 80, 200], 0.20);
  cv.glow(cx, cy - 20, 300, [140, 90, 255], 0.22);

  // Dome: a wide bell, filled column by column so the colour runs from a
  // hot pink crown down to deep violet at the scalloped margin.
  const domeSteps = 90;
  const scallops = 9; // gentle waves along the bell margin, like a real jellyfish
  const bellStops: Array<[number, RGB]> = [
    [0.0, [255, 158, 232]],
    [0.45, [238, 74, 196]],
    [0.8, [196, 52, 178]],
    [1.0, [138, 32, 148]],
  ];
  for (let xi = Math.floor(cx - rx); xi <= Math.ceil(cx + rx); xi++) {
    const fx = (xi + 0.5 - cx) / rx;
    if (fx < -1 || fx > 1) continue;
    const topY = cy - ry * Math.sqrt(1 - fx * fx);
    const frac = (xi + 0.5 - (cx - rx)) / (2 * rx);
    const botY = cy + 6 + Math.sin(frac * Math.PI * scallops) * 16 * 0.55;
    for (let y = Math.floor(topY); y <= Math.ceil(botY); y++) {
      const t = (y - topY) / Math.max(1, botY - topY);
      const c = sampleStops(bellStops, t);
      cv.put(xi, y, c[0], c[1], c[2], 1);
    }
  }
  // (dome outline, for the rim light and striations below)
  const dome: Array<[number, number]> = [];
  for (let i = 0; i <= domeSteps; i++) {
    const t = (i / domeSteps) * Math.PI; // 0..PI, left rim to right rim
    const x = cx + Math.cos(t + Math.PI) * rx * -1; // sweep left -> right over the top
    const y = cy - Math.sin(t) * ry;
    dome.push([x, y]);
  }
  // Inner glow: concentric bells shrinking toward the hot core.
  for (let k = 5; k >= 1; k--) {
    const f = k / 5;
    const inner: Array<[number, number]> = [];
    for (let i = 0; i <= domeSteps; i++) {
      const t = (i / domeSteps) * Math.PI;
      const x = cx + Math.cos(t + Math.PI) * rx * f * -1;
      const y = cy - 8 - Math.sin(t) * ry * f;
      inner.push([x, y]);
    }
    for (let i = domeSteps; i >= 0; i--) {
      const t = i / domeSteps;
      inner.push([cx + lerp(-rx, rx, t) * f, cy + 4]);
    }
    const c = sampleStops([
      [0, [255, 120, 220]],
      [1, [190, 60, 200]],
    ], 1 - f);
    cv.poly(inner, c, 0.16);
  }
  // Hot core near the top of the bell.
  cv.glow(cx, cy - 120, 190, [255, 150, 230], 0.5);
  cv.glow(cx, cy - 150, 90, [255, 220, 250], 0.55);
  cv.disc(cx, cy - 150, 34, () => [255, 235, 250], 0.9);

  // Bell striations: thin bright arcs fanning from the core toward the rim.
  for (let k = 0; k < 11; k++) {
    const frac = 0.1 + (k / 10) * 0.8; // position along the rim, left->right
    const pts: Array<[number, number]> = [];
    for (let s = 0; s <= 20; s++) {
      const f = 0.30 + (s / 20) * 0.66;
      const t = Math.PI * frac;
      // Point on the bell outline at angle t, scaled by f toward the core.
      const ox = cx + Math.cos(t + Math.PI) * rx * f * -1;
      const oy = cy - Math.sin(t) * ry * f;
      pts.push([ox, oy]);
    }
    cv.stroke(pts, 2.2, 1.0, [255, 170, 235], 0.35);
  }

  // Rim light: a bright cyan-violet arc hugging the top of the bell.
  const rim: Array<[number, number]> = [];
  for (let i = 0; i <= 60; i++) {
    const t = (i / 60) * Math.PI;
    rim.push([cx + Math.cos(t + Math.PI) * rx * -1, cy - Math.sin(t) * ry]);
  }
  cv.stroke(rim, 5.0, 5.0, [120, 240, 255], 0.85);
  cv.stroke(rim, 2.0, 2.0, [220, 250, 255], 0.9);

  // Scalloped oral arms hanging from the bell margin, glowing.
  for (let k = 0; k < 5; k++) {
    const fx = -0.55 + k * 0.275;
    const x0 = cx + fx * rx * 0.9;
    const pts = Canvas.bezier(
      [x0, cy + 4],
      [x0 + 26, cy + 90],
      [x0 - 30, cy + 170],
      [x0 + 12, cy + 250],
      26,
    );
    cv.stroke(pts, 13, 5, [255, 110, 210], 0.75);
    cv.stroke(pts, 5, 2, [255, 190, 235], 0.8);
  }

  // Tentacles: long ribbons sweeping down in a diagonal current, each
  // tapering to a glowing tip. They carry the momentum of the whole image.
  const tentCount = 15;
  for (let k = 0; k < tentCount; k++) {
    const fx = -0.92 + (k / (tentCount - 1)) * 1.84;
    const x0 = cx + fx * rx * 0.96;
    const sway = 46 + rnd() * 60;
    const len = 300 + rnd() * 190;
    const dir = fx < 0 ? -1 : 1;
    const col = TENTACLE_COLOURS[k % TENTACLE_COLOURS.length];
    const pts = Canvas.bezier(
      [x0, cy + 2],
      [x0 + dir * sway * 0.4, cy + len * 0.35],
      [x0 - dir * sway * 0.7, cy + len * 0.68],
      [x0 + dir * sway, cy + len],
      30,
    );
    // Under-glow first, then the ribbon, then a bright core thread.
    cv.stroke(pts, 9, 2.5, col, 0.28);
    cv.stroke(pts, 5.5, 1.6, col, 0.85);
    cv.stroke(pts, 2.0, 0.8, [255, 255, 255], 0.75);
    // Glowing beads drifting along the ribbon.
    for (let b = 1; b <= 3; b++) {
      const p = pts[Math.floor((pts.length - 1) * (b / 4))];
      cv.glow(p[0], p[1], 12, col, 0.7);
      cv.disc(p[0], p[1], 3.2, () => [255, 255, 255], 0.95);
    }
    // Hot tip.
    const tip = pts[pts.length - 1];
    cv.glow(tip[0], tip[1], 16, col, 0.9);
  }

  // Sparkles bursting off the bell, like plankton caught in its light.
  for (let i = 0; i < 70; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = rx * (0.9 + rnd() * 0.55);
    const x = cx + Math.cos(a) * rr;
    const y = cy - 40 + Math.sin(a) * ry * 0.95;
    const col = TENTACLE_COLOURS[Math.floor(rnd() * TENTACLE_COLOURS.length)];
    const s = 1 + rnd() * 2.4;
    cv.glow(x, y, s * 5, col, 0.55);
    cv.disc(x, y, s, () => [255, 255, 255], 0.9);
  }

  // A few tiny birds crossing the open sky on the left — motion, scale.
  // (Kept clear of the dome, which reaches x≈337 at these heights.)
  const birds: Array<[number, number, number]> = [
    [190, 250, 1.0], [238, 220, 0.8], [160, 300, 0.7], [270, 278, 0.8],
  ];
  for (const [bx2, by2, s] of birds) {
    const w = 16 * s;
    cv.stroke([[bx2 - w, by2], [bx2 - w * 0.4, by2 - 5 * s], [bx2, by2]], 1.4, 1.4, [20, 10, 40], 0.95);
    cv.stroke([[bx2, by2], [bx2 + w * 0.4, by2 - 5 * s], [bx2 + w, by2]], 1.4, 1.4, [20, 10, 40], 0.95);
  }

  // --- Vignette: pull the eye to the giant -------------------------------
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const dx = (x - cx) / (W * 0.62);
      const dy = (y - (cy - 40)) / (H * 0.62);
      const d2 = dx * dx + dy * dy;
      if (d2 > 0.72) {
        const a = Math.min(0.34, (d2 - 0.72) * 0.55);
        cv.put(x, y, 4, 2, 16, a);
        cv.put(x + 1, y, 4, 2, 16, a);
        cv.put(x, y + 1, 4, 2, 16, a);
        cv.put(x + 1, y + 1, 4, 2, 16, a);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (filter 0 scanlines, zlib deflate, CRC32).
// ---------------------------------------------------------------------------
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(cv: Canvas): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const rowStart = y * (1 + W * 4);
    raw[rowStart] = 0; // filter type 0 (None)
    Buffer.from(cv.data.buffer, y * W * 4, W * 4).copy(raw, rowStart + 1);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
function main(): void {
  const outDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  mkdirSync(outDir, { recursive: true });
  const cv = new Canvas();
  paint(cv);
  const png = encodePNG(cv);
  const outPath = join(outDir, 'entry.png');
  writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes, ${W}x${H})`);
}

main();
