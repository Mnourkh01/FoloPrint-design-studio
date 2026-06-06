/**
 * Seeds the sample t-shirt template and generates its placeholder images with sharp.
 * Idempotent: re-running updates the same template and rewrites the images.
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

const BASE_SVG = `
<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CANVAS}" height="${CANVAS}" fill="#f4f1ec"/>
  <ellipse cx="500" cy="905" rx="330" ry="36" fill="#e7e2da"/>
  <path d="${TEE_BODY_PATH}" fill="#ffffff" stroke="#d9d4cb" stroke-width="3"/>
  <path d="M440 181 C455 217 545 217 560 181 C540 194 460 194 440 181 Z" fill="#ecebe7" stroke="#d9d4cb" stroke-width="2"/>
  <path d="M350 391 L258 432" stroke="#e6e2da" stroke-width="2" fill="none"/>
  <path d="M650 391 L742 432" stroke="#e6e2da" stroke-width="2" fill="none"/>
  <path d="M348 856 C455 882 545 882 652 856" stroke="#e6e2da" stroke-width="2" fill="none"/>
</svg>`;

const OVERLAY_SVG = `
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

async function generateTemplateImages(storageRoot: string): Promise<{ base: string; overlay: string }> {
  const templatesDir = join(storageRoot, 'templates');
  await mkdir(templatesDir, { recursive: true });

  const baseRel = 'templates/classic-tee-base.png';
  const overlayRel = 'templates/classic-tee-overlay.png';

  await sharp(Buffer.from(BASE_SVG)).png().toFile(join(storageRoot, baseRel));
  await sharp(Buffer.from(OVERLAY_SVG)).png().toFile(join(storageRoot, overlayRel));

  return { base: baseRel, overlay: overlayRel };
}

async function main(): Promise<void> {
  const storageRoot = resolve(process.env.STORAGE_ROOT ?? './storage');
  const images = await generateTemplateImages(storageRoot);

  const template = await prisma.productTemplate.upsert({
    where: { slug: 'classic-tee' },
    create: {
      name: 'Classic Tee',
      slug: 'classic-tee',
      baseImagePath: images.base,
      overlayImagePath: images.overlay,
      canvasWidth: CANVAS,
      canvasHeight: CANVAS,
      active: true,
    },
    update: {
      name: 'Classic Tee',
      baseImagePath: images.base,
      overlayImagePath: images.overlay,
      canvasWidth: CANVAS,
      canvasHeight: CANVAS,
      active: true,
    },
  });

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
    },
    update: { name: 'Front print', x: 370, y: 300, width: 260, height: 340, active: true },
  });

  console.log(`Seeded template "${template.name}" (${template.slug}) with front print area.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
