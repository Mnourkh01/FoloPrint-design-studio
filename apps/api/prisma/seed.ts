/**
 * Seeds the product templates from the checked-in photo assets
 * (prisma/assets/<slug>): AI-generated ghost-mannequin blanks plus the derived
 * garment masks, multiply overlays, and card thumbs built from them by
 * prisma/assets/build-assets.js. Idempotent: re-running updates the same
 * templates and re-copies the files.
 *
 * Per template, two physical views: the template-level images show the FRONT of
 * the garment; the back print area carries its own base/overlay/mask/thumb (back
 * view). The front area keeps null image paths on purpose so the template-level
 * fallback path stays exercised.
 *
 * The overlay carries the photo's fabric shading normalized to the garment white
 * point, so it composites with 'multiply' (re-applies folds over the printed ink);
 * the mask clips ink to the garment silhouette.
 */
import { PrismaClient } from '@prisma/client';
import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const prisma = new PrismaClient();

interface AreaSpec {
  key: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  widthInches: number;
  heightInches: number;
  sortOrder: number;
  /** True for the back area: it carries its own view files instead of the fallback. */
  ownImages: boolean;
}

interface TemplateSpec {
  slug: string;
  name: string;
  /** Native pixel size of the checked-in square photo assets. */
  canvas: number;
  areas: AreaSpec[];
}

/**
 * Print areas sit on the chest / upper back of each photographed garment,
 * measured from its mask bbox (build-assets.js prints it): a 12 inch print
 * centered on the torso, like the DTG platen it models.
 */
const TEMPLATES: TemplateSpec[] = [
  {
    slug: 'classic-tee',
    name: 'Classic Tee',
    canvas: 1254,
    areas: [
      // Torso spans ~x 340..920, centerline x 627.
      { key: 'front', name: 'Front print', x: 427, y: 400, width: 400, height: 520, widthInches: 12, heightInches: 15.6, sortOrder: 0, ownImages: false },
      { key: 'back', name: 'Back print', x: 427, y: 360, width: 400, height: 560, widthInches: 12, heightInches: 16.8, sortOrder: 1, ownImages: true },
    ],
  },
  {
    slug: 'classic-sweatshirt',
    name: 'Classic Sweatshirt',
    canvas: 1254,
    areas: [
      // Garment bbox ~x 174..1082, centerline x 628; uniform 35 px/in.
      { key: 'front', name: 'Front print', x: 418, y: 380, width: 420, height: 525, widthInches: 12, heightInches: 15, sortOrder: 0, ownImages: false },
      { key: 'back', name: 'Back print', x: 418, y: 340, width: 420, height: 560, widthInches: 12, heightInches: 16, sortOrder: 1, ownImages: true },
    ],
  },
];

async function seedTemplate(storageRoot: string, spec: TemplateSpec): Promise<void> {
  const assetsDir = join(__dirname, 'assets', spec.slug);
  const files = ['', '-mask', '-overlay', '-thumb'].flatMap((suffix) => [
    `${spec.slug}-front${suffix}.png`,
    `${spec.slug}-back${suffix}.png`,
  ]);
  for (const file of files) {
    await copyFile(join(assetsDir, file), join(storageRoot, 'templates', file));
  }

  const path = (side: 'front' | 'back', suffix = '') => `templates/${spec.slug}-${side}${suffix}.png`;

  const templateImages = {
    baseImagePath: path('front'),
    overlayImagePath: path('front', '-overlay'),
    maskImagePath: path('front', '-mask'),
    thumbImagePath: path('front', '-thumb'),
    overlayBlend: 'multiply',
  };

  const template = await prisma.productTemplate.upsert({
    where: { slug: spec.slug },
    create: {
      name: spec.name,
      slug: spec.slug,
      ...templateImages,
      canvasWidth: spec.canvas,
      canvasHeight: spec.canvas,
      active: true,
    },
    update: {
      name: spec.name,
      ...templateImages,
      canvasWidth: spec.canvas,
      canvasHeight: spec.canvas,
      active: true,
    },
  });

  for (const area of spec.areas) {
    const side = area.ownImages ? ('back' as const) : null;
    const areaSpec = {
      name: area.name,
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
      widthInches: area.widthInches,
      heightInches: area.heightInches,
      active: true,
      sortOrder: area.sortOrder,
      baseImagePath: side ? path(side) : null,
      overlayImagePath: side ? path(side, '-overlay') : null,
      maskImagePath: side ? path(side, '-mask') : null,
      thumbImagePath: side ? path(side, '-thumb') : null,
      overlayBlend: null, // template-level blend applies
    };
    await prisma.printArea.upsert({
      where: { productTemplateId_key: { productTemplateId: template.id, key: area.key } },
      create: { productTemplateId: template.id, key: area.key, ...areaSpec },
      update: areaSpec,
    });
  }

  console.log(`Seeded template "${spec.name}" (${spec.slug}) with ${spec.areas.length} print areas.`);
}

async function main(): Promise<void> {
  const storageRoot = resolve(process.env.STORAGE_ROOT ?? './storage');
  await mkdir(join(storageRoot, 'templates'), { recursive: true });
  for (const spec of TEMPLATES) {
    await seedTemplate(storageRoot, spec);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
