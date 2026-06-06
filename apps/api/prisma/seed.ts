/**
 * Seeds the sample t-shirt template and generates its placeholder images with sharp.
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

const TEE_BODY_PATH =
  'M360 200 C410 178 450 172 500 172 C550 172 590 178 640 200 ' +
  'L815 305 L758 428 L662 385 L662 870 C560 898 440 898 338 870 ' +
  'L338 385 L242 428 L185 305 Z';

const FRONT_BASE_SVG = `
<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CANVAS}" height="${CANVAS}" fill="#f4f1ec"/>
  <ellipse cx="500" cy="905" rx="330" ry="36" fill="#e7e2da"/>
  <path d="${TEE_BODY_PATH}" fill="#ffffff" stroke="#d9d4cb" stroke-width="3"/>
  <path d="M440 181 C455 217 545 217 560 181 C540 194 460 194 440 181 Z" fill="#ecebe7" stroke="#d9d4cb" stroke-width="2"/>
  <path d="M350 391 L258 432" stroke="#e6e2da" stroke-width="2" fill="none"/>
  <path d="M650 391 L742 432" stroke="#e6e2da" stroke-width="2" fill="none"/>
  <path d="M348 856 C455 882 545 882 652 856" stroke="#e6e2da" stroke-width="2" fill="none"/>
</svg>`;

const FRONT_OVERLAY_SVG = `
<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#2b2620" stop-opacity="0.06"/>
    </linearGradient>
  </defs>
  <path d="${TEE_BODY_PATH}" fill="url(#sheen)"/>
  <path d="M662 420 C672 560 668 720 662 850" stroke="#2b2620" stroke-opacity="0.05" stroke-width="14" fill="none"/>
  <path d="M338 420 C328 560 332 720 338 850" stroke="#ffffff" stroke-opacity="0.10" stroke-width="14" fill="none"/>
</svg>`;

// Back view: same silhouette, high straight neckline (no front collar dip), a center
// back seam, and a small neck label so front/back previews are visually distinct.
const BACK_BASE_SVG = `
<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CANVAS}" height="${CANVAS}" fill="#f1f3f0"/>
  <ellipse cx="500" cy="905" rx="330" ry="36" fill="#e2e6e1"/>
  <path d="${TEE_BODY_PATH}" fill="#fcfcfb" stroke="#d3d7d0" stroke-width="3"/>
  <path d="M452 184 C470 196 530 196 548 184 C535 191 465 191 452 184 Z" fill="#e9ece8" stroke="#d3d7d0" stroke-width="2"/>
  <rect x="478" y="206" width="44" height="26" rx="3" fill="#f4f4f2" stroke="#d3d7d0" stroke-width="1.5"/>
  <path d="M500 240 L500 860" stroke="#e3e7e2" stroke-width="2" fill="none"/>
  <path d="M350 391 L258 432" stroke="#e3e7e2" stroke-width="2" fill="none"/>
  <path d="M650 391 L742 432" stroke="#e3e7e2" stroke-width="2" fill="none"/>
  <path d="M348 856 C455 882 545 882 652 856" stroke="#e3e7e2" stroke-width="2" fill="none"/>
</svg>`;

const BACK_OVERLAY_SVG = `
<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sheenBack" x1="1" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.14"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#23282b" stop-opacity="0.06"/>
    </linearGradient>
  </defs>
  <path d="${TEE_BODY_PATH}" fill="url(#sheenBack)"/>
  <path d="M662 420 C672 560 668 720 662 850" stroke="#23282b" stroke-opacity="0.05" stroke-width="14" fill="none"/>
  <path d="M338 420 C328 560 332 720 338 850" stroke="#ffffff" stroke-opacity="0.10" stroke-width="14" fill="none"/>
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
