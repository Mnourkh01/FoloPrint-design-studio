import sharp from 'sharp';
import { HEX_COLOR_PATTERN } from '@foloprint/shared';

/** Defensive cap against pixel bombs reaching libvips (mirrors index.ts). */
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Fraction of the target-color-to-white distance added back on the brightest
 * fabric, so dark garments keep visible fold detail (a pure multiply tint would
 * crush a black tee to a detail-free silhouette). Scales with shade^4: only the
 * lit fabric gets the sheen, folds stay deep.
 */
const SHEEN = 0.12;

/**
 * Minimum shade multiplier inside the garment. The white blank's deepest folds
 * approach black; without a floor a dark target color would lose them entirely
 * (0 * anything = 0 leaves no separation between fold and silhouette edge).
 */
const SHADE_FLOOR = 0.18;

export interface RecolorGarmentOptions {
  /** The white/light garment blank photo (PNG buffer). */
  source: Buffer;
  /**
   * The garment mask derived by build-assets.js (alpha = garment silhouette,
   * feathered edge). Must match the source dimensions exactly.
   */
  mask: Buffer;
  /** Target garment color, strict #RRGGBB. */
  hex: string;
  /**
   * Heather fabric: deterministic per-pixel shade noise amplitude (0..0.2),
   * 0/absent = smooth fabric. Gives the speckled melange look without any
   * random source (same inputs always produce the same bytes).
   */
  noise?: number;
}

/**
 * Recolors the garment pixels of a blank product photo to a target color while
 * preserving the photo's fabric shading. shade = pixel luma normalized to the
 * garment white point (97th percentile, same definition build-assets.js uses
 * for the multiply overlay); each garment pixel becomes target * shade plus a
 * small white sheen on the brightest fabric so dark colors keep fold detail.
 * Background pixels pass through untouched; the feathered mask edge blends the
 * recolor in proportionally, so the silhouette edge stays soft.
 */
export async function recolorGarment(options: RecolorGarmentOptions): Promise<Buffer> {
  const { source, mask, hex, noise = 0 } = options;
  if (!HEX_COLOR_PATTERN.test(hex)) {
    throw new Error(`recolorGarment: invalid hex color "${hex}" (want #RRGGBB)`);
  }
  if (noise < 0 || noise > 0.2) {
    throw new Error(`recolorGarment: noise ${noise} out of range (0..0.2)`);
  }
  const target = {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };

  const { data, info } = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;

  const { data: maskData, info: maskInfo } = await sharp(mask, { limitInputPixels: MAX_INPUT_PIXELS })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (maskInfo.width !== w || maskInfo.height !== h) {
    throw new Error(
      `recolorGarment: mask ${maskInfo.width}x${maskInfo.height} does not match source ${w}x${h}`,
    );
  }

  // Garment white point: 97th percentile luma of solidly-masked pixels (same
  // sampling stride and percentile as build-assets.js so the two stay in sync).
  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    luma[i] = 0.2126 * data[i * 4]! + 0.7152 * data[i * 4 + 1]! + 0.0722 * data[i * 4 + 2]!;
  }
  const lumaSamples: number[] = [];
  for (let i = 0; i < w * h; i += 7) {
    if (maskData[i * 4 + 3]! > 200) lumaSamples.push(luma[i]!);
  }
  if (lumaSamples.length === 0) {
    throw new Error('recolorGarment: mask selects no garment pixels');
  }
  lumaSamples.sort((a, b) => a - b);
  const whitePoint = Math.max(1, lumaSamples[Math.floor(lumaSamples.length * 0.97)]!);

  const out = Buffer.from(data);
  for (let i = 0; i < w * h; i++) {
    const maskAlpha = maskData[i * 4 + 3]!;
    if (maskAlpha === 0) continue;

    let shade = Math.min(1, luma[i]! / whitePoint);
    if (noise > 0) {
      // Deterministic per-pixel hash mapped to [-1, 1]; no Math.random so the
      // output is byte-stable across runs (seed idempotency depends on it).
      const hash = (((i * 2654435761) >>> 0) % 1000) / 1000;
      shade = Math.min(1, Math.max(0, shade + (hash * 2 - 1) * noise));
    }
    shade = SHADE_FLOOR + (1 - SHADE_FLOOR) * shade;
    const sheen = SHEEN * shade ** 4;

    for (let c = 0; c < 3; c++) {
      const targetCh = c === 0 ? target.r : c === 1 ? target.g : target.b;
      const recolored = Math.min(255, targetCh * shade + (255 - targetCh) * sheen);
      // Feathered mask edge: blend recolor in proportionally to the mask alpha.
      const src = data[i * 4 + c]!;
      out[i * 4 + c] = Math.round(src + ((recolored - src) * maskAlpha) / 255);
    }
  }

  return sharp(out, { raw: { width: w, height: h, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
