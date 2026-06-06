import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DesignProject, PrintArea, ProductTemplate } from '@prisma/client';
import {
  normalizeDesignDocument,
  validateDesignPlacements,
  type AnyDesignDocument,
  type DesignDocument,
  type DesignPreviewDto,
  type DesignProjectDto,
  type PlacementValidationError,
  type RenderResultDto,
} from '@foloprint/shared';
import { renderMockup } from '@foloprint/renderer';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type { CreateDesignDto } from './dto/create-design.dto';

type DesignWithTemplate = DesignProject & {
  productTemplate: ProductTemplate & { printAreas: PrintArea[] };
};

/** Stored shape of DesignProject.previewPaths: printAreaKey -> file + render time. */
interface StoredPreview {
  /** Storage key relative to STORAGE_ROOT; never serialized to a response. */
  path: string;
  renderedAt: string;
}
type PreviewPathsMap = Record<string, StoredPreview>;

@Injectable()
export class DesignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Server-side authority for design validity: template must exist and be active, every
   * placement must target an existing active print area exactly once with at least one
   * object, every referenced asset must exist, and every object must lie fully inside
   * its own placement's print area (rotated corners checked). Client clamping is UX only.
   */
  async create(dto: CreateDesignDto): Promise<DesignProjectDto> {
    const designJson = await this.validateAndBuildDocument(dto);

    const design = await this.prisma.designProject.create({
      data: {
        productTemplateId: designJson.templateId,
        designJson: designJson as unknown as Prisma.InputJsonValue,
      },
      include: { productTemplate: { include: { printAreas: true } } },
    });

    return this.toDto(design);
  }

  /**
   * Replaces the design document of an existing design (PUT semantics).
   * The template is immutable for a design. Every stale area preview is deleted because
   * none of them match the new document; a legacy v1 document is upgraded to v2 simply
   * by being overwritten with the validated v2 payload.
   */
  async update(id: string, dto: CreateDesignDto): Promise<DesignProjectDto> {
    const existing = await this.findEntity(id);
    if (dto.templateId !== existing.productTemplateId) {
      throw new BadRequestException(
        'Design belongs to a different template; templateId cannot change on update',
      );
    }

    const designJson = await this.validateAndBuildDocument(dto);

    await this.removePreviewFiles(this.previewPathsOf(existing));

    const updated = await this.prisma.designProject.update({
      where: { id },
      data: {
        designJson: designJson as unknown as Prisma.InputJsonValue,
        previewPaths: Prisma.DbNull,
      },
      include: { productTemplate: { include: { printAreas: true } } },
    });

    return this.toDto(updated);
  }

  /** Full validation chain shared by create and update. Returns the normalized document. */
  private async validateAndBuildDocument(dto: CreateDesignDto): Promise<DesignDocument> {
    const template = await this.prisma.productTemplate.findFirst({
      where: { id: dto.templateId, active: true },
      include: { printAreas: true },
    });
    if (!template) {
      throw new NotFoundException(`Template "${dto.templateId}" not found`);
    }

    // The validator gets ALL areas with their active flag so that "inactive" and
    // "unknown" produce distinct, accurate error messages.
    const validation = validateDesignPlacements(dto.placements, template.printAreas);
    if (!validation.valid) {
      throw new BadRequestException({
        message: 'Design validation failed',
        errors: validation.errors.map((e) => this.formatPlacementError(e)),
      });
    }

    await this.assertAssetsExist(dto.placements.flatMap((p) => p.objects.map((o) => o.assetId)));

    return {
      version: 2,
      templateId: template.id,
      placements: dto.placements.map((placement) => ({
        printAreaKey: placement.printAreaKey,
        objects: placement.objects.map((o) => ({
          assetId: o.assetId,
          x: o.x,
          y: o.y,
          width: o.width,
          height: o.height,
          rotation: o.rotation,
        })),
      })),
    };
  }

  async findById(id: string): Promise<DesignProjectDto> {
    return this.toDto(await this.findEntity(id));
  }

  /**
   * Renders every placement of the design synchronously (MVP; a queue replaces this
   * later), one mockup per print area, using the area's own view images with fallback
   * to the template-level images. Geometry is re-validated against the CURRENT print
   * areas before any pixel work; previous previews are replaced atomically at the end.
   */
  async render(id: string): Promise<RenderResultDto> {
    const design = await this.findEntity(id);
    const document = this.normalizedDocumentOf(design);
    const template = design.productTemplate;

    const validation = validateDesignPlacements(document.placements, template.printAreas);
    if (!validation.valid) {
      throw new BadRequestException({
        message: 'Stored design no longer passes validation',
        errors: validation.errors.map((e) => this.formatPlacementError(e)),
      });
    }

    const assetIds = [...new Set(document.placements.flatMap((p) => p.objects.map((o) => o.assetId)))];
    const assets = await this.prisma.uploadedAsset.findMany({ where: { id: { in: assetIds } } });
    const assetById = new Map(assets.map((a) => [a.id, a]));
    const areaByKey = new Map(template.printAreas.map((a) => [a.key, a]));

    const renderedAt = new Date().toISOString();
    const nextPreviews: PreviewPathsMap = {};

    for (const placement of document.placements) {
      const area = areaByKey.get(placement.printAreaKey)!; // validated above

      const objects = placement.objects.map((obj, index) => {
        const asset = assetById.get(obj.assetId);
        if (!asset) {
          throw new BadRequestException(
            `placements[${placement.printAreaKey}].objects[${index}]: asset "${obj.assetId}" no longer exists`,
          );
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

      // Area-specific view images with template-level fallback.
      const baseImagePath = area.baseImagePath ?? template.baseImagePath;
      const overlayImagePath = area.overlayImagePath ?? template.overlayImagePath;

      let png: Buffer;
      try {
        png = await renderMockup({
          baseImagePath: this.storage.resolvePath(baseImagePath),
          overlayImagePath: overlayImagePath ? this.storage.resolvePath(overlayImagePath) : null,
          canvasWidth: template.canvasWidth,
          canvasHeight: template.canvasHeight,
          printArea: area,
          objects,
        });
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new InternalServerErrorException(
          `Mockup rendering failed for area "${placement.printAreaKey}": ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }

      const previewPath = `previews/${design.id}/${placement.printAreaKey}.png`;
      await this.storage.save(previewPath, png);
      nextPreviews[placement.printAreaKey] = { path: previewPath, renderedAt };
    }

    // Remove previews of areas that are no longer part of the document (the placement
    // was deleted since the last render); same-key files were just overwritten.
    const stale = this.previewPathsOf(design);
    for (const [key, preview] of Object.entries(stale)) {
      if (!nextPreviews[key]) {
        await this.storage.remove(preview.path);
      }
    }

    await this.prisma.designProject.update({
      where: { id: design.id },
      data: { previewPaths: nextPreviews as unknown as Prisma.InputJsonValue },
    });

    return {
      designId: design.id,
      previews: this.toPreviewDtos(design.id, nextPreviews, template.printAreas),
    };
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

  /** Resolves the stored preview file for one area, for streaming. 404 when unrendered. */
  async findPreview(id: string, printAreaKey: string): Promise<string> {
    const design = await this.findEntity(id);
    const preview = this.previewPathsOf(design)[printAreaKey];
    if (!preview) {
      throw new NotFoundException(
        `No rendered preview for print area "${printAreaKey}" on this design`,
      );
    }
    return preview.path;
  }

  /** The stored document, normalized to v2 regardless of the version it was saved as. */
  private normalizedDocumentOf(design: DesignProject): DesignDocument {
    try {
      return normalizeDesignDocument(design.designJson as unknown as AnyDesignDocument);
    } catch {
      // An unknown version in the DB is corruption, not user error.
      throw new InternalServerErrorException(`Design "${design.id}" has an unreadable document`);
    }
  }

  private previewPathsOf(design: DesignProject): PreviewPathsMap {
    return (design.previewPaths ?? {}) as unknown as PreviewPathsMap;
  }

  private async removePreviewFiles(previews: PreviewPathsMap): Promise<void> {
    for (const preview of Object.values(previews)) {
      await this.storage.remove(preview.path);
    }
  }

  /** Previews follow the template's area display order (front before back), not key order. */
  private toPreviewDtos(
    designId: string,
    previews: PreviewPathsMap,
    printAreas: PrintArea[],
  ): DesignPreviewDto[] {
    const orderOf = new Map(printAreas.map((a) => [a.key, a.sortOrder]));
    return Object.entries(previews)
      .map(([printAreaKey, preview]) => ({
        printAreaKey,
        previewUrl: `/designs/${designId}/preview/${encodeURIComponent(printAreaKey)}`,
        renderedAt: preview.renderedAt,
      }))
      .sort(
        (a, b) =>
          (orderOf.get(a.printAreaKey) ?? Number.MAX_SAFE_INTEGER) -
            (orderOf.get(b.printAreaKey) ?? Number.MAX_SAFE_INTEGER) ||
          a.printAreaKey.localeCompare(b.printAreaKey),
      );
  }

  private formatPlacementError(error: PlacementValidationError): string {
    const objectPart = error.objectIndex !== undefined ? `.objects[${error.objectIndex}]` : '';
    return `placements[${error.placementIndex}]${objectPart}: ${error.message}`;
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
      design: this.normalizedDocumentOf(design),
      previews: this.toPreviewDtos(
        design.id,
        this.previewPathsOf(design),
        design.productTemplate.printAreas,
      ),
      createdAt: design.createdAt.toISOString(),
      updatedAt: design.updatedAt.toISOString(),
    };
  }
}
