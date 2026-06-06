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
import type { ProductTemplateDto, UploadedAssetDto } from '@foloprint/shared';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('FoloPrint Design Studio API (e2e)', () => {
  let app: INestApplication;
  let http: () => ReturnType<typeof request>;
  let template: ProductTemplateDto;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    http = () => request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
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

  describe('GET /health', () => {
    it('reports ok', async () => {
      const res = await http().get('/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('foloprint-design-studio-api');
    });
  });

  describe('GET /templates', () => {
    it('returns the seeded tee with print areas and no filesystem paths', async () => {
      const res = await http().get('/templates').expect(200);
      const templates = res.body as ProductTemplateDto[];
      expect(templates.length).toBeGreaterThanOrEqual(1);

      const tee = templates.find((t) => t.slug === 'classic-tee');
      expect(tee).toBeDefined();
      template = tee as ProductTemplateDto;

      expect(template.canvasWidth).toBe(1000);
      expect(template.printAreas.length).toBeGreaterThanOrEqual(1);
      expect(template.printAreas[0]?.key).toBe('front');
      expect(template.imageUrl).toBe('/templates/classic-tee/image');

      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/storagePath|baseImagePath|overlayImagePath/);
      expect(raw).not.toMatch(/[A-Z]:\\\\/); // no Windows absolute paths
    });

    it('GET /templates/:slug returns one template, 404 for unknown', async () => {
      const res = await http().get('/templates/classic-tee').expect(200);
      expect((res.body as ProductTemplateDto).slug).toBe('classic-tee');
      await http().get('/templates/does-not-exist').expect(404);
    });

    it('streams the base image as a real PNG', async () => {
      const res = await http()
        .get('/templates/classic-tee/image')
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (c: Buffer) => chunks.push(c));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect((res.body as Buffer).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
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

  describe('POST /designs', () => {
    it('accepts a valid design inside the print area', async () => {
      const asset = await uploadPng();
      const area = template.printAreas[0]!;
      const res = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          printAreaKey: area.key,
          objects: [
            {
              assetId: asset.id,
              x: area.x + area.width / 2,
              y: area.y + area.height / 2,
              width: 120,
              height: 120,
              rotation: 15,
            },
          ],
        })
        .expect(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.previewUrl).toBeNull();
      expect(res.body.design.objects).toHaveLength(1);
    });

    it('rejects an object outside the print area', async () => {
      const asset = await uploadPng();
      const area = template.printAreas[0]!;
      const res = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          printAreaKey: area.key,
          objects: [
            {
              assetId: asset.id,
              x: area.x + area.width + 200, // clearly outside
              y: area.y + 50,
              width: 100,
              height: 100,
              rotation: 0,
            },
          ],
        })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/outside the print area/);
    });

    it('rejects a rotation that pushes corners out even though the unrotated box fits', async () => {
      const asset = await uploadPng();
      const area = template.printAreas[0]!;
      await http()
        .post('/designs')
        .send({
          templateId: template.id,
          printAreaKey: area.key,
          objects: [
            {
              assetId: asset.id,
              x: area.x + area.width / 2,
              y: area.y + area.height / 2,
              width: area.width, // fills the area exactly; any rotation pushes corners out
              height: area.height,
              rotation: 45,
            },
          ],
        })
        .expect(400);
    });

    it('rejects unknown asset ids', async () => {
      const area = template.printAreas[0]!;
      await http()
        .post('/designs')
        .send({
          templateId: template.id,
          printAreaKey: area.key,
          objects: [
            {
              assetId: '00000000-0000-4000-8000-000000000000',
              x: area.x + 100,
              y: area.y + 100,
              width: 50,
              height: 50,
              rotation: 0,
            },
          ],
        })
        .expect(400);
    });

    it('rejects an unknown print area key', async () => {
      const asset = await uploadPng();
      await http()
        .post('/designs')
        .send({
          templateId: template.id,
          printAreaKey: 'sleeve',
          objects: [{ assetId: asset.id, x: 400, y: 400, width: 50, height: 50, rotation: 0 }],
        })
        .expect(400);
    });

    it('rejects extra unknown body fields (forbidNonWhitelisted)', async () => {
      await http()
        .post('/designs')
        .send({ templateId: template.id, printAreaKey: 'front', objects: [], hacker: true })
        .expect(400);
    });
  });

  describe('PUT /designs/:id', () => {
    const createDesign = async (assetId: string) => {
      const area = template.printAreas[0]!;
      const res = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          printAreaKey: area.key,
          objects: [
            {
              assetId,
              x: area.x + area.width / 2,
              y: area.y + area.height / 2,
              width: 120,
              height: 120,
              rotation: 0,
            },
          ],
        })
        .expect(201);
      return res.body as { id: string };
    };

    it('updates a design and clears the stale preview', async () => {
      const asset = await uploadPng();
      const area = template.printAreas[0]!;
      const design = await createDesign(asset.id);

      // Render so a preview exists, then prove the update invalidates it.
      await http().post(`/designs/${design.id}/render`).expect(201);
      await http().get(`/designs/${design.id}/preview`).expect(200);

      const updated = await http()
        .put(`/designs/${design.id}`)
        .send({
          templateId: template.id,
          printAreaKey: area.key,
          objects: [
            {
              assetId: asset.id,
              x: area.x + 80,
              y: area.y + 90,
              width: 100,
              height: 100,
              rotation: 10,
            },
          ],
        })
        .expect(200);

      expect(updated.body.id).toBe(design.id); // same design, no duplicate
      expect(updated.body.previewUrl).toBeNull();
      expect(updated.body.design.objects[0].x).toBe(area.x + 80);

      const refreshed = await http().get(`/designs/${design.id}`).expect(200);
      expect(refreshed.body.previewUrl).toBeNull();
      await http().get(`/designs/${design.id}/preview`).expect(404);
    });

    it('rejects an update with a mismatched template id', async () => {
      const asset = await uploadPng();
      const design = await createDesign(asset.id);
      const area = template.printAreas[0]!;
      const res = await http()
        .put(`/designs/${design.id}`)
        .send({
          templateId: '00000000-0000-4000-8000-000000000000',
          printAreaKey: area.key,
          objects: [{ assetId: asset.id, x: area.x + 80, y: area.y + 80, width: 80, height: 80, rotation: 0 }],
        })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/different template/);
    });

    it('rejects an update with an object outside the print area', async () => {
      const asset = await uploadPng();
      const design = await createDesign(asset.id);
      const area = template.printAreas[0]!;
      await http()
        .put(`/designs/${design.id}`)
        .send({
          templateId: template.id,
          printAreaKey: area.key,
          objects: [
            {
              assetId: asset.id,
              x: area.x + area.width + 300,
              y: area.y + 50,
              width: 100,
              height: 100,
              rotation: 0,
            },
          ],
        })
        .expect(400);
    });

    it('rejects an update referencing an unknown asset', async () => {
      const asset = await uploadPng();
      const design = await createDesign(asset.id);
      const area = template.printAreas[0]!;
      await http()
        .put(`/designs/${design.id}`)
        .send({
          templateId: template.id,
          printAreaKey: area.key,
          objects: [
            {
              assetId: '00000000-0000-4000-8000-000000000000',
              x: area.x + 80,
              y: area.y + 80,
              width: 80,
              height: 80,
              rotation: 0,
            },
          ],
        })
        .expect(400);
    });

    it('404s when updating an unknown design', async () => {
      const asset = await uploadPng();
      const area = template.printAreas[0]!;
      await http()
        .put('/designs/00000000-0000-4000-8000-000000000000')
        .send({
          templateId: template.id,
          printAreaKey: area.key,
          objects: [{ assetId: asset.id, x: area.x + 80, y: area.y + 80, width: 80, height: 80, rotation: 0 }],
        })
        .expect(404);
    });
  });

  describe('render flow', () => {
    it('renders a saved design to a PNG preview', async () => {
      const asset = await uploadPng();
      const area = template.printAreas[0]!;

      const design = await http()
        .post('/designs')
        .send({
          templateId: template.id,
          printAreaKey: area.key,
          objects: [
            {
              assetId: asset.id,
              x: area.x + area.width / 2,
              y: area.y + area.height / 2,
              width: 150,
              height: 150,
              rotation: 30,
            },
          ],
        })
        .expect(201);

      const render = await http().post(`/designs/${design.body.id}/render`).expect(201);
      expect(render.body.previewUrl).toBe(`/designs/${design.body.id}/preview`);

      const preview = await http()
        .get(`/designs/${design.body.id}/preview`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (c: Buffer) => chunks.push(c));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      const body = preview.body as Buffer;
      expect(body.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      const meta = await sharp(body).metadata();
      expect(meta.width).toBe(template.canvasWidth);
      expect(meta.height).toBe(template.canvasHeight);

      const refreshed = await http().get(`/designs/${design.body.id}`).expect(200);
      expect(refreshed.body.previewUrl).toBe(`/designs/${design.body.id}/preview`);
    });

    it('404s for an unrendered design preview and unknown design', async () => {
      await http().get('/designs/00000000-0000-4000-8000-000000000000').expect(404);
      await http().get('/designs/00000000-0000-4000-8000-000000000000/preview').expect(404);
    });
  });
});
