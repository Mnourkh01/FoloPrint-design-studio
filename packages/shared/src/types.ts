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

export interface DesignProjectDto {
  id: string;
  templateId: string;
  templateSlug: string;
  /** Always normalized to the current document version (v2). */
  design: DesignDocument;
  /** One entry per rendered area; empty until the design is rendered. */
  previews: DesignPreviewDto[];
  createdAt: string;
  updatedAt: string;
}

export interface RenderResultDto {
  designId: string;
  previews: DesignPreviewDto[];
}
