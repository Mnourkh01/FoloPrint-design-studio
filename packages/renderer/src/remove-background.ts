import sharp from 'sharp';

/** Defensive cap against pixel bombs reaching libvips (mirrors index.ts). */
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * How far (RGB euclidean) a pixel may sit from the sampled background color and
 * still be flood-filled away. Wide enough for JPEG noise and soft shadows on a
 * studio backdrop, narrow enough to stop at real artwork edges.
 */
const COLOR_TOLERANCE = 48;

/** Border pixels must agree on one color this tightly (per-channel stddev). */
const MAX_BORDER_STDDEV = 24;

/** Removal must be meaningful: under 2% means there was no background to remove. */
const MIN_REMOVED_FRACTION = 0.02;
/** Over 98% means the image IS the background (nothing would remain). */
const MAX_REMOVED_FRACTION = 0.98;

/** Raised when the image has no removable flat background; callers map it to a 4xx. */
export class FlatBackgroundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlatBackgroundError';
  }
}

export interface RemoveBackgroundResult {
  /** PNG with the background pixels turned transparent (1px feathered edge). */
  png: Buffer;
  /** Fraction of pixels removed, for diagnostics/UI copy. */
  removedFraction: number;
}

/**
 * Removes a FLAT background (logo on a white/solid box) by flood-filling from the
 * image border: every border-connected pixel within COLOR_TOLERANCE of the sampled
 * border color becomes transparent. Interior regions of the same color survive
 * (they are not border-connected), so text counters and enclosed shapes keep their
 * fill. Not an ML cutout: a busy/photographic background raises FlatBackgroundError.
 */
export async function removeFlatBackground(input: Buffer): Promise<RemoveBackgroundResult> {
  const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;

  // --- sample the border ring; it must agree on one color ---
  const borderIdx: number[] = [];
  for (let x = 0; x < w; x++) borderIdx.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) borderIdx.push(y * w, y * w + w - 1);

  let meanR = 0;
  let meanG = 0;
  let meanB = 0;
  for (const idx of borderIdx) {
    meanR += data[idx * 4]!;
    meanG += data[idx * 4 + 1]!;
    meanB += data[idx * 4 + 2]!;
  }
  meanR /= borderIdx.length;
  meanG /= borderIdx.length;
  meanB /= borderIdx.length;

  let varR = 0;
  let varG = 0;
  let varB = 0;
  for (const idx of borderIdx) {
    varR += (data[idx * 4]! - meanR) ** 2;
    varG += (data[idx * 4 + 1]! - meanG) ** 2;
    varB += (data[idx * 4 + 2]! - meanB) ** 2;
  }
  const worstStddev = Math.sqrt(Math.max(varR, varG, varB) / borderIdx.length);
  if (worstStddev > MAX_BORDER_STDDEV) {
    throw new FlatBackgroundError(
      'The image border is not a single flat color; background removal works on logos over a solid background.',
    );
  }

  // --- flood fill from the border over background-colored pixels ---
  const isBackgroundColor = (idx: number): boolean => {
    if (data[idx * 4 + 3]! < 16) return true; // already transparent
    const dr = data[idx * 4]! - meanR;
    const dg = data[idx * 4 + 1]! - meanG;
    const db = data[idx * 4 + 2]! - meanB;
    return dr * dr + dg * dg + db * db <= COLOR_TOLERANCE * COLOR_TOLERANCE;
  };

  const removed = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const push = (idx: number) => {
    if (!removed[idx] && isBackgroundColor(idx)) {
      removed[idx] = 1;
      queue[tail++] = idx;
    }
  };
  for (const idx of borderIdx) push(idx);
  while (head < tail) {
    const idx = queue[head++]!;
    const x = idx % w;
    const y = (idx / w) | 0;
    if (x > 0) push(idx - 1);
    if (x < w - 1) push(idx + 1);
    if (y > 0) push(idx - w);
    if (y < h - 1) push(idx + w);
  }

  const removedFraction = tail / (w * h);
  if (removedFraction < MIN_REMOVED_FRACTION) {
    throw new FlatBackgroundError('No removable background found around the artwork.');
  }
  if (removedFraction > MAX_REMOVED_FRACTION) {
    throw new FlatBackgroundError('Almost the whole image matches the background; nothing would remain.');
  }

  // --- apply: alpha 0 on removed pixels, 1px feather along the cut ---
  const removalGray = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) {
    if (removed[i]) removalGray[i] = 255;
  }
  // Single-band forced (b-w): sharp would otherwise emit 3-channel raw here.
  const { data: removalSoft } = await sharp(removalGray, { raw: { width: w, height: h, channels: 1 } })
    .blur(0.8)
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const out = Buffer.from(data);
  for (let i = 0; i < w * h; i++) {
    out[i * 4 + 3] = Math.min(out[i * 4 + 3]!, 255 - removalSoft[i]!);
  }

  const png = await sharp(out, { raw: { width: w, height: h, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return { png, removedFraction };
}
