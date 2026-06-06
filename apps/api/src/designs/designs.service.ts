import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { DesignProject, PrintArea, Prisma, ProductTemplate } from '@prisma/client';
import {
  validateDesignObjects,
  type DesignDocument,
  type DesignProjectDto,
  type RenderResultDto,
} from '@foloprint/shared';
import { renderMockup } from '@foloprint/renderer';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type { CreateDesignDto } from './dto/create-design.dto';

type DesignWithTemplate = DesignProject & {
  productTemplate: ProductTemplate & { printAreas: PrintArea[] };
};

@Injectable()
export class DesignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Server-side authority for design validity: template + print area must exist and be
   * active, every referenced asset must exist, and every object must lie fully inside
   * the print area (rotated corners checked). Client clamping is UX only.
   */
  async create(dto: CreateDesignDto): Promise<DesignProjectDto> {
    const template = await this.prisma.productTemplate.findFirst({
      where: { id: dto.templateId, active: true },
      include: { printAreas: { where: { active: true } } },
    });
    if (!template) {
      throw new NotFoundException(`Template "${dto.templateId}" not found`);
    }

    const printArea = template.printAreas.find((area) => area.key === dto.printAreaKey);
    if (!printArea) {
      throw new BadRequestException(
        `Print area "${dto.printAreaKey}" does not exist on template "${template.slug}"`,
      );
    }

    await this.assertAssetsExist(dto.objects.map((o) => o.assetId));

    const validation = validateDesignObjects(dto.objects, printArea);
    if (!validation.valid) {
      throw new BadRequestException({
        message: 'Design validation failed',
        errors: validation.errors.map((e) => `objects[${e.index}]: ${e.message}`),
      });
    }

    const designJson: DesignDocument = {
      version: 1,
      templateId: template.id,
      printAreaKey: dto.printAreaKey,
      objects: dto.objects.map((o) => ({
        assetId: o.assetId,
        x: o.x,
        y: o.y,
        width: o.width,
        height: o.height,
        rotation: o.rotation,
      })),
    };

    const design = await this.prisma.designProject.create({
      data: {
        productTemplateId: template.id,
        designJson: designJson as unknown as Prisma.InputJsonValue,
      },
      include: { productTemplate: { include: { printAreas: true } } },
    });

    return this.toDto(design);
  }

  async findById(id: string): Promise<DesignProjectDto> {
    return this.toDto(await this.findEntity(id));
  }

  /**
   * Renders the mockup synchronously (MVP; a queue replaces this later).
   * Geometry is re-validated against the CURRENT print area before any pixel work.
   */
  async render(id: string): Promise<RenderResultDto> {
    const design = await this.findEntity(id);
    const document = design.designJson as unknown as DesignDocument;

    const printArea = design.productTemplate.printAreas.find(
      (area) => area.key === document.printAreaKey && area.active,
    );
    if (!printArea) {
      throw new BadRequestException(
        `Print area "${document.printAreaKey}" is no longer available on this template`,
      );
    }

    const validation = validateDesignObjects(document.objects, printArea);
    if (!validation.valid) {
      throw new BadRequestException({
        message: 'Stored design no longer passes validation',
        errors: validation.errors.map((e) => `objects[${e.index}]: ${e.message}`),
      });
    }

    const assetIds = [...new Set(document.objects.map((o) => o.assetId))];
    const assets = await this.prisma.uploadedAsset.findMany({ where: { id: { in: assetIds } } });
    const assetById = new Map(assets.map((a) => [a.id, a]));

    const objects = document.objects.map((obj, index) => {
      const asset = assetById.get(obj.assetId);
      if (!asset) {
        throw new BadRequestException(`objects[${index}]: asset "${obj.assetId}" no longer exists`);
      }
      return {
        imagePath: this.storage.resolvePath(asset.storagePath),
        x: obj.x,
        y: obj.y,
        width: obj.width,
        height: obj.height,
        rotation: obj.rotation,
      };
    });

    let png: Buffer;
    try {
      png = await renderMockup({
        baseImagePath: this.storage.resolvePath(design.productTemplate.baseImagePath),
        overlayImagePath: design.productTemplate.overlayImagePath
          ? this.storage.resolvePath(design.productTemplate.overlayImagePath)
          : null,
        canvasWidth: design.productTemplate.canvasWidth,
        canvasHeight: design.productTemplate.canvasHeight,
        printArea,
        objects,
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException(
        `Mockup rendering failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    const previewPath = `previews/${design.id}.png`;
    await this.storage.save(previewPath, png);
    await this.prisma.designProject.update({ where: { id: design.id }, data: { previewPath } });

    return { id: design.id, previewUrl: `/designs/${design.id}/preview` };
  }

  async findEntity(id: string): Promise<DesignWithTemplate> {
    const design = await this.prisma.designProject.findUnique({
      where: { id },
      include: { productTemplate: { include: { printAreas: true } } },
    });
    if (!design) {
      throw new NotFoundException(`Design "${id}" not found`);
    }
    return design;
  }

  private async assertAssetsExist(assetIds: string[]): Promise<void> {
    const unique = [...new Set(assetIds)];
    const found = await this.prisma.uploadedAsset.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      const existing = new Set(found.map((a) => a.id));
      const missing = unique.filter((id) => !existing.has(id));
      throw new BadRequestException(`Unknown asset id(s): ${missing.join(', ')}`);
    }
  }

  private toDto(design: DesignWithTemplate): DesignProjectDto {
    return {
      id: design.id,
      templateId: design.productTemplateId,
      templateSlug: design.productTemplate.slug,
      design: design.designJson as unknown as DesignDocument,
      previewUrl: design.previewPath ? `/designs/${design.id}/preview` : null,
      createdAt: design.createdAt.toISOString(),
      updatedAt: design.updatedAt.toISOString(),
    };
  }
}
