/**
 * API e2e suite. Requires: Postgres up (npm run db:up), schema migrated, seed applied.
 * Boots the real AppModule with the same pipes/CORS as production (configureApp).
 */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import type {
  DesignListDto,
  DesignListItemDto,
  DesignProjectDto,
  PrintAreaDto,
  ProductTemplateDto,
  RenderResultDto,
  UploadedAssetDto,
} from '@foloprint/shared';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('FoloPrint Design Studio API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => ReturnType<typeof request>;
  let template: ProductTemplateDto;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    const res = await http().get('/templates/classic-tee').expect(200);
    template = res.body as ProductTemplateDto;
  });

  afterAll(async () => {
    await app.close();
  });

  const area = (key: string): PrintAreaDto => {
    const found = template.printAreas.find((a) => a.key === key);
    if (!found) throw new Error(`Seed is missing the "${key}" print area`);
    return found;
  };

  /** A small object centered inside the given area. */
  const objectIn = (a: PrintAreaDto, assetId: string, overrides: Partial<Record<'x' | 'y' | 'width' | 'height' | 'rotation', number>> = {}) => ({
    assetId,
    x: a.x + a.width / 2,
    y: a.y + a.height / 2,
    width: 120,
    height: 120,
    rotation: 0,
    ...overrides,
  });

  const makePng = (width = 200, height = 200): Promise<Buffer> =>
    sharp({
      create: { width, height, channels: 4, background: { r: 20, g: 90, b: 200, alpha: 1 } },
    })
      .png()
      .toBuffer();

  const makeJpeg = (): Promise<Buffer> =>
    sharp({
      create: { width: 180, height: 140, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .jpeg()
      .toBuffer();

  const uploadPng = async (width = 200, height = 200): Promise<UploadedAssetDto> => {
    const res = await http()
      .post('/assets/upload')
      .attach('file', await makePng(width, height), { filename: 'logo.png', contentType: 'image/png' })
      .expect(201);
    return res.body as UploadedAssetDto;
  };

  const createFrontBackDesign = async (assetId: string): Promise<DesignProjectDto> => {
    const res = await http()
      .post('/designs')
      .send({
        templateId: template.id,
        placements: [
          { printAreaKey: 'front', objects: [objectIn(area('front'), assetId, { rotation: 15 })] },
          { printAreaKey: 'back', objects: [objectIn(area('back'), assetId)] },
        ],
      })
      .expect(201);
    return res.body as DesignProjectDto;
  };

  const fetchPngBuffer = async (url: string): Promise<Buffer> => {
    const res = await http()
      .get(url)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    return res.body as Buffer;
  };

  describe('GET /health', () => {
    it('reports ok', async () => {
      const res = await http().get('/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('foloprint-design-studio-api');
    });
  });

  describe('GET /templates', () => {
    it('returns the seeded tee with front and back areas and no filesystem paths', async () => {
      const res = await http().get('/templates').expect(200);
      const templates = res.body as ProductTemplateDto[];
      const tee = templates.find((t) => t.slug === 'classic-tee');
      expect(tee).toBeDefined();

      expect(tee!.canvasWidth).toBe(1254);
      expect(tee!.printAreas.map((a) => a.key)).toEqual(['front', 'back']); // sortOrder, not key-asc
      expect(tee!.imageUrl).toBe('/templates/classic-tee/image');

      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/storagePath|baseImagePath|overlayImagePath|maskImagePath|thumbImagePath/);
      expect(raw).not.toMatch(/[A-Z]:\\\\/); // no Windows absolute paths
      expect(raw).not.toMatch(/(^|[^:])\/(home|var|tmp)\//); // no Unix absolute paths
    });

    it('lists the sweatshirt as a second photo template with both areas', async () => {
      const res = await http().get('/templates').expect(200);
      const templates = res.body as ProductTemplateDto[];
      const sweatshirt = templates.find((t) => t.slug === 'classic-sweatshirt');
      expect(sweatshirt).toBeDefined();
      expect(sweatshirt!.canvasWidth).toBe(1254);
      expect(sweatshirt!.overlayBlend).toBe('multiply');
      expect(sweatshirt!.thumbUrl).toBe('/templates/classic-sweatshirt/thumb');
      expect(sweatshirt!.printAreas.map((a) => a.key)).toEqual(['front', 'back']);

      const thumb = await fetchPngBuffer('/templates/classic-sweatshirt/thumb');
      expect(thumb.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    });

    it('front area falls back to template images, back area has its own', () => {
      expect(area('front').imageUrl).toBeNull();
      expect(area('front').overlayUrl).toBeNull();
      expect(area('back').imageUrl).toBe('/templates/classic-tee/areas/back/image');
      expect(area('back').overlayUrl).toBe('/templates/classic-tee/areas/back/overlay');
    });

    it('GET /templates/:slug returns one template, 404 for unknown', async () => {
      const res = await http().get('/templates/classic-tee').expect(200);
      expect((res.body as ProductTemplateDto).slug).toBe('classic-tee');
      await http().get('/templates/does-not-exist').expect(404);
    });

    it('streams the template base image and the back area image as real PNGs', async () => {
      const base = await fetchPngBuffer('/templates/classic-tee/image');
      expect(base.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

      const backBase = await fetchPngBuffer('/templates/classic-tee/areas/back/image');
      expect(backBase.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

      const backOverlay = await fetchPngBuffer('/templates/classic-tee/areas/back/overlay');
      expect(backOverlay.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    });

    it('404s for area images that fall back to the template (front has none)', async () => {
      await http().get('/templates/classic-tee/areas/front/image').expect(404);
      await http().get('/templates/classic-tee/areas/front/overlay').expect(404);
      await http().get('/templates/classic-tee/areas/nope/image').expect(404);
    });
  });

  // The one shared garment palette, in seed (= picker) order. Every template
  // carries exactly this list; the seed is the source of truth.
  const PALETTE = [
    'white',
    'sand',
    'heather',
    'dark-heather',
    'black',
    'sky',
    'royal',
    'navy',
    'forest',
    'olive',
    'red',
    'burgundy',
    'pink',
  ];

  describe('garment colors (v2.0)', () => {
    it('templates carry the seeded colors in order with white as the default', () => {
      expect(template.colors.map((c) => c.key)).toEqual(PALETTE);
      const white = template.colors[0]!;
      expect(white.isDefault).toBe(true);
      expect(template.colors.filter((c) => c.isDefault)).toHaveLength(1);

      for (const color of template.colors) {
        expect(color.hex).toMatch(/^#[0-9a-f]{6}$/i);
        expect(color.imageUrl).toBe(`/templates/classic-tee/colors/${color.key}/image`);
        expect(color.thumbUrl).toBe(`/templates/classic-tee/colors/${color.key}/thumb`);
        // The back area carries its own view, so every color mirrors it.
        expect(color.areaImages).toEqual([
          {
            printAreaKey: 'back',
            imageUrl: `/templates/classic-tee/colors/${color.key}/areas/back/image`,
            thumbUrl: `/templates/classic-tee/colors/${color.key}/areas/back/thumb`,
          },
        ]);
      }
    });

    it('streams color blanks, thumbs, and area images as real PNGs', async () => {
      for (const url of [
        '/templates/classic-tee/colors/black/image',
        '/templates/classic-tee/colors/black/thumb',
        '/templates/classic-tee/colors/black/areas/back/image',
        '/templates/classic-tee/colors/heather/areas/back/thumb',
      ]) {
        const png = await fetchPngBuffer(url);
        expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      }

      // The default color streams the same blank as the template-level image.
      const whiteBlank = await fetchPngBuffer('/templates/classic-tee/colors/white/image');
      const templateBlank = await fetchPngBuffer('/templates/classic-tee/image');
      expect(whiteBlank.equals(templateBlank)).toBe(true);

      // A non-default color is a genuinely different image.
      const blackBlank = await fetchPngBuffer('/templates/classic-tee/colors/black/image');
      expect(blackBlank.equals(templateBlank)).toBe(false);
    });

    it('404s for unknown colors and areas without a color-specific view', async () => {
      await http().get('/templates/classic-tee/colors/neon/image').expect(404);
      await http().get('/templates/classic-tee/colors/neon/thumb').expect(404);
      // Front uses the template-level view; there is no color AREA image for it.
      await http().get('/templates/classic-tee/colors/black/areas/front/image').expect(404);
      await http().get('/templates/classic-tee/colors/black/areas/nope/image').expect(404);
    });

    it('saves a design with a colorKey, echoes it, and round-trips through update', async () => {
      const asset = await uploadPng();
      const created = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          colorKey: 'black',
          placements: [{ printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] }],
        })
        .expect(201);
      const design = created.body as DesignProjectDto;
      expect(design.design.colorKey).toBe('black');

      // Update to another color; the reopened document carries it.
      await http()
        .put(`/designs/${design.id}`)
        .send({
          templateId: template.id,
          colorKey: 'heather',
          placements: [{ printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] }],
        })
        .expect(200);
      const reopened = await http().get(`/designs/${design.id}`).expect(200);
      expect((reopened.body as DesignProjectDto).design.colorKey).toBe('heather');
    });

    it('omits colorKey entirely when the client never sent one (byte-compat)', async () => {
      const asset = await uploadPng();
      const created = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          placements: [{ printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] }],
        })
        .expect(201);
      expect('colorKey' in (created.body as DesignProjectDto).design).toBe(false);
    });

    it('rejects unknown and malformed color keys', async () => {
      const asset = await uploadPng();
      const placements = [{ printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] }];

      const unknown = await http()
        .post('/designs')
        .send({ templateId: template.id, colorKey: 'neon', placements })
        .expect(400);
      expect((unknown.body as { message: string }).message).toContain('no color "neon"');

      await http()
        .post('/designs')
        .send({ templateId: template.id, colorKey: 'Black', placements })
        .expect(400);
      await http()
        .post('/designs')
        .send({ templateId: template.id, colorKey: '', placements })
        .expect(400);
    });

    it('renders the preview on the chosen color blank (different pixels per color)', async () => {
      const asset = await uploadPng();
      const make = async (colorKey?: string): Promise<Buffer> => {
        const res = await http()
          .post('/designs')
          .send({
            templateId: template.id,
            ...(colorKey ? { colorKey } : {}),
            placements: [{ printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] }],
          })
          .expect(201);
        const design = res.body as DesignProjectDto;
        await http().post(`/designs/${design.id}/render`).expect(201);
        return fetchPngBuffer(`/designs/${design.id}/preview/front`);
      };

      const [onDefault, onBlack] = await Promise.all([make(), make('black')]);
      const dims = await sharp(onBlack).metadata();
      expect(dims.width).toBe(template.canvasWidth);
      expect(dims.height).toBe(template.canvasHeight);
      // Same artwork, different garment: the previews must differ.
      expect(onBlack.equals(onDefault)).toBe(false);
    });

    it('resolves the display color on the project and list DTOs', async () => {
      const asset = await uploadPng();
      const placements = [{ printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] }];

      const picked = (
        await http().post('/designs').send({ templateId: template.id, colorKey: 'black', placements }).expect(201)
      ).body as DesignProjectDto;
      expect(picked.color).toEqual({ key: 'black', name: 'Black', hex: '#232227' });

      // No stored colorKey -> the template default, not null (the template has colors).
      const defaulted = (
        await http().post('/designs').send({ templateId: template.id, placements }).expect(201)
      ).body as DesignProjectDto;
      expect(defaulted.color).toEqual({ key: 'white', name: 'White', hex: '#f2f2f0' });

      // The list rows carry the same resolved color.
      const list = (await http().get('/designs?pageSize=50').expect(200)).body as DesignListDto;
      const row = (id: string) => list.items.find((i) => i.id === id)!;
      expect(row(picked.id).color).toEqual({ key: 'black', name: 'Black', hex: '#232227' });
      expect(row(defaulted.id).color).toEqual({ key: 'white', name: 'White', hex: '#f2f2f0' });
    });
  });

  describe('classic hoodie (v2.0 third product)', () => {
    it('lists the hoodie with both areas and the three colors', async () => {
      const res = await http().get('/templates').expect(200);
      const hoodie = (res.body as ProductTemplateDto[]).find((t) => t.slug === 'classic-hoodie');
      expect(hoodie).toBeDefined();
      expect(hoodie!.canvasWidth).toBe(1254);
      expect(hoodie!.overlayBlend).toBe('multiply');
      expect(hoodie!.printAreas.map((a) => a.key)).toEqual(['front', 'back']);

      // The front zone sits between the hood drape and the kangaroo pocket,
      // so it is wider than tall (unlike the tee/sweatshirt fronts).
      const front = hoodie!.printAreas.find((a) => a.key === 'front')!;
      expect(front.height).toBeLessThan(front.width);

      expect(hoodie!.colors.map((c) => c.key)).toEqual(PALETTE);
      for (const color of hoodie!.colors) {
        expect(color.imageUrl).toBe(`/templates/classic-hoodie/colors/${color.key}/image`);
        expect(color.thumbUrl).toBe(`/templates/classic-hoodie/colors/${color.key}/thumb`);
      }
    });

    it('streams the hoodie blank, thumb, and derived color views as PNGs', async () => {
      for (const url of [
        '/templates/classic-hoodie/image',
        '/templates/classic-hoodie/thumb',
        '/templates/classic-hoodie/colors/black/image',
        '/templates/classic-hoodie/colors/heather/areas/back/thumb',
      ]) {
        const png = await fetchPngBuffer(url);
        expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      }

      // The derived black blank is a genuinely different image from the white one.
      const black = await fetchPngBuffer('/templates/classic-hoodie/colors/black/image');
      const white = await fetchPngBuffer('/templates/classic-hoodie/image');
      expect(black.equals(white)).toBe(false);
    });
  });

  describe('POST /assets/upload', () => {
    it('accepts a real PNG', async () => {
      const asset = await uploadPng();
      expect(asset.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(asset.mimeType).toBe('image/png');
      expect(asset.width).toBe(200);
      expect(asset.url).toBe(`/assets/${asset.id}/file`);
      expect(JSON.stringify(asset)).not.toMatch(/storagePath/);
    });

    it('accepts a real JPEG', async () => {
      const res = await http()
        .post('/assets/upload')
        .attach('file', await makeJpeg(), { filename: 'photo.jpg', contentType: 'image/jpeg' })
        .expect(201);
      expect((res.body as UploadedAssetDto).mimeType).toBe('image/jpeg');
    });

    it('rejects SVG even when disguised as PNG', async () => {
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert(1)</script></svg>',
      );
      const res = await http()
        .post('/assets/upload')
        .attach('file', svg, { filename: 'sneaky.png', contentType: 'image/png' })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/PNG and JPEG|not a valid image/i);
    });

    it('rejects a non-image with an image extension', async () => {
      await http()
        .post('/assets/upload')
        .attach('file', Buffer.from('definitely not an image'), {
          filename: 'fake.jpg',
          contentType: 'image/jpeg',
        })
        .expect(400);
    });

    it('rejects requests with no file', async () => {
      await http().post('/assets/upload').expect(400);
    });
  });

  describe('POST /assets/:id/remove-background', () => {
    const makeLogoOnWhite = (): Promise<Buffer> =>
      sharp({
        create: { width: 200, height: 200, channels: 4, background: { r: 250, g: 250, b: 248, alpha: 1 } },
      })
        .composite([
          {
            input: {
              create: { width: 80, height: 80, channels: 4, background: { r: 190, g: 30, b: 40, alpha: 1 } },
            },
            left: 60,
            top: 60,
          },
        ])
        .png()
        .toBuffer();

    it('derives a new transparent PNG asset and leaves the source intact', async () => {
      const upload = await http()
        .post('/assets/upload')
        .attach('file', await makeLogoOnWhite(), { filename: 'logo on white.png', contentType: 'image/png' })
        .expect(201);
      const source = upload.body as UploadedAssetDto;

      const res = await http().post(`/assets/${source.id}/remove-background`).expect(201);
      const derived = res.body as UploadedAssetDto;
      expect(derived.id).not.toBe(source.id);
      expect(derived.mimeType).toBe('image/png');
      expect(derived.width).toBe(source.width);
      expect(derived.height).toBe(source.height);
      expect(derived.originalFilename).toMatch(/-nobg\.png$/);
      expect(JSON.stringify(derived)).not.toMatch(/storagePath/);

      // Derived file: background corner transparent, logo center opaque.
      const derivedPng = await fetchPngBuffer(`/assets/${derived.id}/file`);
      const { data, info } = await sharp(derivedPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3]!;
      expect(alphaAt(5, 5)).toBe(0);
      expect(alphaAt(100, 100)).toBe(255);

      // Source asset is untouched (corner still fully opaque).
      const sourcePng = await fetchPngBuffer(`/assets/${source.id}/file`);
      const sourceRaw = await sharp(sourcePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(sourceRaw.data[3]!).toBe(255);
    });

    it('400s on a busy background with a human-readable reason', async () => {
      // Deterministic pseudo-noise; nothing flat to key off.
      const noise = Buffer.alloc(200 * 200 * 4);
      for (let i = 0; i < 200 * 200; i++) {
        noise[i * 4] = (i * 73) % 256;
        noise[i * 4 + 1] = (i * 151) % 256;
        noise[i * 4 + 2] = (i * 211) % 256;
        noise[i * 4 + 3] = 255;
      }
      const busy = await sharp(noise, { raw: { width: 200, height: 200, channels: 4 } }).png().toBuffer();
      const upload = await http()
        .post('/assets/upload')
        .attach('file', busy, { filename: 'photo.png', contentType: 'image/png' })
        .expect(201);

      const res = await http()
        .post(`/assets/${(upload.body as UploadedAssetDto).id}/remove-background`)
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/solid background/i);
    });

    it('404s for an unknown asset id and 400s for a malformed one', async () => {
      await http().post('/assets/00000000-0000-4000-8000-000000000000/remove-background').expect(404);
      await http().post('/assets/not-a-uuid/remove-background').expect(400);
    });
  });

  describe('POST /assets/:id/crop', () => {
    it('derives a cropped PNG asset and leaves the source intact', async () => {
      // makePng is a solid blue rectangle; the crop keeps its color and new dims.
      const source = await uploadPng(200, 200);

      const res = await http()
        .post(`/assets/${source.id}/crop`)
        .send({ left: 0, top: 0, width: 100, height: 200 })
        .expect(201);
      const derived = res.body as UploadedAssetDto;
      expect(derived.id).not.toBe(source.id);
      expect(derived.width).toBe(100);
      expect(derived.height).toBe(200);
      expect(derived.mimeType).toBe('image/png');
      expect(derived.originalFilename).toMatch(/-crop\.png$/);

      // The cropped file is the left band only: uniformly the accent color.
      const png = await fetchPngBuffer(`/assets/${derived.id}/file`);
      const meta = await sharp(png).metadata();
      expect(meta.width).toBe(100);
      const { data } = await sharp(png)
        .extract({ left: 90, top: 100, width: 1, height: 1 })
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(data[2]).toBeGreaterThan(150); // still the solid blue near the cut edge
      expect(data[0]).toBeLessThan(100);

      // Source untouched.
      const sourceMeta = await sharp(await fetchPngBuffer(`/assets/${source.id}/file`)).metadata();
      expect(sourceMeta.width).toBe(200);
    });

    it('rejects rects outside the bounds, too small, or non-integer', async () => {
      const source = await uploadPng(200, 200);
      await http()
        .post(`/assets/${source.id}/crop`)
        .send({ left: 150, top: 0, width: 100, height: 200 })
        .expect(400); // exceeds width
      await http()
        .post(`/assets/${source.id}/crop`)
        .send({ left: 0, top: 0, width: 8, height: 8 })
        .expect(400); // below the 16px floor
      await http()
        .post(`/assets/${source.id}/crop`)
        .send({ left: 0.5, top: 0, width: 100, height: 100 })
        .expect(400); // non-integer
      await http()
        .post('/assets/00000000-0000-4000-8000-000000000000/crop')
        .send({ left: 0, top: 0, width: 100, height: 100 })
        .expect(404);
    });
  });

  describe('POST /designs (v2 placements)', () => {
    it('accepts a front+back design and returns a normalized v2 document', async () => {
      const asset = await uploadPng();
      const design = await createFrontBackDesign(asset.id);

      expect(design.id).toBeDefined();
      expect(design.previews).toEqual([]);
      expect(design.design.version).toBe(2);
      expect(design.design.placements.map((p) => p.printAreaKey)).toEqual(['front', 'back']);
      expect(design.design.placements[0]!.objects).toHaveLength(1);
      expect(JSON.stringify(design)).not.toMatch(/previews[\\/]|storagePath/);
    });

    it('rejects a duplicated area placement', async () => {
      const asset = await uploadPng();
      const res = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          placements: [
            { printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] },
            { printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] },
          ],
        })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/placements\[1\]: Duplicate placement/);
    });

    it('rejects an unknown print area key', async () => {
      const asset = await uploadPng();
      const res = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          placements: [{ printAreaKey: 'sleeve', objects: [objectIn(area('front'), asset.id)] }],
        })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/Print area .{0,2}sleeve.{0,2} does not exist/);
    });

    it('rejects an object outside the BACK print area, reporting the right placement', async () => {
      const asset = await uploadPng();
      const back = area('back');
      const res = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          placements: [
            { printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] },
            {
              printAreaKey: 'back',
              objects: [objectIn(back, asset.id, { x: back.x + back.width + 200 })],
            },
          ],
        })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(
        /placements\[1\]\.objects\[0\]: Object is outside the print area/,
      );
    });

    it('rejects a rotation that pushes corners out even though the unrotated box fits', async () => {
      const asset = await uploadPng();
      const front = area('front');
      await http()
        .post('/designs')
        .send({
          templateId: template.id,
          placements: [
            {
              printAreaKey: 'front',
              objects: [
                objectIn(front, asset.id, {
                  width: front.width, // fills the area exactly; any rotation pushes corners out
                  height: front.height,
                  rotation: 45,
                }),
              ],
            },
          ],
        })
        .expect(400);
    });

    it('rejects unknown asset ids', async () => {
      await http()
        .post('/designs')
        .send({
          templateId: template.id,
          placements: [
            {
              printAreaKey: 'front',
              objects: [objectIn(area('front'), '00000000-0000-4000-8000-000000000000')],
            },
          ],
        })
        .expect(400);
    });

    it('rejects a placement with an empty objects array (DTO level)', async () => {
      await http()
        .post('/designs')
        .send({ templateId: template.id, placements: [{ printAreaKey: 'front', objects: [] }] })
        .expect(400);
    });

    it('rejects extra unknown body fields (forbidNonWhitelisted)', async () => {
      await http()
        .post('/designs')
        .send({ templateId: template.id, placements: [], hacker: true })
        .expect(400);
    });

    it('rejects the old v1 write shape (printAreaKey at the top level)', async () => {
      const asset = await uploadPng();
      await http()
        .post('/designs')
        .send({
          templateId: template.id,
          printAreaKey: 'front',
          objects: [objectIn(area('front'), asset.id)],
        })
        .expect(400);
    });
  });

  describe('image pattern tiling (v1.9)', () => {
    const postFront = (objects: object[]) =>
      http()
        .post('/designs')
        .send({ templateId: template.id, placements: [{ printAreaKey: 'front', objects }] });

    it('saves, renders, and reopens a patterned image', async () => {
      const asset = await uploadPng();
      const res = await postFront([
        { ...objectIn(area('front'), asset.id), pattern: { type: 'mirror', spacing: 8 } },
      ]).expect(201);
      const dto = res.body as DesignProjectDto;
      expect(dto.design.placements[0]!.objects[0]).toMatchObject({
        pattern: { type: 'mirror', spacing: 8 },
      });

      await http().post(`/designs/${dto.id}/render`).expect(201);
      await http().get(`/designs/${dto.id}/preview/front`).expect(200);

      const reopened = await http().get(`/designs/${dto.id}`).expect(200);
      expect((reopened.body as DesignProjectDto).design.placements[0]!.objects[0]).toMatchObject({
        pattern: { type: 'mirror', spacing: 8 },
      });
    });

    it('rejects unknown types, out-of-range spacing, rotated tiles, and patterns on text', async () => {
      const asset = await uploadPng();
      await postFront([
        { ...objectIn(area('front'), asset.id), pattern: { type: 'swirl', spacing: 0 } },
      ]).expect(400);
      await postFront([
        { ...objectIn(area('front'), asset.id), pattern: { type: 'grid', spacing: 101 } },
      ]).expect(400);
      const rotated = await postFront([
        { ...objectIn(area('front'), asset.id, { rotation: 15 }), pattern: { type: 'grid', spacing: 0 } },
      ]).expect(400);
      expect(JSON.stringify(rotated.body)).toMatch(/must not be rotated/i);
      const onText = await postFront([
        {
          type: 'text',
          text: 'No tiling',
          fontFamily: 'inter',
          fontSize: 48,
          color: '#cc0033',
          align: 'center',
          x: area('front').x + area('front').width / 2,
          y: area('front').y + area('front').height / 2,
          width: 180,
          height: 60,
          rotation: 0,
          pattern: { type: 'grid', spacing: 0 },
        },
      ]).expect(400);
      expect(JSON.stringify(onText.body)).toMatch(/must not carry a pattern/i);
    });
  });

  describe('stored v1 documents (legacy designs)', () => {
    /** Simulates a design saved by v1.1: raw v1 document inserted directly. */
    const insertV1Design = async (assetId: string): Promise<string> => {
      const front = area('front');
      const created = await prisma.designProject.create({
        data: {
          productTemplateId: template.id,
          designJson: {
            version: 1,
            templateId: template.id,
            printAreaKey: 'front',
            objects: [
              {
                assetId,
                x: front.x + front.width / 2,
                y: front.y + front.height / 2,
                width: 100,
                height: 100,
                rotation: 10,
              },
            ],
          },
        },
      });
      return created.id;
    };

    it('GET returns a v1 design normalized to v2', async () => {
      const asset = await uploadPng();
      const id = await insertV1Design(asset.id);

      const res = await http().get(`/designs/${id}`).expect(200);
      const dto = res.body as DesignProjectDto;
      expect(dto.design.version).toBe(2);
      expect(dto.design.placements).toHaveLength(1);
      expect(dto.design.placements[0]!.printAreaKey).toBe('front');
      expect(dto.design.placements[0]!.objects[0]!.rotation).toBe(10);
      expect(dto.previews).toEqual([]);
    });

    it('renders a v1 design (normalized at render time)', async () => {
      const asset = await uploadPng();
      const id = await insertV1Design(asset.id);

      const render = await http().post(`/designs/${id}/render`).expect(201);
      const result = render.body as RenderResultDto;
      expect(result.previews).toHaveLength(1);
      expect(result.previews[0]!.printAreaKey).toBe('front');
      expect(result.previews[0]!.previewUrl).toBe(`/designs/${id}/preview/front`);
    });

    it('PUT upgrades a v1 design to a v2 multi-area document', async () => {
      const asset = await uploadPng();
      const id = await insertV1Design(asset.id);

      const res = await http()
        .put(`/designs/${id}`)
        .send({
          templateId: template.id,
          placements: [
            { printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] },
            { printAreaKey: 'back', objects: [objectIn(area('back'), asset.id)] },
          ],
        })
        .expect(200);

      const dto = res.body as DesignProjectDto;
      expect(dto.id).toBe(id);
      expect(dto.design.version).toBe(2);
      expect(dto.design.placements.map((p) => p.printAreaKey)).toEqual(['front', 'back']);

      // The stored row itself is now v2, not just the response.
      const row = await prisma.designProject.findUniqueOrThrow({ where: { id } });
      expect((row.designJson as { version: number }).version).toBe(2);
    });
  });

  describe('PUT /designs/:id', () => {
    it('updates a design and clears ALL stale area previews', async () => {
      const asset = await uploadPng();
      const design = await createFrontBackDesign(asset.id);

      // Render so both previews exist, then prove the update invalidates them all.
      await http().post(`/designs/${design.id}/render`).expect(201);
      await http().get(`/designs/${design.id}/preview/front`).expect(200);
      await http().get(`/designs/${design.id}/preview/back`).expect(200);

      const front = area('front');
      const updated = await http()
        .put(`/designs/${design.id}`)
        .send({
          templateId: template.id,
          placements: [
            {
              printAreaKey: 'front',
              objects: [objectIn(front, asset.id, { x: front.x + 80, y: front.y + 90, width: 100, height: 100, rotation: 10 })],
            },
          ],
        })
        .expect(200);

      expect(updated.body.id).toBe(design.id); // same design, no duplicate
      expect(updated.body.previews).toEqual([]);
      expect(updated.body.design.placements).toHaveLength(1);

      const refreshed = await http().get(`/designs/${design.id}`).expect(200);
      expect(refreshed.body.previews).toEqual([]);
      await http().get(`/designs/${design.id}/preview/front`).expect(404);
      await http().get(`/designs/${design.id}/preview/back`).expect(404);
    });

    it('rejects an update with a mismatched template id', async () => {
      const asset = await uploadPng();
      const design = await createFrontBackDesign(asset.id);
      const res = await http()
        .put(`/designs/${design.id}`)
        .send({
          templateId: '00000000-0000-4000-8000-000000000000',
          placements: [{ printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] }],
        })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/different template/);
    });

    it('rejects an update with an object outside its print area', async () => {
      const asset = await uploadPng();
      const design = await createFrontBackDesign(asset.id);
      const front = area('front');
      await http()
        .put(`/designs/${design.id}`)
        .send({
          templateId: template.id,
          placements: [
            {
              printAreaKey: 'front',
              objects: [objectIn(front, asset.id, { x: front.x + front.width + 300 })],
            },
          ],
        })
        .expect(400);
    });

    it('rejects an update referencing an unknown asset', async () => {
      const asset = await uploadPng();
      const design = await createFrontBackDesign(asset.id);
      await http()
        .put(`/designs/${design.id}`)
        .send({
          templateId: template.id,
          placements: [
            {
              printAreaKey: 'front',
              objects: [objectIn(area('front'), '00000000-0000-4000-8000-000000000000')],
            },
          ],
        })
        .expect(400);
    });

    it('404s when updating an unknown design', async () => {
      const asset = await uploadPng();
      await http()
        .put('/designs/00000000-0000-4000-8000-000000000000')
        .send({
          templateId: template.id,
          placements: [{ printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] }],
        })
        .expect(404);
    });
  });

  describe('render flow (multi-area)', () => {
    it('renders one preview per placed area and streams each as a PNG at canvas size', async () => {
      const asset = await uploadPng();
      const design = await createFrontBackDesign(asset.id);

      const render = await http().post(`/designs/${design.id}/render`).expect(201);
      const result = render.body as RenderResultDto;

      expect(result.designId).toBe(design.id);
      expect(result.previews.map((p) => p.printAreaKey).sort()).toEqual(['back', 'front']);
      for (const preview of result.previews) {
        expect(preview.previewUrl).toBe(`/designs/${design.id}/preview/${preview.printAreaKey}`);
        expect(Date.parse(preview.renderedAt)).not.toBeNaN();
      }
      expect(JSON.stringify(result)).not.toMatch(/previews[\\/].*\.png|storagePath/);

      // Front and back must be DIFFERENT images (different view bases).
      const frontPng = await fetchPngBuffer(`/designs/${design.id}/preview/front`);
      const backPng = await fetchPngBuffer(`/designs/${design.id}/preview/back`);
      for (const png of [frontPng, backPng]) {
        expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
        const meta = await sharp(png).metadata();
        expect(meta.width).toBe(template.canvasWidth);
        expect(meta.height).toBe(template.canvasHeight);
      }
      expect(frontPng.equals(backPng)).toBe(false);

      // GET /designs/:id reflects the preview metadata.
      const refreshed = await http().get(`/designs/${design.id}`).expect(200);
      const dto = refreshed.body as DesignProjectDto;
      expect(dto.previews.map((p) => p.printAreaKey).sort()).toEqual(['back', 'front']);
    });

    it('renders a front-only design without creating a back preview', async () => {
      const asset = await uploadPng();
      const res = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          placements: [{ printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] }],
        })
        .expect(201);

      const render = await http().post(`/designs/${res.body.id}/render`).expect(201);
      expect((render.body as RenderResultDto).previews).toHaveLength(1);
      await http().get(`/designs/${res.body.id}/preview/front`).expect(200);
      await http().get(`/designs/${res.body.id}/preview/back`).expect(404);
    });

    it('404s for an unrendered design preview and unknown design', async () => {
      await http().get('/designs/00000000-0000-4000-8000-000000000000').expect(404);
      await http().get('/designs/00000000-0000-4000-8000-000000000000/preview/front').expect(404);
    });
  });

  describe('design management (v2.2): delete and duplicate', () => {
    it('deletes a design with its rendered previews; the row and files are gone', async () => {
      const asset = await uploadPng();
      const design = await createFrontBackDesign(asset.id);
      await http().post(`/designs/${design.id}/render`).expect(201);
      await http().get(`/designs/${design.id}/preview/front`).expect(200);

      await http().delete(`/designs/${design.id}`).expect(204);

      await http().get(`/designs/${design.id}`).expect(404);
      await http().get(`/designs/${design.id}/preview/front`).expect(404);
      // Idempotence from the client's view: a second delete is a 404, not a 500.
      await http().delete(`/designs/${design.id}`).expect(404);
    });

    it('duplicates a design: identical document, fresh id, no previews', async () => {
      const asset = await uploadPng();
      const design = await createFrontBackDesign(asset.id);
      await http().post(`/designs/${design.id}/render`).expect(201);

      const res = await http().post(`/designs/${design.id}/duplicate`).expect(201);
      const copy = res.body as DesignProjectDto;

      expect(copy.id).not.toBe(design.id);
      expect(copy.design).toEqual(design.design);
      expect(copy.templateId).toBe(design.templateId);
      expect(copy.previews).toEqual([]); // the copy was never rendered

      // The source keeps its previews; both rows exist independently.
      await http().get(`/designs/${design.id}/preview/front`).expect(200);
      await http().get(`/designs/${copy.id}`).expect(200);
    });

    it('404s for unknown designs and 400s for malformed ids', async () => {
      await http().delete('/designs/00000000-0000-4000-8000-000000000000').expect(404);
      await http().post('/designs/00000000-0000-4000-8000-000000000000/duplicate').expect(404);
      await http().delete('/designs/not-a-uuid').expect(400);
    });
  });

  describe('print files (v2.2)', () => {
    it('streams the ink alone at 300dpi over the physical print size, transparent background', async () => {
      const asset = await uploadPng();
      const design = await createFrontBackDesign(asset.id);

      const png = await fetchPngBuffer(`/designs/${design.id}/print-file/front`);
      expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

      const meta = await sharp(png).metadata();
      // Sheet = the print area's physical size at 300dpi (width drives the scale).
      const front = area('front');
      expect(meta.width).toBe(Math.round((front.widthInches ?? 12) * 300));
      expect(Math.round(meta.density ?? 0)).toBe(300);

      // Corner: fully transparent (no garment photo, no backdrop).
      const corner = await sharp(png).extract({ left: 1, top: 1, width: 1, height: 1 }).ensureAlpha().raw().toBuffer();
      expect(corner[3]).toBe(0);

      // Center: the uploaded blue artwork, opaque, scaled into place.
      const center = await sharp(png)
        .extract({ left: Math.round((meta.width ?? 2) / 2), top: Math.round((meta.height ?? 2) / 2), width: 1, height: 1 })
        .ensureAlpha()
        .raw()
        .toBuffer();
      expect(center[3]).toBe(255);
      expect(center[2]).toBeGreaterThan(150); // blue channel of the fixture PNG
    });

    it('renders text designs as print files too', async () => {
      const front = area('front');
      const res = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          placements: [
            {
              printAreaKey: 'front',
              objects: [
                {
                  type: 'text',
                  text: 'PRINT ME',
                  fontFamily: 'inter',
                  fontSize: 60,
                  color: '#112233',
                  align: 'center',
                  x: front.x + front.width / 2,
                  y: front.y + front.height / 2,
                  width: 240,
                  height: 70,
                  rotation: 0,
                },
              ],
            },
          ],
        })
        .expect(201);

      const png = await fetchPngBuffer(`/designs/${(res.body as DesignProjectDto).id}/print-file/front`);
      const stats = await sharp(png).stats();
      // Some opaque ink exists; the sheet is not blank.
      expect(stats.channels[3]!.max).toBe(255);
    });

    it('404s for areas without artwork and unknown designs, 400 for malformed ids', async () => {
      const asset = await uploadPng();
      const res = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          placements: [{ printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] }],
        })
        .expect(201);

      await http().get(`/designs/${(res.body as DesignProjectDto).id}/print-file/back`).expect(404);
      await http().get('/designs/00000000-0000-4000-8000-000000000000/print-file/front').expect(404);
      await http().get('/designs/not-a-uuid/print-file/front').expect(400);
    });
  });

  describe('text objects (v1.5)', () => {
    const textIn = (
      a: PrintAreaDto,
      overrides: Partial<Record<string, unknown>> = {},
    ) => ({
      type: 'text',
      text: 'Hello print',
      fontFamily: 'inter',
      fontSize: 48,
      color: '#cc0033',
      align: 'center',
      x: a.x + a.width / 2,
      y: a.y + a.height / 2,
      width: 180,
      height: 60,
      rotation: 0,
      ...overrides,
    });

    const postFrontObjects = (objects: object[]) =>
      http()
        .post('/designs')
        .send({ templateId: template.id, placements: [{ printAreaKey: 'front', objects }] });

    it('saves a text-only design and echoes the typed document', async () => {
      const res = await postFrontObjects([textIn(area('front'))]).expect(201);
      const dto = res.body as DesignProjectDto;
      expect(dto.design.version).toBe(2);
      expect(dto.design.placements[0]!.objects[0]).toMatchObject({
        type: 'text',
        text: 'Hello print',
        fontFamily: 'inter',
        fontSize: 48,
        color: '#cc0033',
        align: 'center',
      });
    });

    it('saves a mixed image+text placement', async () => {
      const asset = await uploadPng();
      const res = await postFrontObjects([
        { type: 'image', ...objectIn(area('front'), asset.id) },
        textIn(area('front'), { y: area('front').y + 40, height: 40 }),
      ]).expect(201);
      const objects = (res.body as DesignProjectDto).design.placements[0]!.objects;
      expect(objects.map((o) => o.type)).toEqual(['image', 'text']);
    });

    it('accepts a typeless image object (legacy client) and stores it typed', async () => {
      const asset = await uploadPng();
      const res = await postFrontObjects([objectIn(area('front'), asset.id)]).expect(201);
      expect((res.body as DesignProjectDto).design.placements[0]!.objects[0]!.type).toBe('image');
    });

    it('rejects a font outside the whitelist', async () => {
      const res = await postFrontObjects([textIn(area('front'), { fontFamily: 'comic-sans' })]).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/fontFamily/);
    });

    it('rejects bad colors (named, shorthand, rgb())', async () => {
      for (const color of ['red', '#fff', 'rgb(0,0,0)']) {
        await postFrontObjects([textIn(area('front'), { color })]).expect(400);
      }
    });

    it('rejects empty, too-long, and too-many-line text', async () => {
      await postFrontObjects([textIn(area('front'), { text: '' })]).expect(400);
      await postFrontObjects([textIn(area('front'), { text: 'a'.repeat(301) })]).expect(400);
      await postFrontObjects([
        textIn(area('front'), { text: Array(9).fill('x').join('\n') }),
      ]).expect(400);
    });

    it('rejects font sizes outside 12..500', async () => {
      await postFrontObjects([textIn(area('front'), { fontSize: 11 })]).expect(400);
      await postFrontObjects([textIn(area('front'), { fontSize: 501 })]).expect(400);
    });

    it('rejects unknown align values', async () => {
      await postFrontObjects([textIn(area('front'), { align: 'justify' })]).expect(400);
    });

    it('rejects kind-mixed payloads (text with assetId)', async () => {
      const asset = await uploadPng();
      const res = await postFrontObjects([
        textIn(area('front'), { assetId: asset.id }),
      ]).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/must not carry an assetId/);
    });

    it('rejects text outside the print area, including via rotation', async () => {
      const front = area('front');
      await postFrontObjects([
        textIn(front, { x: front.x + front.width + 100 }),
      ]).expect(400);
      await postFrontObjects([
        textIn(front, { width: front.width, height: front.height, rotation: 30 }),
      ]).expect(400);
    });

    it('renders a text design to a real PNG preview at canvas size', async () => {
      const res = await postFrontObjects([textIn(area('front'))]).expect(201);
      const designId = (res.body as DesignProjectDto).id;

      await http().post(`/designs/${designId}/render`).expect(201);
      const png = await fetchPngBuffer(`/designs/${designId}/preview/front`);
      expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      const meta = await sharp(png).metadata();
      expect(meta.width).toBe(template.canvasWidth);
      expect(meta.height).toBe(template.canvasHeight);
    });

    it('round-trips a text design through save, update, and reopen', async () => {
      const front = area('front');
      const created = await postFrontObjects([textIn(front)]).expect(201);
      const designId = (created.body as DesignProjectDto).id;

      await http()
        .put(`/designs/${designId}`)
        .send({
          templateId: template.id,
          placements: [
            {
              printAreaKey: 'front',
              objects: [textIn(front, { text: 'Updated\ntext', fontFamily: 'oswald', align: 'left' })],
            },
          ],
        })
        .expect(200);

      const reopened = await http().get(`/designs/${designId}`).expect(200);
      expect((reopened.body as DesignProjectDto).design.placements[0]!.objects[0]).toMatchObject({
        type: 'text',
        text: 'Updated\ntext',
        fontFamily: 'oswald',
        align: 'left',
      });
    });

    it('library rows count image and text objects separately', async () => {
      await prisma.designProject.deleteMany();
      const asset = await uploadPng();
      const front = area('front');
      await postFrontObjects([
        { type: 'image', ...objectIn(front, asset.id) },
        textIn(front, { y: front.y + 40, height: 40 }),
      ]).expect(201);

      const res = await http().get('/designs').expect(200);
      const item = (res.body as DesignListDto).items[0]!;
      expect(item.placements[0]).toMatchObject({ objectCount: 2, imageCount: 1, textCount: 1 });
    });
  });

  describe('text RTL + wrap (v1.6)', () => {
    const textIn = (
      a: PrintAreaDto,
      overrides: Partial<Record<string, unknown>> = {},
    ) => ({
      type: 'text',
      text: 'Hello print',
      fontFamily: 'inter',
      fontSize: 48,
      color: '#cc0033',
      align: 'center',
      x: a.x + a.width / 2,
      y: a.y + a.height / 2,
      width: 180,
      height: 60,
      rotation: 0,
      ...overrides,
    });

    const postFrontObjects = (objects: object[]) =>
      http()
        .post('/designs')
        .send({ templateId: template.id, placements: [{ printAreaKey: 'front', objects }] });

    it('saves, renders, and reopens Arabic text with auto direction', async () => {
      const res = await postFrontObjects([
        textIn(area('front'), { text: 'مرحبا بالعالم', fontFamily: 'noto-naskh-arabic' }),
      ]).expect(201);
      const dto = res.body as DesignProjectDto;
      // Normalization fills the additive defaults at read time.
      expect(dto.design.placements[0]!.objects[0]).toMatchObject({
        type: 'text',
        text: 'مرحبا بالعالم',
        fontFamily: 'noto-naskh-arabic',
        direction: 'auto',
        wrapMode: 'none',
      });

      await http().post(`/designs/${dto.id}/render`).expect(201);
      const png = await fetchPngBuffer(`/designs/${dto.id}/preview/front`);
      expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

      const reopened = await http().get(`/designs/${dto.id}`).expect(200);
      expect((reopened.body as DesignProjectDto).design.placements[0]!.objects[0]).toMatchObject({
        text: 'مرحبا بالعالم',
        direction: 'auto',
      });
    });

    it('saves and renders Arabic text with explicit rtl direction', async () => {
      const res = await postFrontObjects([
        textIn(area('front'), {
          text: 'مرحبا ABC',
          fontFamily: 'noto-naskh-arabic',
          direction: 'rtl',
        }),
      ]).expect(201);
      const dto = res.body as DesignProjectDto;
      expect(dto.design.placements[0]!.objects[0]).toMatchObject({ direction: 'rtl' });
      await http().post(`/designs/${dto.id}/render`).expect(201);
      await http().get(`/designs/${dto.id}/preview/front`).expect(200);
    });

    it('saves and renders box-wrapped text and round-trips wrappedLines', async () => {
      const res = await postFrontObjects([
        textIn(area('front'), {
          text: 'wraps neatly inside the box',
          wrapMode: 'box',
          wrappedLines: ['wraps neatly', 'inside the box'],
          height: 100,
        }),
      ]).expect(201);
      const dto = res.body as DesignProjectDto;
      expect(dto.design.placements[0]!.objects[0]).toMatchObject({
        wrapMode: 'box',
        wrappedLines: ['wraps neatly', 'inside the box'],
      });
      await http().post(`/designs/${dto.id}/render`).expect(201);
      const png = await fetchPngBuffer(`/designs/${dto.id}/preview/front`);
      expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    });

    it('rejects unknown direction and wrapMode values', async () => {
      await postFrontObjects([textIn(area('front'), { direction: 'up' })]).expect(400);
      await postFrontObjects([textIn(area('front'), { wrapMode: 'char' })]).expect(400);
    });

    it('rejects wrappedLines without box mode and box mode without wrappedLines', async () => {
      const res1 = await postFrontObjects([
        textIn(area('front'), { wrappedLines: ['Hello print'] }),
      ]).expect(400);
      expect(JSON.stringify(res1.body)).toMatch(/only allowed when wrapMode/);
      const res2 = await postFrontObjects([
        textIn(area('front'), { wrapMode: 'box' }),
      ]).expect(400);
      expect(JSON.stringify(res2.body)).toMatch(/wrappedLines is required/);
    });

    it('rejects more than 8 wrapped lines', async () => {
      const words = Array(9).fill('x');
      await postFrontObjects([
        textIn(area('front'), {
          text: words.join(' '),
          wrapMode: 'box',
          wrappedLines: words,
        }),
      ]).expect(400);
    });

    it('rejects forged wrappedLines via reconciliation', async () => {
      const res = await postFrontObjects([
        textIn(area('front'), {
          text: 'Hello print',
          wrapMode: 'box',
          wrappedLines: ['Totally', 'different'],
        }),
      ]).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/does not reconcile/);
    });

    it('rejects bidi control characters in stored text and wrappedLines', async () => {
      await postFrontObjects([textIn(area('front'), { text: 'bad\u200Ftext' })]).expect(400);
      await postFrontObjects([
        textIn(area('front'), {
          text: 'Hello print',
          wrapMode: 'box',
          wrappedLines: ['Hello\u202Eprint'],
        }),
      ]).expect(400);
    });

    it('rejects v1.6 text fields on an image object', async () => {
      const asset = await uploadPng();
      const res = await postFrontObjects([
        { ...objectIn(area('front'), asset.id), type: 'image', direction: 'rtl' },
      ]).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/must not carry text fields/);
    });

    it('keeps pre-v1.6 explicit-break behavior: 9 raw lines rejected without box mode', async () => {
      await postFrontObjects([
        textIn(area('front'), { text: Array(9).fill('x').join('\n') }),
      ]).expect(400);
    });
  });

  describe('text outline and shadow (v1.8)', () => {
    const textIn = (a: PrintAreaDto, overrides: Partial<Record<string, unknown>> = {}) => ({
      type: 'text',
      text: 'Effects',
      fontFamily: 'inter',
      fontSize: 48,
      color: '#cc0033',
      align: 'center',
      x: a.x + a.width / 2,
      y: a.y + a.height / 2,
      width: 180,
      height: 60,
      rotation: 0,
      ...overrides,
    });

    const postFront = (objects: object[]) =>
      http()
        .post('/designs')
        .send({ templateId: template.id, placements: [{ printAreaKey: 'front', objects }] });

    it('saves, renders, and reopens text with an outline and a shadow', async () => {
      const res = await postFront([
        textIn(area('front'), {
          outline: { color: '#ffffff', width: 4 },
          shadow: { color: '#000000', offsetX: 6, offsetY: -6 },
        }),
      ]).expect(201);
      const dto = res.body as DesignProjectDto;
      expect(dto.design.placements[0]!.objects[0]).toMatchObject({
        outline: { color: '#ffffff', width: 4 },
        shadow: { color: '#000000', offsetX: 6, offsetY: -6 },
      });

      await http().post(`/designs/${dto.id}/render`).expect(201);
      await http().get(`/designs/${dto.id}/preview/front`).expect(200);

      const reopened = await http().get(`/designs/${dto.id}`).expect(200);
      expect((reopened.body as DesignProjectDto).design.placements[0]!.objects[0]).toMatchObject({
        outline: { color: '#ffffff', width: 4 },
        shadow: { color: '#000000', offsetX: 6, offsetY: -6 },
      });
    });

    it('rejects out-of-range outline widths and shadow offsets (DTO level)', async () => {
      await postFront([textIn(area('front'), { outline: { color: '#ffffff', width: 0 } })]).expect(400);
      await postFront([textIn(area('front'), { outline: { color: '#ffffff', width: 21 } })]).expect(400);
      await postFront([
        textIn(area('front'), { shadow: { color: '#000000', offsetX: 26, offsetY: 0 } }),
      ]).expect(400);
    });

    it('rejects bad effect colors and a both-zero shadow offset', async () => {
      await postFront([textIn(area('front'), { outline: { color: 'white', width: 4 } })]).expect(400);
      const res = await postFront([
        textIn(area('front'), { shadow: { color: '#000000', offsetX: 0, offsetY: 0 } }),
      ]).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/not be zero/i);
    });

    it('rejects effects on image objects (kind purity)', async () => {
      const asset = await uploadPng();
      const res = await postFront([
        { ...objectIn(area('front'), asset.id), shadow: { color: '#000000', offsetX: 4, offsetY: 4 } },
      ]).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/must not carry text fields/i);
    });

    it('saves, renders, and reopens text with letter spacing', async () => {
      const res = await postFront([textIn(area('front'), { letterSpacing: 12 })]).expect(201);
      const dto = res.body as DesignProjectDto;
      expect(dto.design.placements[0]!.objects[0]).toMatchObject({ letterSpacing: 12 });

      await http().post(`/designs/${dto.id}/render`).expect(201);

      const reopened = await http().get(`/designs/${dto.id}`).expect(200);
      expect((reopened.body as DesignProjectDto).design.placements[0]!.objects[0]).toMatchObject({
        letterSpacing: 12,
      });
    });

    it('rejects out-of-range letter spacing', async () => {
      await postFront([textIn(area('front'), { letterSpacing: -21 })]).expect(400);
      await postFront([textIn(area('front'), { letterSpacing: 101 })]).expect(400);
    });

    it('saves, renders, and reopens arced text', async () => {
      const res = await postFront([textIn(area('front'), { arc: 120, letterSpacing: 6 })]).expect(201);
      const dto = res.body as DesignProjectDto;
      expect(dto.design.placements[0]!.objects[0]).toMatchObject({ arc: 120, letterSpacing: 6 });

      await http().post(`/designs/${dto.id}/render`).expect(201);
      await http().get(`/designs/${dto.id}/preview/front`).expect(200);

      const reopened = await http().get(`/designs/${dto.id}`).expect(200);
      expect((reopened.body as DesignProjectDto).design.placements[0]!.objects[0]).toMatchObject({
        arc: 120,
      });
    });

    it('rejects invalid arcs and forbidden arc combinations', async () => {
      await postFront([textIn(area('front'), { arc: 0 })]).expect(400);
      await postFront([textIn(area('front'), { arc: 181 })]).expect(400);
      const multi = await postFront([textIn(area('front'), { arc: 90, text: 'two\nlines' })]).expect(400);
      expect(JSON.stringify(multi.body)).toMatch(/single line/i);
      const rtl = await postFront([textIn(area('front'), { arc: 90, text: 'مرحبا' })]).expect(400);
      expect(JSON.stringify(rtl.body)).toMatch(/right-to-left/i);
      const combo = await postFront([
        textIn(area('front'), { arc: 90, outline: { color: '#ffffff', width: 4 } }),
      ]).expect(400);
      expect(JSON.stringify(combo.body)).toMatch(/outline or shadow/i);
    });

    it('renders text containing markup characters literally (escaping regression)', async () => {
      const res = await postFront([
        textIn(area('front'), { text: 'a < b & <b>c</b>', letterSpacing: 8 }),
      ]).expect(201);
      const dto = res.body as DesignProjectDto;
      await http().post(`/designs/${dto.id}/render`).expect(201);
      await http().get(`/designs/${dto.id}/preview/front`).expect(200);
    });
  });

  describe('GET /fonts/:key/file', () => {
    it('streams a whitelisted font as TTF', async () => {
      const res = await http()
        .get('/fonts/inter/file')
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (c: Buffer) => chunks.push(c));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toMatch(/font\/ttf/);
      // TrueType magic: 00 01 00 00.
      expect((res.body as Buffer).subarray(0, 4).equals(Buffer.from([0x00, 0x01, 0x00, 0x00]))).toBe(true);
    });

    it('404s for unknown font keys without touching the filesystem layout', async () => {
      await http().get('/fonts/comic-sans/file').expect(404);
      await http().get('/fonts/..%2F..%2Fsecret/file').expect(404);
    });
  });

  describe('GET /designs (design library)', () => {
    // Each test owns the whole table for deterministic list assertions. Earlier blocks
    // create their own fixtures per test, so wiping here cannot break them.
    beforeEach(async () => {
      await prisma.designProject.deleteMany();
    });

    const createFrontOnlyDesign = async (assetId: string): Promise<DesignProjectDto> => {
      const res = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          placements: [{ printAreaKey: 'front', objects: [objectIn(area('front'), assetId)] }],
        })
        .expect(201);
      return res.body as DesignProjectDto;
    };

    it('returns an empty list when no designs exist', async () => {
      const res = await http().get('/designs').expect(200);
      expect(res.body).toEqual({ items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 });
    });

    it('lists newest first with template info and per-area object counts, no design document', async () => {
      const asset = await uploadPng();
      const a = await createFrontBackDesign(asset.id);
      const bRes = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          placements: [
            {
              printAreaKey: 'back',
              objects: [objectIn(area('back'), asset.id), objectIn(area('back'), asset.id)],
            },
          ],
        })
        .expect(201);
      const b = bRes.body as DesignProjectDto;

      // Updating A makes it the most recently touched design -> first in the list.
      await http()
        .put(`/designs/${a.id}`)
        .send({
          templateId: template.id,
          placements: [{ printAreaKey: 'front', objects: [objectIn(area('front'), asset.id)] }],
        })
        .expect(200);

      const res = await http().get('/designs').expect(200);
      const list = res.body as DesignListDto;

      expect(list.totalItems).toBe(2);
      expect(list.totalPages).toBe(1);
      expect(list.items.map((i) => i.id)).toEqual([a.id, b.id]);

      const [first, second] = list.items as [DesignListItemDto, DesignListItemDto];
      expect(first.template).toEqual({ id: template.id, name: 'Classic Tee', slug: 'classic-tee' });
      expect(first.placements).toEqual([
        { printAreaKey: 'front', printAreaName: area('front').name, objectCount: 1, imageCount: 1, textCount: 0 },
      ]);
      expect(second.placements).toEqual([
        { printAreaKey: 'back', printAreaName: area('back').name, objectCount: 2, imageCount: 2, textCount: 0 },
      ]);
      expect(Date.parse(first.createdAt)).not.toBeNaN();
      expect(Date.parse(first.updatedAt)).not.toBeNaN();

      // Summary only: the list never carries the design document.
      expect(first).not.toHaveProperty('design');
      expect(JSON.stringify(list)).not.toMatch(/designJson|"version"|"rotation"/);

      // GET /designs/:id keeps working alongside the list route.
      const single = await http().get(`/designs/${a.id}`).expect(200);
      expect((single.body as DesignProjectDto).id).toBe(a.id);
    });

    it('breaks updatedAt ties by id DESC so pagination never duplicates or skips rows', async () => {
      const sharedTimestamp = new Date('2026-01-01T00:00:00.000Z');
      const lowId = '00000000-0000-4000-8000-00000000000a';
      const highId = '00000000-0000-4000-8000-00000000000b';
      for (const id of [lowId, highId]) {
        await prisma.designProject.create({
          data: {
            id,
            productTemplateId: template.id,
            designJson: { version: 2, templateId: template.id, placements: [] },
            createdAt: sharedTimestamp,
            updatedAt: sharedTimestamp,
          },
        });
      }

      const res = await http().get('/designs').expect(200);
      const ids = (res.body as DesignListDto).items.map((i) => i.id);
      expect(ids).toEqual([highId, lowId]);
    });

    it('paginates 5 designs as 2/2/1 with no duplicates across pages', async () => {
      const asset = await uploadPng();
      for (let i = 0; i < 5; i += 1) {
        await createFrontOnlyDesign(asset.id);
      }

      const pages = [];
      for (const page of [1, 2, 3]) {
        const res = await http().get(`/designs?page=${page}&pageSize=2`).expect(200);
        pages.push(res.body as DesignListDto);
      }

      expect(pages.map((p) => p.items.length)).toEqual([2, 2, 1]);
      for (const page of pages) {
        expect(page.totalItems).toBe(5);
        expect(page.totalPages).toBe(3);
        expect(page.pageSize).toBe(2);
      }
      const allIds = pages.flatMap((p) => p.items.map((i) => i.id));
      expect(new Set(allIds).size).toBe(5);
    });

    it('clamps out-of-range page and pageSize instead of erroring', async () => {
      const oversized = await http().get('/designs?pageSize=500').expect(200);
      expect((oversized.body as DesignListDto).pageSize).toBe(50);

      const zeroSize = await http().get('/designs?pageSize=0').expect(200);
      expect((zeroSize.body as DesignListDto).pageSize).toBe(1);

      const zeroPage = await http().get('/designs?page=0').expect(200);
      expect((zeroPage.body as DesignListDto).page).toBe(1);

      // A page past the end is empty but reports correct totals.
      const beyond = await http().get('/designs?page=99').expect(200);
      expect((beyond.body as DesignListDto).items).toEqual([]);
      expect((beyond.body as DesignListDto).page).toBe(99);
    });

    it('400s on non-integer params and unknown query params', async () => {
      await http().get('/designs?page=abc').expect(400);
      await http().get('/designs?page=1.5').expect(400);
      await http().get('/designs?pageSize=abc').expect(400);
      await http().get('/designs?hacker=1').expect(400); // forbidNonWhitelisted
    });

    it('carries preview metadata for rendered designs, ordered by area sortOrder, with no path leaks', async () => {
      const asset = await uploadPng();
      const design = await createFrontBackDesign(asset.id);
      await http().post(`/designs/${design.id}/render`).expect(201);

      const res = await http().get('/designs').expect(200);
      const list = res.body as DesignListDto;
      const item = list.items.find((i) => i.id === design.id)!;
      expect(item).toBeDefined();

      // front before back: template sortOrder, not render or key order.
      expect(item.previews.map((p) => p.printAreaKey)).toEqual(['front', 'back']);
      for (const preview of item.previews) {
        expect(preview.previewUrl).toBe(`/designs/${design.id}/preview/${preview.printAreaKey}`);
        expect(Date.parse(preview.renderedAt)).not.toBeNaN();
      }

      const raw = JSON.stringify(list);
      expect(raw).not.toMatch(/storagePath|previewPaths/);
      expect(raw).not.toMatch(/previews[\\/][^"]*\.png/); // raw storage prefix
      expect(raw).not.toMatch(/[A-Z]:\\\\/); // no Windows absolute paths
      expect(raw).not.toMatch(/(^|[^:])\/(home|var|tmp)\//); // no Unix absolute paths
    });

    it('does not 500 the list when one stored document is corrupt', async () => {
      const asset = await uploadPng();
      const good = await createFrontBackDesign(asset.id);
      const corrupt = await prisma.designProject.create({
        data: {
          productTemplateId: template.id,
          designJson: { version: 99, nonsense: true },
        },
      });

      const res = await http().get('/designs').expect(200);
      const list = res.body as DesignListDto;
      expect(list.totalItems).toBe(2);

      const corruptItem = list.items.find((i) => i.id === corrupt.id)!;
      expect(corruptItem).toBeDefined();
      expect(corruptItem.placements).toEqual([]); // degraded, not dropped
      expect(corruptItem.template.slug).toBe('classic-tee');

      const goodItem = list.items.find((i) => i.id === good.id)!;
      expect(goodItem.placements).toHaveLength(2);

      // The single-design route still reports the corruption loudly.
      await http().get(`/designs/${corrupt.id}`).expect(500);
    });
  });

  describe('print quality warnings (advisory)', () => {
    // A square asset stretched over the whole front area is governed by the
    // area's taller (vertical) physical axis. Expected DPI derives from the
    // SEEDED physical size, so tuning the print-area geometry in the seed
    // never silently breaks these tests.
    const frontDpi = (px: number) =>
      Math.round(Math.min(px / area('front').widthInches!, px / area('front').heightInches!));
    /** Smallest square source that prints the front area at >= the given DPI. */
    const pxForDpi = (dpi: number) =>
      Math.ceil(dpi * Math.max(area('front').widthInches!, area('front').heightInches!));

    const fullFrontObject = (assetId: string) => {
      const front = area('front');
      return {
        assetId,
        x: front.x + front.width / 2,
        y: front.y + front.height / 2,
        width: front.width,
        height: front.height,
        rotation: 0,
      };
    };

    const createFrontDesign = async (object: object): Promise<DesignProjectDto> => {
      const res = await http()
        .post('/designs')
        .send({ templateId: template.id, placements: [{ printAreaKey: 'front', objects: [object] }] })
        .expect(201); // advisory: poor quality never blocks the save
      return res.body as DesignProjectDto;
    };

    it('seeded template carries the physical print sizes', () => {
      expect(area('front').widthInches).toBe(16);
      expect(area('front').heightInches).toBe(22.8);
      expect(area('back').widthInches).toBe(16);
      expect(area('back').heightInches).toBe(22.7);
    });

    it('flags a low-res image as poor without blocking save or render', async () => {
      const tiny = await uploadPng(64, 64);
      const design = await createFrontDesign(fullFrontObject(tiny.id));

      expect(design.qualityWarnings).toHaveLength(1);
      const warning = design.qualityWarnings[0]!;
      expect(warning).toMatchObject({
        printAreaKey: 'front',
        objectIndex: 0,
        assetId: tiny.id,
        level: 'poor',
      });
      // 64px over the full area: single-digit DPI, computed from the seed.
      expect(warning.effectiveDpi).toBe(frontDpi(64));

      // GET returns the same recomputed warnings.
      const fetched = await http().get(`/designs/${design.id}`).expect(200);
      expect((fetched.body as DesignProjectDto).qualityWarnings).toEqual(design.qualityWarnings);

      // Render is also not blocked and produces a real preview.
      await http().post(`/designs/${design.id}/render`).expect(201);
      await http().get(`/designs/${design.id}/preview/front`).expect(200);
    });

    it('returns a warning level for mid-res and no warnings for hi-res artwork', async () => {
      // ~110 DPI lands in the warning band (100..149).
      const midPx = pxForDpi(110);
      const mid = await uploadPng(midPx, midPx);
      const midDesign = await createFrontDesign(fullFrontObject(mid.id));
      expect(midDesign.qualityWarnings).toHaveLength(1);
      expect(midDesign.qualityWarnings[0]!.level).toBe('warning');
      expect(midDesign.qualityWarnings[0]!.effectiveDpi).toBe(frontDpi(midPx));

      // ~160 DPI clears the 150 threshold: ok, list stays empty.
      const hiPx = pxForDpi(160);
      const hi = await uploadPng(hiPx, hiPx);
      const hiDesign = await createFrontDesign(fullFrontObject(hi.id));
      expect(hiDesign.qualityWarnings).toEqual([]);
    });

    it('update replacing low-res artwork with hi-res clears the warnings', async () => {
      const tiny = await uploadPng(64, 64);
      const design = await createFrontDesign(fullFrontObject(tiny.id));
      expect(design.qualityWarnings).toHaveLength(1);

      const hiPx = pxForDpi(160);
      const hi = await uploadPng(hiPx, hiPx);
      const updated = await http()
        .put(`/designs/${design.id}`)
        .send({
          templateId: template.id,
          placements: [{ printAreaKey: 'front', objects: [fullFrontObject(hi.id)] }],
        })
        .expect(200);
      expect((updated.body as DesignProjectDto).qualityWarnings).toEqual([]);
    });

    it('list rows carry worstQualityLevel; corrupt rows degrade to null', async () => {
      await prisma.designProject.deleteMany();

      const tiny = await uploadPng(64, 64);
      const poor = await createFrontDesign(fullFrontObject(tiny.id));
      const hiPx = pxForDpi(160);
      const hi = await uploadPng(hiPx, hiPx);
      const ok = await createFrontDesign(fullFrontObject(hi.id));
      const corrupt = await prisma.designProject.create({
        data: { productTemplateId: template.id, designJson: { version: 99 } },
      });

      const res = await http().get('/designs').expect(200);
      const list = res.body as DesignListDto;
      const byId = new Map(list.items.map((i) => [i.id, i]));

      expect(byId.get(poor.id)!.worstQualityLevel).toBe('poor');
      expect(byId.get(ok.id)!.worstQualityLevel).toBe('ok');
      expect(byId.get(corrupt.id)!.worstQualityLevel).toBeNull();
    });

    it('leaks no storage paths through the quality fields', async () => {
      const tiny = await uploadPng(64, 64);
      const design = await createFrontDesign(fullFrontObject(tiny.id));

      const raw = JSON.stringify(design.qualityWarnings);
      expect(raw).not.toMatch(/storagePath|uploads[\\/]|previews[\\/]/);
      expect(raw).not.toMatch(/[A-Z]:\\\\/);
      expect(raw).not.toMatch(/(^|[^:])\/(home|var|tmp)\//);

      const listRaw = JSON.stringify((await http().get('/designs').expect(200)).body);
      expect(listRaw).not.toMatch(/storagePath|uploads[\\/]/);
    });

    it('text-only designs report no quality warnings and a null worst level', async () => {
      await prisma.designProject.deleteMany();
      const front = area('front');
      const design = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          placements: [
            {
              printAreaKey: 'front',
              objects: [
                {
                  type: 'text',
                  text: 'Vector text',
                  fontFamily: 'inter',
                  fontSize: 40,
                  color: '#101010',
                  align: 'center',
                  x: front.x + front.width / 2,
                  y: front.y + front.height / 2,
                  width: 150,
                  height: 50,
                  rotation: 0,
                },
              ],
            },
          ],
        })
        .expect(201);
      expect((design.body as DesignProjectDto).qualityWarnings).toEqual([]);

      const res = await http().get('/designs').expect(200);
      const item = (res.body as DesignListDto).items.find((i) => i.id === design.body.id)!;
      expect(item.worstQualityLevel).toBeNull();
    });

    it('stores EXIF-rotated upload dimensions as the normalized pixels', async () => {
      // Orientation 6 = 90deg rotation: a 100x50 source renders as 50x100.
      const rotated = await sharp({
        create: { width: 100, height: 50, channels: 3, background: { r: 10, g: 10, b: 10 } },
      })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer();

      const res = await http()
        .post('/assets/upload')
        .attach('file', rotated, { filename: 'rotated.jpg', contentType: 'image/jpeg' })
        .expect(201);
      const asset = res.body as UploadedAssetDto;
      expect(asset.width).toBe(50);
      expect(asset.height).toBe(100);

      // The stored file really has those pixels (not just the DB record).
      const fileRes = await http().get(asset.url).buffer(true).parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      }).expect(200);
      const meta = await sharp(fileRes.body as Buffer).metadata();
      expect(meta.width).toBe(50);
      expect(meta.height).toBe(100);
    });
  });
});
