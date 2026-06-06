/**
 * Shared contract types for FoloPrint Design Studio.
 *
 * Coordinate system: template canvas space (pixels, origin top-left).
 * Design object `x`/`y` is the object CENTER (matches Fabric.js originX/originY = 'center').
 * `rotation` is in degrees, clockwise.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** One placed artwork inside a print area. */
export interface DesignObject {
  /** UploadedAsset id this object renders. */
  assetId: string;
  /** Object center X in canvas px. */
  x: number;
  /** Object center Y in canvas px. */
  y: number;
  /** Scaled width in canvas px (before rotation). */
  width: number;
  /** Scaled height in canvas px (before rotation). */
  height: number;
  /** Rotation around the center, degrees clockwise. */
  rotation: number;
}

/** All artwork placed on one print area. A placement exists only if it has objects. */
export interface DesignPlacement {
  printAreaKey: string;
  objects: DesignObject[];
}

/**
 * The persisted design document, current version (DesignProject.designJson).
 * One document covers every print area of the template the user placed artwork on.
 */
export interface DesignDocument {
  version: 2;
  templateId: string;
  placements: DesignPlacement[];
}

/** Legacy single-area document (v1.1 and earlier). Normalized to v2 at read time. */
export interface DesignDocumentV1 {
  version: 1;
  templateId: string;
  printAreaKey: string;
  objects: DesignObject[];
}

/** Any document shape that may come out of the database. */
export type AnyDesignDocument = DesignDocumentV1 | DesignDocument;

// ---------------------------------------------------------------------------
// API response shapes (what the web app consumes; never contains fs paths)
// ---------------------------------------------------------------------------

export interface PrintAreaDto {
  id: string;
  key: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Relative API URL streaming this area's own base image, or null when the area
   * falls back to the template-level image.
   */
  imageUrl: string | null;
  /** Same fallback rule for the area's overlay image. */
  overlayUrl: string | null;
  /**
   * Physical printable width in inches; null means "not configured" and clients
   * apply the shared fallback (assumed 12in width, aspect-derived height).
   */
  widthInches: number | null;
  heightInches: number | null;
}

export interface ProductTemplateDto {
  id: string;
  name: string;
  slug: string;
  canvasWidth: number;
  canvasHeight: number;
  /** Relative API URL streaming the base image. */
  imageUrl: string;
  /** Relative API URL streaming the overlay image, if the template has one. */
  overlayUrl: string | null;
  printAreas: PrintAreaDto[];
}

export interface UploadedAssetDto {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  /** Relative API URL streaming the file. */
  url: string;
}

/** Metadata for one rendered area preview. */
export interface DesignPreviewDto {
  printAreaKey: string;
  /** Relative API URL streaming the preview PNG. */
  previewUrl: string;
  /** ISO timestamp of the render that produced this preview. */
  renderedAt: string;
}

/** Advisory print-quality level for a placed image object. */
export type PrintQualityLevel = 'ok' | 'warning' | 'poor';

/** Wire shape of one advisory low-resolution warning. Never blocks anything. */
export interface ObjectQualityWarningDto {
  printAreaKey: string;
  /** Index into that placement's objects array. */
  objectIndex: number;
  assetId: string;
  /** Rounded effective print DPI (worse axis). */
  effectiveDpi: number;
  level: 'warning' | 'poor';
}

export interface DesignProjectDto {
  id: string;
  templateId: string;
  templateSlug: string;
  /** Always normalized to the current document version (v2). */
  design: DesignDocument;
  /** One entry per rendered area; empty until the design is rendered. */
  previews: DesignPreviewDto[];
  /**
   * Advisory print-quality warnings, recomputed server-side at read time.
   * Empty when every object is ok or its inputs are unknown.
   */
  qualityWarnings: ObjectQualityWarningDto[];
  createdAt: string;
  updatedAt: string;
}

export interface RenderResultDto {
  designId: string;
  previews: DesignPreviewDto[];
}

// ---------------------------------------------------------------------------
// Design library (paginated list) shapes
// ---------------------------------------------------------------------------

/** Per-area summary for the design library; counts only, never object geometry. */
export interface DesignPlacementSummaryDto {
  printAreaKey: string;
  /** Human name from the template's print area; falls back to the key. */
  printAreaName: string;
  objectCount: number;
}

/**
 * One row in the design library. Deliberately excludes the design document:
 * the list is for finding and reopening designs, not for editing them.
 */
export interface DesignListItemDto {
  id: string;
  template: {
    id: string;
    name: string;
    slug: string;
  };
  /** Ordered by the template's area sortOrder (front before back). */
  placements: DesignPlacementSummaryDto[];
  /** Same shape and ordering as DesignProjectDto.previews; empty until rendered. */
  previews: DesignPreviewDto[];
  /**
   * Worst advisory quality level across the design's evaluable image objects;
   * null when nothing was evaluable (unreadable document or missing asset dims).
   */
  worstQualityLevel: PrintQualityLevel | null;
  createdAt: string;
  updatedAt: string;
}

/** Paginated design library response; page/pageSize echo the clamped effective values. */
export interface DesignListDto {
  items: DesignListItemDto[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}
