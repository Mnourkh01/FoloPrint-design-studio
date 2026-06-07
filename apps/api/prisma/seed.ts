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
 * The overlay carries the photo's fold TEXTURE only (high-pass shading, faded to
 * neutral near the silhouette), so it composites with 'multiply' (re-applies folds
 * over the printed ink without re-darkening broad shadows); the mask clips ink to
 * the garment silhouette.
 */
import { PrismaClient } from '@prisma/client';
import { recolorGarment } from '@foloprint/renderer';
import sharp from 'sharp';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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

interface ColorSpec {
  key: string;
  name: string;
  /** Swatch hex AND the recolor target for derived blanks. */
  hex: string;
  /** Heather speckle amplitude for recolorGarment; 0/absent = smooth fabric. */
  noise?: number;
  isDefault?: boolean;
}

/**
 * Garment colors (v2.0). The default color IS the checked-in white blank; every
 * other color is derived from it at seed time (recolorGarment: white blank +
 * garment mask -> tinted blank), so no extra photo binaries live in the repo.
 * The mask and the multiply overlay stay color-independent: they carry the
 * photo's geometry and shading, which the recolor preserves.
 *
 * One shared palette for every template (the array order is the picker order):
 * neutrals light -> dark, then blues, greens, warms. Keys are forever: stored
 * designs reference them, so rename/remove means a data migration.
 */
const COLORS: ColorSpec[] = [
  { key: 'white', name: 'White', hex: '#f2f2f0', isDefault: true },
  { key: 'sand', name: 'Sand', hex: '#ddd3bd' },
  { key: 'heather', name: 'Heather Gray', hex: '#a7a7a3', noise: 0.11 },
  { key: 'dark-heather', name: 'Dark Heather', hex: '#4a4a4f', noise: 0.09 },
  { key: 'black', name: 'Black', hex: '#232227' },
  { key: 'sky', name: 'Sky Blue', hex: '#a9c6e0' },
  { key: 'royal', name: 'Royal Blue', hex: '#2451a6' },
  { key: 'navy', name: 'Navy', hex: '#1f2a44' },
  { key: 'forest', name: 'Forest Green', hex: '#234633' },
  { key: 'olive', name: 'Olive', hex: '#5b6044' },
  { key: 'red', name: 'Red', hex: '#b3202c' },
  { key: 'burgundy', name: 'Burgundy', hex: '#6e2433' },
  { key: 'pink', name: 'Pink', hex: '#e7b9c6' },
];

/**
 * Print areas model an oversized 16 inch DTG platen (Printful-style): the
 * printable zone covers nearly the whole front/back panel, collar to hem,
 * seam to seam, so chest-left/right/center logo placements all live INSIDE
 * one area. Geometry measured against each photo (mask bbox + luma dips);
 * the garment mask clips ink at render time, so edge overlap is safe.
 */
const TEMPLATES: TemplateSpec[] = [
  {
    slug: 'classic-tee',
    name: 'Classic Tee',
    canvas: 1254,
    areas: [
      // Torso spans ~x 340..920, centerline x 627; ~33.3 px/in. Top edge sits
      // AT the collar (user-tuned); the garment mask clips any collar overlap.
      { key: 'front', name: 'Front print', x: 361, y: 270, width: 533, height: 760, widthInches: 16, heightInches: 22.8, sortOrder: 0, ownImages: false },
      { key: 'back', name: 'Back print', x: 361, y: 240, width: 533, height: 756, widthInches: 16, heightInches: 22.7, sortOrder: 1, ownImages: true },
    ],
  },
  {
    slug: 'classic-sweatshirt',
    name: 'Classic Sweatshirt',
    canvas: 1254,
    areas: [
      // Garment bbox ~x 174..1082, centerline x 628; uniform 35 px/in.
      { key: 'front', name: 'Front print', x: 348, y: 280, width: 560, height: 720, widthInches: 16, heightInches: 20.6, sortOrder: 0, ownImages: false },
      { key: 'back', name: 'Back print', x: 348, y: 250, width: 560, height: 730, widthInches: 16, heightInches: 20.9, sortOrder: 1, ownImages: true },
    ],
  },
  {
    // Assets derived with lumaThreshold 170 (not the default 200): the photo's
    // backdrop sits at luma ~133-159 while seam shadows on the garment reach
    // ~180, so 200 let the flood fill creep through the rib seams and drop the
    // cuffs/hem as separate components.
    slug: 'classic-hoodie',
    name: 'Classic Hoodie',
    canvas: 1254,
    areas: [
      // Garment bbox ~x 226..1028, centerline x 627; ~31.7 px/in. The front
      // print zone stays short on purpose: hood drape ends ~y 455 and the
      // kangaroo pocket seam starts ~y 720 (measured from the photo's luma
      // dips); DTG cannot print across the pocket.
      { key: 'front', name: 'Front print', x: 374, y: 460, width: 506, height: 255, widthInches: 16, heightInches: 8, sortOrder: 0, ownImages: false },
      // Back runs from below the hood drape (~y 390) to the hem ribbing (~y 1010).
      { key: 'back', name: 'Back print', x: 374, y: 400, width: 506, height: 600, widthInches: 16, heightInches: 19, sortOrder: 1, ownImages: true },
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

  const areaRows = new Map<string, { id: string; ownImages: boolean }>();
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
    const row = await prisma.printArea.upsert({
      where: { productTemplateId_key: { productTemplateId: template.id, key: area.key } },
      create: { productTemplateId: template.id, key: area.key, ...areaSpec },
      update: areaSpec,
    });
    areaRows.set(area.key, { id: row.id, ownImages: area.ownImages });
  }

  await seedColors(storageRoot, spec, template.id, areaRows);

  console.log(
    `Seeded template "${spec.name}" (${spec.slug}) with ${spec.areas.length} print areas and ${COLORS.length} colors.`,
  );
}

/**
 * Upserts the color rows and derives the non-default blanks from the white
 * photo + mask already copied into storage. Sides: 'front' backs the
 * template-level images, 'back' backs each ownImages area. Derived files land
 * next to the originals as templates/<slug>-<colorKey>-<side>[-thumb].png.
 */
async function seedColors(
  storageRoot: string,
  spec: TemplateSpec,
  templateId: string,
  areaRows: Map<string, { id: string; ownImages: boolean }>,
): Promise<void> {
  const storagePath = (side: 'front' | 'back', color?: string, suffix = '') =>
    `templates/${spec.slug}${color ? `-${color}` : ''}-${side}${suffix}.png`;

  // Derive each non-default color's blank + thumb per side, from storage files.
  const sides: ('front' | 'back')[] = ['front', 'back'];
  for (const color of COLORS) {
    if (color.isDefault) continue;
    for (const side of sides) {
      const source = await readFile(join(storageRoot, storagePath(side)));
      const mask = await readFile(join(storageRoot, storagePath(side, undefined, '-mask')));
      const blank = await recolorGarment({ source, mask, hex: color.hex, noise: color.noise ?? 0 });
      await writeFile(join(storageRoot, storagePath(side, color.key)), blank);
      await writeFile(
        join(storageRoot, storagePath(side, color.key, '-thumb')),
        await sharp(blank).resize(512, 512).png().toBuffer(),
      );
    }
  }

  // Stale colors from an older seed spec (and their area images, via cascade) go away.
  await prisma.templateColor.deleteMany({
    where: { productTemplateId: templateId, key: { notIn: COLORS.map((c) => c.key) } },
  });

  for (const [sortOrder, color] of COLORS.entries()) {
    // The default color points at the template's own files; derived colors at theirs.
    const colorOf = color.isDefault ? undefined : color.key;
    const colorSpec = {
      name: color.name,
      hex: color.hex,
      isDefault: color.isDefault ?? false,
      sortOrder,
      active: true,
      baseImagePath: storagePath('front', colorOf),
      thumbImagePath: storagePath('front', colorOf, '-thumb'),
    };
    const colorRow = await prisma.templateColor.upsert({
      where: { productTemplateId_key: { productTemplateId: templateId, key: color.key } },
      create: { productTemplateId: templateId, key: color.key, ...colorSpec },
      update: colorSpec,
    });

    for (const area of areaRows.values()) {
      if (!area.ownImages) continue; // the area uses the template-level (front) images
      const areaImageSpec = {
        baseImagePath: storagePath('back', colorOf),
        thumbImagePath: storagePath('back', colorOf, '-thumb'),
      };
      await prisma.templateColorAreaImage.upsert({
        where: {
          templateColorId_printAreaId: { templateColorId: colorRow.id, printAreaId: area.id },
        },
        create: { templateColorId: colorRow.id, printAreaId: area.id, ...areaImageSpec },
        update: areaImageSpec,
      });
    }
  }
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
