import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  DesignProject,
  PrintArea,
  ProductTemplate,
  TemplateColor,
  TemplateColorAreaImage,
} from '@prisma/client';
import {
  collectQualityWarnings,
  evaluateObjectQuality,
  normalizeDesignDocument,
  printAreaPpi,
  resolveTextDirection,
  validateDesignPlacements,
  worseQualityLevel,
  type AnyDesignDocument,
  type DesignDocument,
  type DesignListDto,
  type DesignListItemDto,
  type DesignObject,
  type DesignPlacementSummaryDto,
  type DesignPreviewDto,
  type DesignProjectDto,
  type ObjectQualityWarningDto,
  type PlacementValidationError,
  type PrintQualityLevel,
  type RenderResultDto,
  type StoredDesignPlacement,
} from '@foloprint/shared';
import { renderMockup, type OverlayBlend, type RenderObject } from '@foloprint/renderer';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type { CreateDesignDto, DesignObjectDto } from './dto/create-design.dto';

type ColorWithAreaImages = TemplateColor & { areaImages: TemplateColorAreaImage[] };
type DesignWithTemplate = DesignProject & {
  productTemplate: ProductTemplate & { printAreas: PrintArea[]; colors: ColorWithAreaImages[] };
};

/** Stored shape of DesignProject.previewPaths: printAreaKey -> file + render time. */
interface StoredPreview {
  /** Storage key relative to STORAGE_ROOT; never serialized to a response. */
  path: string;
  renderedAt: string;
}
type PreviewPathsMap = Record<string, StoredPreview>;

/** Source pixel size of an asset, keyed by id, for the advisory DPI math. */
type AssetDimsMap = Map<string, { width: number | null; height: number | null }>;

@Injectable()
export class DesignsService {
  private readonly logger = new Logger(DesignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Paginated design library, newest update first with id DESC as a deterministic
   * tie-breaker (bulk-created rows can share a timestamp; without it pagination could
   * duplicate or skip rows). findMany and count run in one transaction so the page
   * math is consistent with the rows returned.
   */
  async list(page: number, pageSize: number): Promise<DesignListDto> {
    const [rows, totalItems] = await this.prisma.$transaction([
      this.prisma.designProject.findMany({
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { productTemplate: { include: { printAreas: true, colors: { include: { areaImages: true } } } } },
      }),
      this.prisma.designProject.count(),
    ]);

    // Parse each row's document once; a corrupt row degrades instead of failing the
    // page (existing policy). Asset dims for the DPI math are batched: one query for
    // the whole page, never per row.
    const documents = new Map<string, DesignDocument>();
    for (const row of rows) {
      try {
        documents.set(row.id, this.normalizedDocumentOf(row));
      } catch (error) {
        this.logger.warn(
          `Design "${row.id}" has an unreadable document; listed without placements: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
    const assetDims = await this.assetDimsFor(
      [...documents.values()].flatMap((d) => this.imageAssetIdsOf(d.placements)),
    );

    return {
      items: rows.map((design) => this.toListItemDto(design, documents.get(design.id), assetDims)),
      page,
      pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / pageSize),
    };
  }

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
      include: { productTemplate: { include: { printAreas: true, colors: { include: { areaImages: true } } } } },
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
      include: { productTemplate: { include: { printAreas: true, colors: { include: { areaImages: true } } } } },
    });

    return this.toDto(updated);
  }

  /** Full validation chain shared by create and update. Returns the normalized document. */
  private async validateAndBuildDocument(dto: CreateDesignDto): Promise<DesignDocument> {
    const template = await this.prisma.productTemplate.findFirst({
      where: { id: dto.templateId, active: true },
      include: { printAreas: true, colors: true },
    });
    if (!template) {
      throw new NotFoundException(`Template "${dto.templateId}" not found`);
    }

    // Color is preview-time only, but a stored key must exist on the template so
    // render() never has to guess. Missing colorKey = default color, by contract.
    if (dto.colorKey !== undefined && !template.colors.some((c) => c.active && c.key === dto.colorKey)) {
      throw new BadRequestException(`Template has no color "${dto.colorKey}"`);
    }

    // The validator gets ALL areas with their active flag so that "inactive" and
    // "unknown" produce distinct, accurate error messages. The DTO shape matches the
    // stored-object union structurally; the validator's runtime checks are the authority.
    const validation = validateDesignPlacements(
      dto.placements as unknown as StoredDesignPlacement[],
      template.printAreas,
    );
    if (!validation.valid) {
      throw new BadRequestException({
        message: 'Design validation failed',
        errors: validation.errors.map((e) => this.formatPlacementError(e)),
      });
    }

    await this.assertAssetsExist(this.imageAssetIdsOf(dto.placements));

    return {
      version: 2,
      templateId: template.id,
      // Picked only when present so a pre-v2.0 payload persists byte-identical.
      ...(dto.colorKey !== undefined ? { colorKey: dto.colorKey } : {}),
      placements: dto.placements.map((placement) => ({
        printAreaKey: placement.printAreaKey,
        objects: placement.objects.map((o) => this.toDocumentObject(o)),
      })),
    };
  }

  /**
   * Maps one validated DTO object to its document shape with explicit field picking
   * (never a spread: a spread would persist whatever extra keys survived transforms).
   * A missing type is a legacy image payload.
   */
  private toDocumentObject(o: DesignObjectDto): DesignObject {
    const base = { x: o.x, y: o.y, width: o.width, height: o.height, rotation: o.rotation };
    if (o.type === 'text') {
      return {
        type: 'text',
        text: o.text!,
        fontFamily: o.fontFamily!,
        fontSize: o.fontSize!,
        color: o.color!,
        align: o.align!,
        // Optional v1.6 fields are picked only when present so a pre-v1.6 payload
        // persists byte-identical (normalization adds the defaults at read time).
        ...(o.direction !== undefined ? { direction: o.direction } : {}),
        ...(o.wrapMode !== undefined ? { wrapMode: o.wrapMode } : {}),
        ...(o.wrappedLines !== undefined ? { wrappedLines: o.wrappedLines } : {}),
        // v1.8 effects: explicit field picking, same as everything else here.
        ...(o.outline !== undefined
          ? { outline: { color: o.outline.color, width: o.outline.width } }
          : {}),
        ...(o.shadow !== undefined
          ? { shadow: { color: o.shadow.color, offsetX: o.shadow.offsetX, offsetY: o.shadow.offsetY } }
          : {}),
        ...(o.letterSpacing !== undefined ? { letterSpacing: o.letterSpacing } : {}),
        ...(o.arc !== undefined ? { arc: o.arc } : {}),
        ...base,
      };
    }
    return {
      type: 'image',
      assetId: o.assetId!,
      ...(o.pattern !== undefined
        ? { pattern: { type: o.pattern.type, spacing: o.pattern.spacing } }
        : {}),
      ...base,
    };
  }

  /** Asset ids referenced by image objects; text objects reference no assets. */
  private imageAssetIdsOf(placements: { objects: { type?: string; assetId?: string }[] }[]): string[] {
    return placements.flatMap((p) =>
      p.objects.filter((o) => o.type !== 'text' && o.assetId).map((o) => o.assetId!),
    );
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

    const assetIds = [...new Set(this.imageAssetIdsOf(document.placements))];
    const assets = await this.prisma.uploadedAsset.findMany({ where: { id: { in: assetIds } } });
    const assetById = new Map(assets.map((a) => [a.id, a]));
    const areaByKey = new Map(template.printAreas.map((a) => [a.key, a]));

    // Garment color: the stored key, or the template default. A stored key that no
    // longer exists falls back to the default (a removed color must not brick the
    // design); templates without colors keep the plain template/area images.
    const color =
      (document.colorKey
        ? template.colors.find((c) => c.active && c.key === document.colorKey)
        : undefined) ?? template.colors.find((c) => c.active && c.isDefault);

    const renderedAt = new Date().toISOString();
    const nextPreviews: PreviewPathsMap = {};

    for (const placement of document.placements) {
      const area = areaByKey.get(placement.printAreaKey)!; // validated above

      const objects = placement.objects.map((obj, index): RenderObject => {
        const base = { x: obj.x, y: obj.y, width: obj.width, height: obj.height, rotation: obj.rotation };
        if (obj.type === 'text') {
          // The renderer resolves the whitelist key to its bundled font file itself.
          // The service resolves 'auto' direction (shared first-strong scan) and maps
          // the final visual lines: the editor's wrappedLines for box mode, explicit
          // breaks otherwise. The renderer never re-wraps and never guesses direction.
          return {
            type: 'text',
            lines:
              obj.wrapMode === 'box' && obj.wrappedLines
                ? obj.wrappedLines
                : obj.text.split('\n'),
            fontFamily: obj.fontFamily,
            fontSize: obj.fontSize,
            color: obj.color,
            align: obj.align,
            direction: resolveTextDirection(obj.text, obj.direction),
            ...(obj.outline ? { outline: obj.outline } : {}),
            ...(obj.shadow ? { shadow: obj.shadow } : {}),
            ...(obj.letterSpacing ? { letterSpacing: obj.letterSpacing } : {}),
            ...(obj.arc ? { arc: obj.arc } : {}),
            ...base,
          };
        }
        const asset = assetById.get(obj.assetId);
        if (!asset) {
          throw new BadRequestException(
            `placements[${placement.printAreaKey}].objects[${index}]: asset "${obj.assetId}" no longer exists`,
          );
        }
        return {
          type: 'image',
          imagePath: this.storage.resolvePath(asset.storagePath),
          ...(obj.pattern ? { pattern: obj.pattern } : {}),
          ...base,
        };
      });

      // Area-specific view images with template-level fallback; the mask and the
      // overlay blend follow the same rule. The renderer validates the blend value,
      // so a bad seed/config fails loudly instead of rendering wrong.
      // The chosen color swaps the BLANK only (color's area image, else its
      // template-level image); mask and overlay are color-independent (same photo
      // geometry), so they keep the plain fallback chain.
      const colorAreaImage = color?.areaImages.find((img) => img.printAreaId === area.id);
      const baseImagePath =
        colorAreaImage?.baseImagePath ??
        (area.baseImagePath === null ? color?.baseImagePath : undefined) ??
        area.baseImagePath ??
        template.baseImagePath;
      const overlayImagePath = area.overlayImagePath ?? template.overlayImagePath;
      const maskImagePath = area.maskImagePath ?? template.maskImagePath;
      const overlayBlend = (area.overlayBlend ?? template.overlayBlend) as OverlayBlend;

      let png: Buffer;
      try {
        png = await renderMockup({
          baseImagePath: this.storage.resolvePath(baseImagePath),
          overlayImagePath: overlayImagePath ? this.storage.resolvePath(overlayImagePath) : null,
          overlayBlend,
          maskImagePath: maskImagePath ? this.storage.resolvePath(maskImagePath) : null,
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
      include: { productTemplate: { include: { printAreas: true, colors: { include: { areaImages: true } } } } },
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
    return Object.entries(previews)
      .map(([printAreaKey, preview]) => ({
        printAreaKey,
        previewUrl: `/designs/${designId}/preview/${encodeURIComponent(printAreaKey)}`,
        renderedAt: preview.renderedAt,
      }))
      .sort(this.byAreaOrder(printAreas, (p) => p.printAreaKey));
  }

  /** Comparator: template area sortOrder first (front before back), key as fallback. */
  private byAreaOrder<T>(printAreas: PrintArea[], keyOf: (item: T) => string) {
    const orderOf = new Map(printAreas.map((a) => [a.key, a.sortOrder]));
    return (a: T, b: T): number =>
      (orderOf.get(keyOf(a)) ?? Number.MAX_SAFE_INTEGER) -
        (orderOf.get(keyOf(b)) ?? Number.MAX_SAFE_INTEGER) ||
      keyOf(a).localeCompare(keyOf(b));
  }

  /**
   * Library row summary: template info, per-area object counts, preview metadata,
   * worst advisory quality level. Never includes the design document. A row whose
   * stored document could not be read (document undefined) degrades to
   * placements: [] and worstQualityLevel: null; the parse failure was already
   * logged by list().
   */
  private toListItemDto(
    design: DesignWithTemplate,
    document: DesignDocument | undefined,
    assetDims: AssetDimsMap,
  ): DesignListItemDto {
    const template = design.productTemplate;

    let placements: DesignPlacementSummaryDto[] = [];
    let worstQualityLevel: PrintQualityLevel | null = null;
    if (document) {
      const nameOf = new Map(template.printAreas.map((a) => [a.key, a.name]));
      placements = document.placements
        .map((placement) => {
          const textCount = placement.objects.filter((o) => o.type === 'text').length;
          return {
            printAreaKey: placement.printAreaKey,
            printAreaName: nameOf.get(placement.printAreaKey) ?? placement.printAreaKey,
            objectCount: placement.objects.length,
            imageCount: placement.objects.length - textCount,
            textCount,
          };
        })
        .sort(this.byAreaOrder(template.printAreas, (s) => s.printAreaKey));
      worstQualityLevel = this.worstQualityLevelOf(document, template.printAreas, assetDims);
    }

    return {
      id: design.id,
      template: { id: template.id, name: template.name, slug: template.slug },
      placements,
      previews: this.toPreviewDtos(design.id, this.previewPathsOf(design), template.printAreas),
      worstQualityLevel,
      createdAt: design.createdAt.toISOString(),
      updatedAt: design.updatedAt.toISOString(),
    };
  }

  /** One batched query for the source pixel sizes the DPI math needs. */
  private async assetDimsFor(assetIds: string[]): Promise<AssetDimsMap> {
    const unique = [...new Set(assetIds)];
    if (unique.length === 0) return new Map();
    const assets = await this.prisma.uploadedAsset.findMany({
      where: { id: { in: unique } },
      select: { id: true, width: true, height: true },
    });
    return new Map(assets.map((a) => [a.id, { width: a.width, height: a.height }]));
  }

  /**
   * Worst advisory level across the document's evaluable objects; null when nothing
   * was evaluable (missing asset dims, unknown areas). Advisory only: this never
   * feeds validation.
   */
  private worstQualityLevelOf(
    document: DesignDocument,
    printAreas: PrintArea[],
    assetDims: AssetDimsMap,
  ): PrintQualityLevel | null {
    const ppiByKey = new Map(printAreas.map((a) => [a.key, printAreaPpi(a)]));
    let worst: PrintQualityLevel | null = null;
    for (const placement of document.placements) {
      const ppi = ppiByKey.get(placement.printAreaKey) ?? null;
      for (const object of placement.objects) {
        if (object.type === 'text') continue; // vector-like, DPI does not apply
        const dims = assetDims.get(object.assetId);
        if (!dims) continue;
        const quality = evaluateObjectQuality(dims, object, ppi);
        if (!quality) continue;
        worst = worst === null ? quality.level : worseQualityLevel(worst, quality.level);
      }
    }
    return worst;
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

  /**
   * Async because the advisory quality warnings need the source pixel sizes of the
   * design's assets (one batched query). Warnings are recomputed at read time so a
   * changed print area spec is always reflected; nothing is persisted.
   */
  private async toDto(design: DesignWithTemplate): Promise<DesignProjectDto> {
    const document = this.normalizedDocumentOf(design);
    const assetDims = await this.assetDimsFor(this.imageAssetIdsOf(document.placements));
    const qualityWarnings: ObjectQualityWarningDto[] = collectQualityWarnings(
      document.placements,
      design.productTemplate.printAreas,
      assetDims,
    );

    return {
      id: design.id,
      templateId: design.productTemplateId,
      templateSlug: design.productTemplate.slug,
      design: document,
      previews: this.toPreviewDtos(
        design.id,
        this.previewPathsOf(design),
        design.productTemplate.printAreas,
      ),
      qualityWarnings,
      createdAt: design.createdAt.toISOString(),
      updatedAt: design.updatedAt.toISOString(),
    };
  }
}
