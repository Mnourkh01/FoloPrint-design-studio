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

/** The persisted design document (DesignProject.designJson). */
export interface DesignDocument {
  version: 1;
  templateId: string;
  printAreaKey: string;
  objects: DesignObject[];
}

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

export interface DesignProjectDto {
  id: string;
  templateId: string;
  templateSlug: string;
  design: DesignDocument;
  /** Relative API URL streaming the rendered preview, null until rendered. */
  previewUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RenderResultDto {
  id: string;
  previewUrl: string;
}
