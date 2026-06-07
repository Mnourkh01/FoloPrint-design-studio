import sharp from 'sharp';
import { HEX_COLOR_PATTERN } from '@foloprint/shared';

/** Defensive cap against pixel bombs reaching libvips (mirrors index.ts). */
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Minimum shade multiplier inside the garment. The white blank's deepest folds
 * approach black; without a floor a saturated or dark target would crush them
 * into noisy near-black blotches (seen on red ribbing cuffs).
 */
const SHADE_FLOOR = 0.24;

/**
 * Fold contrast. The white blank is evenly lit, so its shading lives in a
 * narrow band just under the white point; a straight multiply by it reads as
 * airbrushed-flat ("color painted on top"). The gamma spreads that band so
 * folds keep their depth in the tinted fabric.
 */
const SHADE_GAMMA = 1.6;

/** How much of the photo's above-white-point specular overshoot is kept. */
const SPECULAR = 0.35;

/**
 * Peak sheen on the brightest fabric, scaled by how DARK the target is
 * (darkness = 1 - max channel / 255). Dark garments (black, navy) genuinely
 * show desaturated highlights; saturated mid colors (red, royal) must get
 * none, or their highlights wash toward pink/white and the hue drifts.
 */
const SHEEN_MAX = 0.05;

/** Mask dilation radius: edges always get tinted (the mask undershoots the
 * silhouette in shadowed spots, which left cream slivers on sleeves/hems).
 * A few pixels of tint spill onto the backdrop feathers away invisibly. */
const MASK_DILATE_R = 5;

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
 * preserving the photo's fabric shading.
 *
 * The tint is a pure per-channel multiply (target x shade), so the target hue
 * is EXACT everywhere; shade comes from the pixel luma normalized to the
 * garment white point (97th percentile, the build-assets.js definition),
 * contrast-stretched by SHADE_GAMMA and floored by SHADE_FLOOR. Specular
 * overshoot above the white point survives at reduced strength, and dark
 * targets get a small desaturated sheen on the brightest fabric (real dark
 * cotton does that; saturated colors get none, keeping their hue clean).
 * The blend mask is the garment mask DILATED a few pixels and re-feathered,
 * so shadowed silhouette edges the mask undershoots still get tinted instead
 * of staying cream. Background pixels pass through untouched.
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
  // Dark targets earn sheen; saturated mid colors (high max channel) get none.
  const darkness = 1 - Math.max(target.r, target.g, target.b) / 255;
  const sheenScale = SHEEN_MAX * darkness * darkness;

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

  // Blend mask: dilate the garment alpha so shadowed edge slivers the mask
  // missed still get tinted, then re-feather the dilated edge.
  const maskGray = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) maskGray[i] = maskData[i * 4 + 3]!;
  const dilate = (src: Buffer, r: number): Buffer => {
    const tmp = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
          if (src[y * w + k]! > v) v = src[y * w + k]!;
        }
        tmp[y * w + x] = v;
      }
    }
    const dst = Buffer.alloc(w * h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let v = 0;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
          if (tmp[k * w + x]! > v) v = tmp[k * w + x]!;
        }
        dst[y * w + x] = v;
      }
    }
    return dst;
  };
  const { data: blendAlpha } = await sharp(dilate(maskGray, MASK_DILATE_R), {
    raw: { width: w, height: h, channels: 1 },
  })
    .blur(2)
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Shade field from slightly blurred luma: photo noise in deep ribbing
  // shadows otherwise multiplies into blotches on saturated targets.
  const lumaBytes = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) {
    const l =
      0.2126 * data[i * 4]! + 0.7152 * data[i * 4 + 1]! + 0.0722 * data[i * 4 + 2]!;
    lumaBytes[i] = Math.max(0, Math.min(255, Math.round(l)));
  }
  const { data: luma } = await sharp(lumaBytes, { raw: { width: w, height: h, channels: 1 } })
    .blur(1)
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Garment white point: 97th percentile luma of solidly-masked pixels (same
  // sampling stride and percentile as build-assets.js so the two stay in sync).
  const lumaSamples: number[] = [];
  const backdropSamples: number[] = [];
  for (let i = 0; i < w * h; i += 7) {
    if (maskGray[i]! > 200) lumaSamples.push(luma[i]!);
    else if (maskGray[i] === 0) backdropSamples.push(luma[i]!);
  }
  if (lumaSamples.length === 0) {
    throw new Error('recolorGarment: mask selects no garment pixels');
  }
  lumaSamples.sort((a, b) => a - b);
  const whitePoint = Math.max(1, lumaSamples[Math.floor(lumaSamples.length * 0.97)]!);
  backdropSamples.sort((a, b) => a - b);
  const backdrop = backdropSamples[Math.floor(backdropSamples.length / 2)] ?? 0;
  // Midpoint between backdrop and garment brightness: the dilation ring tints
  // garment-bright pixels fully and backdrop-dark pixels not at all.
  const ringMid = Math.max(backdrop + 1, (backdrop + whitePoint) / 2);

  const out = Buffer.from(data);
  for (let i = 0; i < w * h; i++) {
    let alpha = blendAlpha[i]!;
    if (alpha === 0) continue;
    const original = maskData[i * 4 + 3]!;
    if (original < alpha) {
      // Dilation ring: only pixels that LOOK like lit fabric get the tint
      // (covers the cream slivers the mask undershot); backdrop-dark pixels
      // stay untouched so the dilation cannot paint a halo on the backdrop.
      const ringWeight = Math.min(1, Math.max(0, (luma[i]! - backdrop) / (ringMid - backdrop))) ** 2;
      alpha = Math.max(original, Math.round(alpha * ringWeight));
      if (alpha === 0) continue;
    }

    const relative = luma[i]! / whitePoint;
    let base = Math.min(1, relative);
    if (noise > 0) {
      // Deterministic per-pixel hash mapped to [-1, 1]; no Math.random so the
      // output is byte-stable across runs (seed idempotency depends on it).
      const hash = (((i * 2654435761) >>> 0) % 1000) / 1000;
      base = Math.min(1, Math.max(0, base + (hash * 2 - 1) * noise));
    }
    let shade = SHADE_FLOOR + (1 - SHADE_FLOOR) * base ** SHADE_GAMMA;
    if (relative > 1) shade += (relative - 1) * SPECULAR;
    const sheen = sheenScale * base ** 5;

    for (let c = 0; c < 3; c++) {
      const targetCh = c === 0 ? target.r : c === 1 ? target.g : target.b;
      const recolored = Math.min(255, targetCh * shade + (255 - targetCh) * sheen);
      // Feathered mask edge: blend recolor in proportionally to the mask alpha.
      const src = data[i * 4 + c]!;
      out[i * 4 + c] = Math.round(src + ((recolored - src) * alpha) / 255);
    }
  }

  return sharp(out, { raw: { width: w, height: h, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
