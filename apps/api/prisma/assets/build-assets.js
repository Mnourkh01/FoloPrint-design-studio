/**
 * Derives mask / overlay / thumb from a product's blank photos
 * (<slug>-front.png / <slug>-back.png in the given directory).
 *
 * Mask: BFS flood-fill from the image border over background-like pixels
 * (luma below threshold); everything unreached is garment. Holes inside the
 * garment can't be reached from the border, so they stay garment automatically.
 * Largest-component filter drops background speckles.
 *
 * Overlay: garment luminance normalized to its white point, gray PNG with the
 * garment mask as alpha. Composited with 'multiply' it re-applies the photo's
 * fabric folds over flat design ink.
 *
 * Run: node build-assets.js <assetsDir> <slug> [lumaThreshold=200]
 * e.g. node apps/api/prisma/assets/build-assets.js apps/api/prisma/assets/classic-tee classic-tee 200
 */
const sharp = require('sharp');
const { join } = require('node:path');

const dir = process.argv[2];
const SLUG = process.argv[3];
const THRESHOLD = Number(process.argv[4] ?? 200);

if (!dir || !SLUG) {
  console.error('usage: node build-assets.js <assetsDir> <slug> [lumaThreshold=200]');
  process.exit(1);
}

async function buildSide(side) {
  const srcPath = join(dir, `${SLUG}-${side}.png`);
  const { data, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;

  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    luma[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  }

  // --- background flood fill from every border pixel ---
  const bg = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const push = (idx) => {
    if (!bg[idx] && luma[idx] < THRESHOLD) {
      bg[idx] = 1;
      queue[tail++] = idx;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % w;
    const y = (idx / w) | 0;
    if (x > 0) push(idx - 1);
    if (x < w - 1) push(idx + 1);
    if (y > 0) push(idx - w);
    if (y < h - 1) push(idx + w);
  }

  // --- garment = not background; keep only the largest connected component ---
  const label = new Int32Array(w * h).fill(-1);
  let bestLabel = -1;
  let bestSize = 0;
  let nextLabel = 0;
  for (let start = 0; start < w * h; start++) {
    if (bg[start] || label[start] !== -1) continue;
    let size = 0;
    let qh = 0;
    let qt = 0;
    queue[qt++] = start;
    label[start] = nextLabel;
    while (qh < qt) {
      const idx = queue[qh++];
      size++;
      const x = idx % w;
      const y = (idx / w) | 0;
      for (const n of [x > 0 ? idx - 1 : -1, x < w - 1 ? idx + 1 : -1, y > 0 ? idx - w : -1, y < h - 1 ? idx + w : -1]) {
        if (n >= 0 && !bg[n] && label[n] === -1) {
          label[n] = nextLabel;
          queue[qt++] = n;
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = nextLabel;
    }
    nextLabel++;
  }

  let maskGray = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!bg[i] && label[i] === bestLabel) maskGray[i] = 255;
  }

  // Pixels the flood fill confidently identified as garment (pre-mirror): the
  // overlay only trusts these for fabric luminance; mirrored overreach gets a
  // neutral (no-op) multiply value instead of darkening the background.
  const litMask = Buffer.from(maskGray);

  // Mirror-union: the lit (left) edge detects cleanly while the shadowed right
  // edge erodes. The garment is near-symmetric, so union the mask with its own
  // mirror around the garment centerline (estimated from the well-detected
  // shoulder rows). Slight overreach into background is invisible; ink holes are not.
  {
    let top = h;
    for (let i = 0; i < w * h; i++) {
      if (maskGray[i]) {
        top = (i / w) | 0;
        break;
      }
    }
    let centerSum = 0;
    let centerRows = 0;
    for (let y = top; y < Math.min(h, top + Math.round(h * 0.12)); y++) {
      let first = -1;
      let last = -1;
      for (let x = 0; x < w; x++) {
        if (maskGray[y * w + x]) {
          if (first === -1) first = x;
          last = x;
        }
      }
      if (first !== -1) {
        centerSum += (first + last) / 2;
        centerRows++;
      }
    }
    if (centerRows > 0) {
      const cx = Math.round(centerSum / centerRows);
      const mirrored = Buffer.from(maskGray);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (maskGray[y * w + x]) {
            const mx = 2 * cx - x;
            if (mx >= 0 && mx < w) mirrored[y * w + mx] = 255;
          }
        }
      }
      maskGray = mirrored;
    }
  }

  // Binary closing (dilate then erode, separable box max/min): seals the thin
  // shadow cracks the flood fill cuts into the garment along deep folds, without
  // moving the outer silhouette.
  const CLOSE_R = 9;
  const boxPass = (src, op) => {
    const tmp = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = op === 'max' ? 0 : 255;
        for (let k = Math.max(0, x - CLOSE_R); k <= Math.min(w - 1, x + CLOSE_R); k++) {
          const s = src[y * w + k];
          v = op === 'max' ? Math.max(v, s) : Math.min(v, s);
        }
        tmp[y * w + x] = v;
      }
    }
    const dst = Buffer.alloc(w * h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let v = op === 'max' ? 0 : 255;
        for (let k = Math.max(0, y - CLOSE_R); k <= Math.min(h - 1, y + CLOSE_R); k++) {
          const s = tmp[k * w + x];
          v = op === 'max' ? Math.max(v, s) : Math.min(v, s);
        }
        dst[y * w + x] = v;
      }
    }
    return dst;
  };
  maskGray = boxPass(boxPass(maskGray, 'max'), 'min');

  let garmentPx = 0;
  let minX = w, maxX = 0, minY = h, maxY = 0;
  for (let i = 0; i < w * h; i++) {
    if (maskGray[i]) {
      garmentPx++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // Feathered alpha: 1px blur so the cut edge isn't aliased. Force single-band
  // output (toColourspace b-w): sharp otherwise emits 3-channel raw and the
  // joinChannel below would misread the stride.
  const { data: alpha, info: alphaInfo } = await sharp(maskGray, { raw: { width: w, height: h, channels: 1 } })
    .blur(1)
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (alphaInfo.channels !== 1 || alpha.length !== w * h) {
    throw new Error(`alpha buffer mismatch: ${alphaInfo.channels}ch len ${alpha.length}, want 1ch len ${w * h}`);
  }

  await sharp({ create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .joinChannel(alpha, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toFile(join(dir, `${SLUG}-${side}-mask.png`));

  // --- multiply overlay: luminance / white point, alpha = garment mask ---
  const lumaSamples = [];
  for (let i = 0; i < w * h; i += 7) {
    if (maskGray[i]) lumaSamples.push(luma[i]);
  }
  lumaSamples.sort((a, b) => a - b);
  const whitePoint = lumaSamples[Math.floor(lumaSamples.length * 0.97)];

  const overlayGray = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) {
    // Real garment pixels carry the fabric shading; everything else multiplies
    // by 255 (no-op) so mirrored mask overreach never darkens the backdrop.
    // The lift (0.35 + 0.65x) softens deep folds: the base photo already shows
    // them at full strength, the overlay only re-suggests them over the ink.
    // Full-strength folds would double-darken into smears.
    const scaled = Math.min(1, luma[i] / whitePoint);
    overlayGray[i] = litMask[i] ? Math.round((0.35 + 0.65 * scaled) * 255) : 255;
  }
  // Slight blur de-speckles the flood-fill crack edges in the shading.
  const { data: overlaySoft } = await sharp(overlayGray, { raw: { width: w, height: h, channels: 1 } })
    .blur(1.5)
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  await sharp(overlaySoft, { raw: { width: w, height: h, channels: 1 } })
    .toColourspace('srgb')
    .joinChannel(alpha, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toFile(join(dir, `${SLUG}-${side}-overlay.png`));

  // --- thumb (512: crisp on ~400px cards and small tabs alike) ---
  await sharp(srcPath).resize(512, 512).png().toFile(join(dir, `${SLUG}-${side}-thumb.png`));

  console.log(
    JSON.stringify({
      side,
      threshold: THRESHOLD,
      garmentCoverage: +(garmentPx / (w * h)).toFixed(3),
      bboxPx: { minX, maxX, minY, maxY },
      bboxRel: {
        x: +(minX / w).toFixed(3),
        y: +(minY / h).toFixed(3),
        w: +((maxX - minX) / w).toFixed(3),
        h: +((maxY - minY) / h).toFixed(3),
      },
      whitePoint: Math.round(whitePoint),
    }),
  );
}

(async () => {
  await buildSide('front');
  await buildSide('back');
})();
