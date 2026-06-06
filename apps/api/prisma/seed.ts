/**
 * Seeds the Classic Tee template from the checked-in photo assets
 * (prisma/assets/classic-tee): AI-generated ghost-mannequin blanks plus the
 * derived garment masks, multiply overlays, and card thumbs built from them.
 * Idempotent: re-running updates the same template and re-copies the files.
 *
 * Two physical views: the template-level images show the FRONT of the tee; the back
 * print area carries its own base/overlay/mask/thumb (back view). The front area keeps
 * null image paths on purpose so the template-level fallback path stays exercised.
 *
 * The overlay carries the photo's fabric shading normalized to the garment white
 * point, so it composites with 'multiply' (re-applies folds over the printed ink);
 * the mask clips ink to the garment silhouette.
 */
import { PrismaClient } from '@prisma/client';
import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const prisma = new PrismaClient();

/** Native pixel size of the checked-in photo assets (square). */
const CANVAS = 1254;

/** Source directory of the checked-in assets, relative to this file. */
const ASSETS_DIR = join(__dirname, 'assets', 'classic-tee');

const FILES = [
  'classic-tee-front.png',
  'classic-tee-front-mask.png',
  'classic-tee-front-overlay.png',
  'classic-tee-front-thumb.png',
  'classic-tee-back.png',
  'classic-tee-back-mask.png',
  'classic-tee-back-overlay.png',
  'classic-tee-back-thumb.png',
] as const;

async function copyTemplateAssets(storageRoot: string): Promise<void> {
  await mkdir(join(storageRoot, 'templates'), { recursive: true });
  for (const file of FILES) {
    await copyFile(join(ASSETS_DIR, file), join(storageRoot, 'templates', file));
  }
}

async function main(): Promise<void> {
  const storageRoot = resolve(process.env.STORAGE_ROOT ?? './storage');
  await copyTemplateAssets(storageRoot);

  const templateImages = {
    baseImagePath: 'templates/classic-tee-front.png',
    overlayImagePath: 'templates/classic-tee-front-overlay.png',
    maskImagePath: 'templates/classic-tee-front-mask.png',
    thumbImagePath: 'templates/classic-tee-front-thumb.png',
    overlayBlend: 'multiply',
  };

  const template = await prisma.productTemplate.upsert({
    where: { slug: 'classic-tee' },
    create: {
      name: 'Classic Tee',
      slug: 'classic-tee',
      ...templateImages,
      canvasWidth: CANVAS,
      canvasHeight: CANVAS,
      active: true,
    },
    update: {
      name: 'Classic Tee',
      ...templateImages,
      canvasWidth: CANVAS,
      canvasHeight: CANVAS,
      active: true,
    },
  });

  // Print areas sit on the chest / upper back of the photographed garment
  // (torso spans ~x 340..920, centerline x 627 at this canvas size): a 12 inch
  // print on a ~19 inch wide tee, like the DTG platen it models.

  // Front: null image paths on purpose -> falls back to the template-level images.
  const frontSpec = {
    name: 'Front print',
    x: 427,
    y: 400,
    width: 400,
    height: 520,
    // Physical print size (inches), aspect-consistent with the 400x520 canvas rect.
    widthInches: 12,
    heightInches: 15.6,
    active: true,
    sortOrder: 0,
    baseImagePath: null,
    overlayImagePath: null,
    maskImagePath: null,
    thumbImagePath: null,
    overlayBlend: null,
  };
  await prisma.printArea.upsert({
    where: { productTemplateId_key: { productTemplateId: template.id, key: 'front' } },
    create: { productTemplateId: template.id, key: 'front', ...frontSpec },
    update: frontSpec,
  });

  // Back: own view images (the back of the shirt is a different photo).
  const backSpec = {
    name: 'Back print',
    x: 427,
    y: 360,
    width: 400,
    height: 560,
    // Physical print size (inches), aspect-consistent with the 400x560 canvas rect.
    widthInches: 12,
    heightInches: 16.8,
    active: true,
    sortOrder: 1,
    baseImagePath: 'templates/classic-tee-back.png',
    overlayImagePath: 'templates/classic-tee-back-overlay.png',
    maskImagePath: 'templates/classic-tee-back-mask.png',
    thumbImagePath: 'templates/classic-tee-back-thumb.png',
    overlayBlend: null, // template-level 'multiply' applies
  };
  await prisma.printArea.upsert({
    where: { productTemplateId_key: { productTemplateId: template.id, key: 'back' } },
    create: { productTemplateId: template.id, key: 'back', ...backSpec },
    update: backSpec,
  });

  console.log(`Seeded template "${template.name}" (${template.slug}) with front and back print areas.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
