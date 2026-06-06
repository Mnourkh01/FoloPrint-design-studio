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

/** Geometry shared by every design object kind. */
export interface DesignObjectBase {
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

/** One placed artwork image inside a print area. */
export interface ImageDesignObject extends DesignObjectBase {
  type: 'image';
  /** UploadedAsset id this object renders. */
  assetId: string;
}

export type TextAlign = 'left' | 'center' | 'right';

/** Base text direction. 'auto' = first strong character decides (resolveTextDirection). */
export type TextDirection = 'ltr' | 'rtl' | 'auto';

/** 'box' = auto-wrap at the stored width (editor Textbox); 'none' = explicit `\n` only. */
export type TextWrapMode = 'none' | 'box';

/**
 * One placed text element inside a print area. Vector-like: no source bitmap,
 * so it never participates in DPI quality math.
 *
 * width/height are the measured bounding box of the laid-out text in canvas px
 * (measured by the editor at save time). The server renders text at its natural
 * size with the same bundled font, then fits it into exactly this box, so
 * browser/server metric drift becomes sub-percent stretch instead of overflow.
 */
export interface TextDesignObject extends DesignObjectBase {
  type: 'text';
  /** Plain text. `\n` only for explicit line breaks; no auto-wrap, never markup. */
  text: string;
  /** Key into the shared font whitelist (see fonts.ts). */
  fontFamily: string;
  /** Font size in canvas px (uniform editor scaling is baked in on save). */
  fontSize: number;
  /** Strict #RRGGBB. No alpha, no named colors, no CSS functions. */
  color: string;
  align: TextAlign;
  /** Base direction. Missing normalizes to 'auto' (pre-v1.6 objects). */
  direction?: TextDirection;
  /** Wrap behavior. Missing normalizes to 'none' (pre-v1.6 objects). */
  wrapMode?: TextWrapMode;
  /**
   * Derived render cache, REQUIRED when wrapMode === 'box', FORBIDDEN otherwise.
   * The exact visual lines the editor produced at save time (soft wraps + explicit
   * breaks flattened, in order). The server renders these verbatim so the mockup
   * breaks exactly where the editor broke; it verifies them against raw `text`
   * (whitespace-stripped reconciliation) so the cache cannot be forged. Never
   * edited, only regenerated on save.
   */
  wrappedLines?: string[];
}

/**
 * One placed object inside a print area, discriminated on `type`.
 * Stored objects without `type` are legacy images and normalize at read time
 * (see normalizeDesignDocument); the document version stays v2.
 */
export type DesignObject = ImageDesignObject | TextDesignObject;

/** A stored object that may predate the `type` discriminator (legacy image shape). */
export type StoredDesignObject = DesignObject | (Omit<ImageDesignObject, 'type'> & { type?: undefined });

/** All artwork placed on one print area. A placement exists only if it has objects. */
export interface DesignPlacement {
  printAreaKey: string;
  objects: DesignObject[];
}

/** A stored placement whose objects may predate the `type` discriminator. */
export interface StoredDesignPlacement {
  printAreaKey: string;
  objects: StoredDesignObject[];
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
  objects: StoredDesignObject[];
}

/** A stored v2 document whose objects may predate the `type` discriminator. */
export interface StoredDesignDocumentV2 {
  version: 2;
  templateId: string;
  placements: StoredDesignPlacement[];
}

/** Any document shape that may come out of the database. */
export type AnyDesignDocument = DesignDocumentV1 | StoredDesignDocumentV2;

// ---------------------------------------------------------------------------
// API response shapes (what the web app consumes; never contains fs paths)
// ---------------------------------------------------------------------------

/**
 * How a template's overlay composites over the artwork. 'over' is plain alpha
 * (legacy SVG templates), 'multiply' darkens (photographic shadows and folds),
 * 'soft-light' is a gentler sheen. The renderer and the editor both honor it so
 * the live canvas matches the server mockup.
 */
export const OVERLAY_BLENDS = ['over', 'multiply', 'soft-light'] as const;
export type OverlayBlend = (typeof OVERLAY_BLENDS)[number];

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
  /** Same fallback rule for the area's card/tab thumb. */
  thumbUrl: string | null;
  /** Area-specific overlay blend; null falls back to the template's overlayBlend. */
  overlayBlend: OverlayBlend | null;
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
  /** Relative API URL streaming a small card/tab thumb; null = use the full image. */
  thumbUrl: string | null;
  /** How overlays composite over the artwork ('over' unless the template says otherwise). */
  overlayBlend: OverlayBlend;
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
  /** Total objects on the area (imageCount + textCount). */
  objectCount: number;
  imageCount: number;
  textCount: number;
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
