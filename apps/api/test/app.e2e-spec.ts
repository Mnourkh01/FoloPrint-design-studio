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

  const uploadPng = async (): Promise<UploadedAssetDto> => {
    const res = await http()
      .post('/assets/upload')
      .attach('file', await makePng(), { filename: 'logo.png', contentType: 'image/png' })
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

      expect(tee!.canvasWidth).toBe(1000);
      expect(tee!.printAreas.map((a) => a.key)).toEqual(['front', 'back']); // sortOrder, not key-asc
      expect(tee!.imageUrl).toBe('/templates/classic-tee/image');

      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/storagePath|baseImagePath|overlayImagePath/);
      expect(raw).not.toMatch(/[A-Z]:\\\\/); // no Windows absolute paths
      expect(raw).not.toMatch(/(^|[^:])\/(home|var|tmp)\//); // no Unix absolute paths
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
});
