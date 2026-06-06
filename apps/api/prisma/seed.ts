/**
 * Seeds the sample t-shirt template and generates its mockup images with sharp
 * (layered SVG: silhouette, collar ribbing, seams, fabric shading, weave texture).
 * Idempotent: re-running updates the same template and rewrites the images.
 *
 * Two physical views: the template-level images show the FRONT of the tee; the back
 * print area carries its own base/overlay images (back view). The front area keeps
 * null image paths on purpose so the template-level fallback path stays exercised.
 */
import { PrismaClient } from '@prisma/client';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const prisma = new PrismaClient();

const CANVAS = 1000;

/**
 * Garment silhouette, symmetric around x=500, drawn large (~75% of the canvas) so the
 * product dominates the editor stage. The neck closing segment differs between the
 * front view (deep scoop) and the back view (shallow collar arc); everything else is
 * shared. Print areas (front 370,300 260x340 / back 370,260 260x380) sit on the chest
 * and upper back of this body with realistic margins: a 12 inch print on a ~19 inch
 * wide garment.
 */
const TEE_BODY_COMMON =
  'M432 194 C392 199 352 205 322 214 C284 226 244 264 212 318 L246 424 ' +
  'C250 434 260 438 270 434 L308 390 ' +
  'C300 450 294 520 292 580 C290 690 294 800 298 858 ' +
  'C380 876 620 876 702 858 ' +
  'C706 800 710 690 708 580 C706 520 700 450 692 390 ' +
  'L730 434 C740 438 750 434 754 424 L788 318 ' +
  'C756 264 716 226 678 214 C648 205 608 199 568 194 ';

const FRONT_BODY = `${TEE_BODY_COMMON}C548 246 452 246 432 194 Z`;
const BACK_BODY = `${TEE_BODY_COMMON}C545 180 455 180 432 194 Z`;

/** Shared SVG defs: backdrop, fabric gradients, weave pattern, blur filters, body clip. */
function teeDefs(bodyPath: string, bgInner: string, bgOuter: string): string {
  return `
  <defs>
    <radialGradient id="bgGlow" cx="0.5" cy="0.38" r="0.78">
      <stop offset="0" stop-color="${bgInner}"/>
      <stop offset="1" stop-color="${bgOuter}"/>
    </radialGradient>
    <linearGradient id="fabric" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.55" stop-color="#fbfaf8"/>
      <stop offset="1" stop-color="#f2f0ec"/>
    </linearGradient>
    <radialGradient id="chestLight" cx="0.5" cy="0.34" r="0.5">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.8"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="neckInterior" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#c6c1b9"/>
      <stop offset="1" stop-color="#e8e5df"/>
    </linearGradient>
    <pattern id="weave" width="4" height="4" patternUnits="userSpaceOnUse">
      <path d="M0 4 L4 0" stroke="#5b5650" stroke-opacity="0.03" stroke-width="0.7"/>
      <path d="M0 0 L4 4" stroke="#ffffff" stroke-opacity="0.05" stroke-width="0.7"/>
    </pattern>
    <filter id="b8" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="8"/></filter>
    <filter id="b14" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="14"/></filter>
    <clipPath id="bodyClip"><path d="${bodyPath}"/></clipPath>
  </defs>`;
}

/**
 * Fabric shading painted inside the garment clip, shared by both views: chest light,
 * side seam and armhole inner shadows, sleeve undersides, soft lower-torso folds,
 * hem shadow, and the weave texture on top.
 */
const TEE_BODY_SHADING = `
    <rect width="1000" height="1000" fill="url(#chestLight)"/>
    <path d="M310 392 C298 520 294 700 302 860" stroke="#8a8378" stroke-opacity="0.18" stroke-width="28" fill="none" filter="url(#b8)"/>
    <path d="M690 392 C702 520 706 700 698 860" stroke="#8a8378" stroke-opacity="0.18" stroke-width="28" fill="none" filter="url(#b8)"/>
    <path d="M308 390 C348 350 352 282 326 222" stroke="#857e74" stroke-opacity="0.18" stroke-width="16" fill="none" filter="url(#b8)"/>
    <path d="M692 390 C652 350 648 282 674 222" stroke="#857e74" stroke-opacity="0.18" stroke-width="16" fill="none" filter="url(#b8)"/>
    <path d="M230 360 C240 400 254 424 266 432" stroke="#857e74" stroke-opacity="0.15" stroke-width="18" fill="none" filter="url(#b8)"/>
    <path d="M770 360 C760 400 746 424 734 432" stroke="#857e74" stroke-opacity="0.15" stroke-width="18" fill="none" filter="url(#b8)"/>
    <path d="M360 620 C372 700 370 790 364 852" stroke="#8a8378" stroke-opacity="0.12" stroke-width="12" fill="none" filter="url(#b8)"/>
    <path d="M640 600 C632 690 636 780 640 852" stroke="#8a8378" stroke-opacity="0.11" stroke-width="12" fill="none" filter="url(#b8)"/>
    <path d="M460 660 C464 740 462 800 460 856" stroke="#8a8378" stroke-opacity="0.08" stroke-width="10" fill="none" filter="url(#b8)"/>
    <path d="M545 645 C548 730 546 800 544 854" stroke="#ffffff" stroke-opacity="0.30" stroke-width="8" fill="none" filter="url(#b8)"/>
    <path d="M305 850 C392 872 608 872 695 850" stroke="#8a8378" stroke-opacity="0.15" stroke-width="14" fill="none" filter="url(#b8)"/>
    <rect width="1000" height="1000" fill="url(#weave)"/>`;

/** Crisp construction lines shared by both views: armhole seams, sleeve and bottom hems. */
const TEE_BODY_SEAMS = `
  <path d="M326 220 C352 282 348 350 308 390" stroke="#d8d3cb" stroke-width="2" fill="none"/>
  <path d="M674 220 C648 282 652 350 692 390" stroke="#d8d3cb" stroke-width="2" fill="none"/>
  <path d="M262 427 L300 383 M257 423 L295 379" stroke="#dcd7cf" stroke-width="1.6" fill="none"/>
  <path d="M738 427 L700 383 M743 423 L705 379" stroke="#dcd7cf" stroke-width="1.6" fill="none"/>
  <path d="M302 845 C382 863 618 863 698 845" stroke="#dcd7cf" stroke-width="1.6" fill="none"/>
  <path d="M303 838 C383 856 617 856 697 838" stroke="#dcd7cf" stroke-width="1.6" fill="none"/>`;

const FRONT_BASE_SVG = `
<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">
  ${teeDefs(FRONT_BODY, '#fbfaf7', '#ece8e1')}
  <rect width="1000" height="1000" fill="url(#bgGlow)"/>
  <ellipse cx="500" cy="888" rx="320" ry="26" fill="#3f3a33" opacity="0.20" filter="url(#b14)"/>
  <path d="${FRONT_BODY}" fill="url(#fabric)" stroke="#d4cfc7" stroke-width="2"/>
  <g clip-path="url(#bodyClip)">${TEE_BODY_SHADING}
    <path d="M440 206 C462 250 538 250 560 206" stroke="#6f695f" stroke-opacity="0.18" stroke-width="15" fill="none" filter="url(#b8)"/>
  </g>
  ${TEE_BODY_SEAMS}
  <path d="M432 194 L324 214 M568 194 L676 214" stroke="#d8d3cb" stroke-width="2"/>
  <path d="M432 194 C450 181 550 181 568 194 C548 246 452 246 432 194 Z" fill="url(#neckInterior)" stroke="#c9c4bc" stroke-width="1.5"/>
  <path d="M432 194 C452 246 548 246 568 194 L556 200 C541 238 459 238 444 200 Z" fill="#f5f3f0" stroke="#d4cfc7" stroke-width="1.2"/>
  <path d="M437 197 C455 242 545 242 563 197" stroke="#c2bcb2" stroke-opacity="0.55" stroke-width="11" stroke-dasharray="1.2 2.2" fill="none"/>
  <path d="M444 200 C459 238 541 238 556 200" stroke="#d0cbc3" stroke-width="1" fill="none"/>
</svg>`;

/**
 * Overlays composite ABOVE the artwork (renderer and editor both): a garment-clipped
 * sheen plus low-opacity wrinkle shadows crossing the print zone, so prints read as
 * ink on fabric instead of a floating sticker. Nothing inside the print area exceeds
 * ~8% opacity; print colors stay faithful.
 */
const FRONT_OVERLAY_SVG = `
<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.09"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#2b2620" stop-opacity="0.05"/>
    </linearGradient>
    <filter id="b8" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="8"/></filter>
    <filter id="b10" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="10"/></filter>
    <clipPath id="bodyClip"><path d="${FRONT_BODY}"/></clipPath>
  </defs>
  <g clip-path="url(#bodyClip)">
    <path d="${FRONT_BODY}" fill="url(#sheen)"/>
    <path d="M330 470 C440 488 560 482 672 462" stroke="#6b6459" stroke-opacity="0.05" stroke-width="16" fill="none" filter="url(#b10)"/>
    <path d="M326 570 C446 590 556 584 676 566" stroke="#6b6459" stroke-opacity="0.04" stroke-width="14" fill="none" filter="url(#b10)"/>
    <path d="M334 520 C450 538 556 532 668 514" stroke="#ffffff" stroke-opacity="0.05" stroke-width="10" fill="none" filter="url(#b8)"/>
    <path d="M312 420 C302 540 298 700 304 866" stroke="#6b6459" stroke-opacity="0.08" stroke-width="18" fill="none" filter="url(#b10)"/>
    <path d="M688 420 C698 540 702 700 696 866" stroke="#6b6459" stroke-opacity="0.08" stroke-width="18" fill="none" filter="url(#b10)"/>
    <path d="M440 208 C462 252 538 252 560 208" stroke="#6f695f" stroke-opacity="0.10" stroke-width="14" fill="none" filter="url(#b8)"/>
    <path d="M304 852 C394 874 606 874 696 852" stroke="#6f695f" stroke-opacity="0.07" stroke-width="12" fill="none" filter="url(#b8)"/>
  </g>
</svg>`;

// Back view: same silhouette with a shallow collar arc, ribbed band, a neck label,
// and a faint center crease so front/back previews are visually distinct.
const BACK_BASE_SVG = `
<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">
  ${teeDefs(BACK_BODY, '#f8faf7', '#e7eae5')}
  <rect width="1000" height="1000" fill="url(#bgGlow)"/>
  <ellipse cx="500" cy="888" rx="320" ry="26" fill="#363b36" opacity="0.20" filter="url(#b14)"/>
  <path d="${BACK_BODY}" fill="url(#fabric)" stroke="#d2d6cf" stroke-width="2"/>
  <g clip-path="url(#bodyClip)">${TEE_BODY_SHADING}
    <path d="M500 320 C503 480 498 650 500 856" stroke="#8a8378" stroke-opacity="0.06" stroke-width="10" fill="none" filter="url(#b8)"/>
  </g>
  ${TEE_BODY_SEAMS}
  <path d="M432 194 L324 214 M568 194 L676 214" stroke="#d6dad3" stroke-width="2"/>
  <path d="M432 194 C455 181 545 181 568 194 L560 202 C536 190 464 190 440 202 Z" fill="#f3f1ee" stroke="#d2d6cf" stroke-width="1.2"/>
  <path d="M436 198 C460 186 540 186 564 198" stroke="#b9bdb6" stroke-opacity="0.55" stroke-width="9" stroke-dasharray="1.2 2.2" fill="none"/>
  <path d="M440 202 C464 190 536 190 560 202" stroke="#ced2cb" stroke-width="1" fill="none"/>
  <rect x="477" y="210" width="46" height="30" rx="3" fill="#fbfaf8" stroke="#d2d6cf" stroke-width="1.5"/>
  <path d="M484 222 L516 222 M484 229 L510 229" stroke="#cfd3cc" stroke-width="1.5"/>
</svg>`;

const BACK_OVERLAY_SVG = `
<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sheenBack" x1="1" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.08"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#23282b" stop-opacity="0.05"/>
    </linearGradient>
    <filter id="b8" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="8"/></filter>
    <filter id="b10" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="10"/></filter>
    <clipPath id="bodyClip"><path d="${BACK_BODY}"/></clipPath>
  </defs>
  <g clip-path="url(#bodyClip)">
    <path d="${BACK_BODY}" fill="url(#sheenBack)"/>
    <path d="M330 430 C440 446 560 440 670 424" stroke="#5f6459" stroke-opacity="0.05" stroke-width="16" fill="none" filter="url(#b10)"/>
    <path d="M326 540 C446 558 560 552 676 534" stroke="#5f6459" stroke-opacity="0.04" stroke-width="14" fill="none" filter="url(#b10)"/>
    <path d="M500 300 C503 460 498 640 500 850" stroke="#5f6459" stroke-opacity="0.04" stroke-width="12" fill="none" filter="url(#b10)"/>
    <path d="M312 420 C302 540 298 700 304 866" stroke="#5f6459" stroke-opacity="0.08" stroke-width="18" fill="none" filter="url(#b10)"/>
    <path d="M688 420 C698 540 702 700 696 866" stroke="#5f6459" stroke-opacity="0.08" stroke-width="18" fill="none" filter="url(#b10)"/>
    <path d="M304 852 C394 874 606 874 696 852" stroke="#5f6459" stroke-opacity="0.07" stroke-width="12" fill="none" filter="url(#b8)"/>
  </g>
</svg>`;

interface TemplateImages {
  frontBase: string;
  frontOverlay: string;
  backBase: string;
  backOverlay: string;
}

async function generateTemplateImages(storageRoot: string): Promise<TemplateImages> {
  const templatesDir = join(storageRoot, 'templates');
  await mkdir(templatesDir, { recursive: true });

  const images: TemplateImages = {
    frontBase: 'templates/classic-tee-base.png',
    frontOverlay: 'templates/classic-tee-overlay.png',
    backBase: 'templates/classic-tee-back-base.png',
    backOverlay: 'templates/classic-tee-back-overlay.png',
  };

  await sharp(Buffer.from(FRONT_BASE_SVG)).png().toFile(join(storageRoot, images.frontBase));
  await sharp(Buffer.from(FRONT_OVERLAY_SVG)).png().toFile(join(storageRoot, images.frontOverlay));
  await sharp(Buffer.from(BACK_BASE_SVG)).png().toFile(join(storageRoot, images.backBase));
  await sharp(Buffer.from(BACK_OVERLAY_SVG)).png().toFile(join(storageRoot, images.backOverlay));

  return images;
}

async function main(): Promise<void> {
  const storageRoot = resolve(process.env.STORAGE_ROOT ?? './storage');
  const images = await generateTemplateImages(storageRoot);

  const template = await prisma.productTemplate.upsert({
    where: { slug: 'classic-tee' },
    create: {
      name: 'Classic Tee',
      slug: 'classic-tee',
      baseImagePath: images.frontBase,
      overlayImagePath: images.frontOverlay,
      canvasWidth: CANVAS,
      canvasHeight: CANVAS,
      active: true,
    },
    update: {
      name: 'Classic Tee',
      baseImagePath: images.frontBase,
      overlayImagePath: images.frontOverlay,
      canvasWidth: CANVAS,
      canvasHeight: CANVAS,
      active: true,
    },
  });

  // Front: null image paths on purpose -> falls back to the template-level images.
  await prisma.printArea.upsert({
    where: { productTemplateId_key: { productTemplateId: template.id, key: 'front' } },
    create: {
      productTemplateId: template.id,
      key: 'front',
      name: 'Front print',
      x: 370,
      y: 300,
      width: 260,
      height: 340,
      // Physical print size (inches), aspect-consistent with the 260x340 canvas rect.
      widthInches: 12,
      heightInches: 15.7,
      active: true,
      sortOrder: 0,
      baseImagePath: null,
      overlayImagePath: null,
    },
    update: {
      name: 'Front print',
      x: 370,
      y: 300,
      width: 260,
      height: 340,
      widthInches: 12,
      heightInches: 15.7,
      active: true,
      sortOrder: 0,
      baseImagePath: null,
      overlayImagePath: null,
    },
  });

  // Back: own view images (the back of the shirt is a different photo).
  await prisma.printArea.upsert({
    where: { productTemplateId_key: { productTemplateId: template.id, key: 'back' } },
    create: {
      productTemplateId: template.id,
      key: 'back',
      name: 'Back print',
      x: 370,
      y: 260,
      width: 260,
      height: 380,
      // Physical print size (inches), aspect-consistent with the 260x380 canvas rect.
      widthInches: 12,
      heightInches: 17.5,
      active: true,
      sortOrder: 1,
      baseImagePath: images.backBase,
      overlayImagePath: images.backOverlay,
    },
    update: {
      name: 'Back print',
      x: 370,
      y: 260,
      width: 260,
      height: 380,
      widthInches: 12,
      heightInches: 17.5,
      active: true,
      sortOrder: 1,
      baseImagePath: images.backBase,
      overlayImagePath: images.backOverlay,
    },
  });

  console.log(`Seeded template "${template.name}" (${template.slug}) with front and back print areas.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
