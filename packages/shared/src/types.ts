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

/** How a patterned image tiles across its print area (v1.9). */
export const PATTERN_TYPES = ['grid', 'mirror', 'half-drop'] as const;
export type PatternType = (typeof PATTERN_TYPES)[number];

/**
 * Pattern fill (v1.9): the object's box becomes the BASE TILE and copies fill the
 * whole print area (clipped to it). 'grid' repeats as-is, 'mirror' alternates
 * flips on both axes, 'half-drop' shifts odd columns by half a tile. Patterned
 * objects must have rotation 0 (the tiling math is axis-aligned).
 */
export interface ImagePattern {
  type: PatternType;
  /** Gap between tiles in canvas px (0..100). */
  spacing: number;
}

/** One placed artwork image inside a print area. */
export interface ImageDesignObject extends DesignObjectBase {
  type: 'image';
  /** UploadedAsset id this object renders. */
  assetId: string;
  /** Tiling fill (v1.9); absent = the single image. */
  pattern?: ImagePattern;
}

export type TextAlign = 'left' | 'center' | 'right';

/** Outline (stroke) around text glyphs; the editor paints it stroke-first (half outward). */
export interface TextOutline {
  /** Strict #RRGGBB. */
  color: string;
  /** Stroke width in canvas px (1..20); the measured text box includes it. */
  width: number;
}

/**
 * Hard drop shadow behind text glyphs (no blur). Offsets in canvas px, each
 * clamped to +-25. Shadow pixels may extend past the stored text box by design;
 * geometry validation stays on the glyph box.
 */
export interface TextShadow {
  /** Strict #RRGGBB. */
  color: string;
  offsetX: number;
  offsetY: number;
}

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
  /** Glyph outline (v1.8); absent = none. */
  outline?: TextOutline;
  /** Hard drop shadow (v1.8); absent = none. */
  shadow?: TextShadow;
  /**
   * Extra space between glyphs in canvas px (v1.8); absent or 0 = font default.
   * Negative values tighten. The editor maps it to Fabric's em-based charSpacing,
   * the renderer to Pango letter_spacing.
   */
  letterSpacing?: number;
  /**
   * Arc bend (v1.8): the sweep angle in degrees the text covers on a circle.
   * Positive bows upward, negative downward; absent = straight. Single visual
   * line, LTR content only, and not combinable with wrap, outline, or shadow
   * (per-glyph layout; see layoutArcGlyphs).
   */
  arc?: number;
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
 * Garment sizes (v2.3). A fixed catalog every garment offers; the chosen size is
 * order-time metadata on the design and never affects the artwork, geometry, or
 * the rendered mockup/print file (the print is identical across sizes on DTG).
 */
export const GARMENT_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'] as const;
export type GarmentSize = (typeof GARMENT_SIZES)[number];

/**
 * The persisted design document, current version (DesignProject.designJson).
 * One document covers every print area of the template the user placed artwork on.
 */
export interface DesignDocument {
  version: 2;
  templateId: string;
  /**
   * Chosen garment color (TemplateColor key, v2.0). Preview-time choice only:
   * it never affects placement geometry or validation. Absent = the template's
   * default color (pre-v2.0 documents persist byte-identical).
   */
  colorKey?: string;
  /**
   * Chosen garment size (v2.3). Order-time metadata only: it never affects the
   * artwork or the render. Absent = no size chosen yet (pre-v2.3 documents
   * persist byte-identical).
   */
  size?: GarmentSize;
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
  colorKey?: string;
  size?: GarmentSize;
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

/** Color-specific view images for one print area that carries its own view (e.g. back). */
export interface TemplateColorAreaImageDto {
  printAreaKey: string;
  /** Relative API URL streaming this area's blank in this color. */
  imageUrl: string;
  thumbUrl: string;
}

/**
 * One garment color of a template (v2.0). The blank photo is color-specific;
 * the garment mask and the fabric overlay are shared across colors (same photo
 * geometry). Color is a preview-time choice: it never affects print areas,
 * placement geometry, or validation.
 */
export interface TemplateColorDto {
  /** Stable key used in URLs and design documents ('white', 'black', ...). */
  key: string;
  name: string;
  /** Swatch color for the picker UI (strict #RRGGBB). */
  hex: string;
  /** Exactly one default per template; designs without a colorKey render in it. */
  isDefault: boolean;
  /** Relative API URL streaming the template-level (front) blank in this color. */
  imageUrl: string;
  thumbUrl: string;
  /** One entry per print area that carries its own view (mirrors PrintAreaDto.imageUrl). */
  areaImages: TemplateColorAreaImageDto[];
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
  /**
   * Garment colors in display order; empty for templates without color variants.
   * The default color's images are the template-level images.
   */
  colors: TemplateColorDto[];
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

/**
 * The garment color a design resolves to, for display surfaces (library rows,
 * mockup page). Resolved server-side the same way render resolves it: the
 * stored colorKey when it still exists on the template, else the template
 * default; null when the template has no colors.
 */
export interface DesignColorDto {
  key: string;
  name: string;
  /** Swatch color, strict #RRGGBB. */
  hex: string;
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
  /** Resolved garment color for display; null when the template has no colors. */
  color: DesignColorDto | null;
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
  /**
   * Resolved garment color for the row swatch; null when the template has no
   * colors. An unreadable document degrades to the template default.
   */
  color: DesignColorDto | null;
  /** Chosen garment size (v2.3); null when none was picked or the doc is unreadable. */
  size: GarmentSize | null;
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
