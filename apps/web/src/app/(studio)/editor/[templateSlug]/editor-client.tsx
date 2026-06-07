'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Canvas, FabricImage, IText, Line, Pattern, Rect, Shadow, Textbox, type FabricObject } from 'fabric';
import {
  ARC_GLYPH_HEIGHT_FACTOR,
  ARC_SWEEP_MAX,
  ARC_SWEEP_MIN,
  evaluateObjectQuality,
  FONT_CATEGORY_ORDER,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_WHITELIST,
  GARMENT_SIZES,
  fontDefinitionOf,
  layoutArcGlyphs,
  LETTER_SPACING_MAX,
  LETTER_SPACING_MIN,
  OUTLINE_WIDTH_MAX,
  OUTLINE_WIDTH_MIN,
  PATTERN_SPACING_MAX,
  PATTERN_SPACING_MIN,
  printAreaPpi,
  resolveTextDirection,
  SHADOW_OFFSET_MAX,
  TEXT_MAX_LINES,
  validateDesignPlacements,
  type DesignObject,
  type DesignPlacement,
  type DesignProjectDto,
  type GarmentSize,
  type ImagePattern,
  type OverlayBlend,
  type PatternType,
  type PrintAreaDto,
  type PrintQualityLevel,
  type ProductTemplateDto,
  type TextAlign,
  type TextDirection,
  type TextOutline,
  type TextShadow,
} from '@foloprint/shared';
import {
  ApiError,
  apiUrl,
  assetFileUrl,
  cropAsset,
  fontFileUrl,
  removeAssetBackground,
  renderDesign,
  saveDesign,
  updateDesign,
  uploadAsset,
} from '@/lib/api';

const STAGE_WIDTH = 680;

/**
 * Canvas2D composite operation per contract overlay blend, so the live editor
 * shades the artwork exactly like the server render (sharp uses the same Porter-
 * Duff/PDF operators under these names).
 */
const FABRIC_OVERLAY_BLEND: Record<OverlayBlend, GlobalCompositeOperation> = {
  over: 'source-over',
  multiply: 'multiply',
  'soft-light': 'soft-light',
};

/**
 * Print-area boundary styling: quiet at rest so the garment mockup carries the view,
 * asserting itself only while the user is actually working an object.
 */
const BOUNDARY_QUIET = {
  stroke: '#6b7280',
  strokeDashArray: [5, 5],
  strokeWidth: 1,
  opacity: 0.55,
};
const BOUNDARY_ACTIVE = {
  stroke: '#cf3f22',
  strokeDashArray: [6, 4],
  strokeWidth: 1.5,
  opacity: 0.9,
};

/** View zoom (multiplier over the fit zoom) bounds for the stage zoom widget. */
const VIEW_ZOOM_MIN = 0.5;
const VIEW_ZOOM_MAX = 3;
const VIEW_ZOOM_STEP = 1.25;

/** Client-side upload gate; mirrors the server's multer/sniff limits. */
const UPLOAD_MIME_TYPES = ['image/png', 'image/jpeg'];
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Drag snapping: when the dragged object's center comes within this many canvas
 * px of a print-area centerline it snaps onto it and a guide line appears
 * (commercial-editor behavior; dragging past the threshold releases the snap).
 */
const SNAP_THRESHOLD = 8;
const SNAP_GUIDE_STYLE = {
  stroke: '#15a8b6',
  strokeWidth: 1.25,
  strokeUniform: true,
  selectable: false,
  evented: false,
  excludeFromExport: true,
} as const;

/** Left tool rail entries; the contextual panel renders per active tool. */
type StudioTool = 'product' | 'templates' | 'uploads' | 'text' | 'saved' | 'layers';

/** Hand-drawn 24px stroke icons; no icon dependency for five glyphs. */
const TOOL_ICONS: Record<StudioTool, React.ReactNode> = {
  product: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
      <path d="M16 3.5l4.5 2.5-1.7 4.3-1.8-.8V21H7V9.5l-1.8.8L3.5 6 8 3.5a4 4.2 0 0 0 8 0z" />
    </svg>
  ),
  uploads: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 16V4m0 0L8 8m4-4l4 4" />
      <path d="M4 20h16" />
    </svg>
  ),
  text: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
      <path d="M5 6V4h14v2M12 4v16m-3 0h6" />
    </svg>
  ),
  templates: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M3.5 9.5h17M9 9.5V20.5" />
    </svg>
  ),
  saved: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
      <path d="M6.5 3.5h11V21L12 16.8 6.5 21z" />
    </svg>
  ),
  layers: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
      <path d="M12 3.5l8.5 4.7L12 12.9 3.5 8.2z" />
      <path d="M3.5 13l8.5 4.7L20.5 13" />
    </svg>
  ),
};

const TOOL_LABELS: Record<StudioTool, string> = {
  product: 'Product',
  templates: 'Templates',
  uploads: 'Uploads',
  text: 'Text',
  saved: 'Saved',
  layers: 'Layers',
};

const TOOL_ORDER: StudioTool[] = ['product', 'templates', 'uploads', 'text', 'saved', 'layers'];

/** Align actions for the Position tool: edge/center against the object's print area. */
type AlignAction = 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom';

const ALIGN_ACTIONS: { key: AlignAction; label: string; icon: React.ReactNode }[] = [
  {
    key: 'center-h',
    label: 'Center horizontally',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
        <path d="M12 3v3.5m0 11V21" />
        <rect x="6" y="8.5" width="12" height="7" rx="1.2" />
      </svg>
    ),
  },
  {
    key: 'center-v',
    label: 'Center vertically',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
        <path d="M3 12h3.5m11 0H21" />
        <rect x="8.5" y="6" width="7" height="12" rx="1.2" />
      </svg>
    ),
  },
  {
    key: 'left',
    label: 'Align left',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
        <path d="M4 3v18" />
        <rect x="7.5" y="8.5" width="11" height="7" rx="1.2" />
      </svg>
    ),
  },
  {
    key: 'right',
    label: 'Align right',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
        <path d="M20 3v18" />
        <rect x="5.5" y="8.5" width="11" height="7" rx="1.2" />
      </svg>
    ),
  },
  {
    key: 'top',
    label: 'Align top',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
        <path d="M3 4h18" />
        <rect x="8.5" y="7.5" width="7" height="11" rx="1.2" />
      </svg>
    ),
  },
  {
    key: 'bottom',
    label: 'Align bottom',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
        <path d="M3 20h18" />
        <rect x="8.5" y="5.5" width="7" height="11" rx="1.2" />
      </svg>
    ),
  },
];

/** Icons for the contextual object toolbar above the stage. */
const CONTEXT_TOOL_ICONS = {
  transform: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 11a8 8 0 1 0 .9 4.2" />
      <path d="M20 4v7h-7" />
    </svg>
  ),
  position: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  ),
  'remove-bg': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 20h12" />
      <path d="M5.5 13.5l8-8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8l-8 8H7.7a2 2 0 0 1-1.4-.6l-.8-.8a2 2 0 0 1 0-2.8z" />
      <path d="M10 9l5 5" />
    </svg>
  ),
  crop: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </svg>
  ),
  pattern: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
};

/**
 * Pattern panel choices; null = single image. Each carries a tiny tile preview so
 * the layout reads at a glance ("half-drop" means nothing as a word; the brick
 * picture does). The keys still map to the contract PatternType.
 */
const PATTERN_CHOICES: { key: PatternType | null; label: string; icon: React.ReactNode }[] = [
  {
    key: null,
    label: 'Single',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
        <rect x="9" y="9" width="6" height="6" rx="1" />
      </svg>
    ),
  },
  {
    key: 'grid',
    label: 'Grid',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
        <rect x="4" y="4" width="6" height="6" rx="1" />
        <rect x="14" y="4" width="6" height="6" rx="1" />
        <rect x="4" y="14" width="6" height="6" rx="1" />
        <rect x="14" y="14" width="6" height="6" rx="1" />
      </svg>
    ),
  },
  {
    key: 'mirror',
    label: 'Mirror',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
        <path d="M11 5l-6 7 6 7z" fill="currentColor" stroke="none" />
        <path d="M13 5l6 7-6 7z" />
      </svg>
    ),
  },
  {
    key: 'half-drop',
    label: 'Brick',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
        <rect x="3" y="4" width="6" height="6" rx="1" />
        <rect x="15" y="4" width="6" height="6" rx="1" />
        <rect x="9" y="14" width="6" height="6" rx="1" />
      </svg>
    ),
  },
];

/**
 * One-click logo placements for the Position tool, defined as fractions of the
 * print area so the same presets work on every product. Each entry contains the
 * artwork inside (w x h) of the area and anchors its CENTER at (cx, cy).
 * "Left chest" is the wearer's left, which faces the viewer's right.
 */
type PlacementPreset =
  | 'full'
  | 'chest-center'
  | 'chest-left'
  | 'chest-right'
  | 'back-center'
  | 'locker-patch';

const PLACEMENT_SPECS: Record<PlacementPreset, { w: number; h: number; cx: number; cy: number }> = {
  full: { w: 0.92, h: 0.92, cx: 0.5, cy: 0.5 },
  // The areas span the whole panel (16in platen), so chest spots live in the
  // upper zone: ~6in wide centered, ~3.5in wide left/right of the sternum.
  'chest-center': { w: 0.38, h: 0.3, cx: 0.5, cy: 0.22 },
  'chest-left': { w: 0.22, h: 0.18, cx: 0.75, cy: 0.15 },
  'chest-right': { w: 0.22, h: 0.18, cx: 0.25, cy: 0.15 },
  // Back spots: a big centered print and the small below-the-collar patch.
  'back-center': { w: 0.5, h: 0.45, cx: 0.5, cy: 0.4 },
  'locker-patch': { w: 0.22, h: 0.12, cx: 0.5, cy: 0.07 },
};

/** Per-side preset menus; the side names the placement, the math is shared. */
const PLACEMENT_PRESETS: Record<'front' | 'back', { key: PlacementPreset; label: string }[]> = {
  front: [
    { key: 'full', label: 'Full front' },
    { key: 'chest-center', label: 'Center chest' },
    { key: 'chest-left', label: 'Left chest' },
    { key: 'chest-right', label: 'Right chest' },
  ],
  back: [
    { key: 'full', label: 'Full back' },
    { key: 'back-center', label: 'Center back' },
    { key: 'locker-patch', label: 'Locker patch' },
  ],
};

/**
 * Polished selection chrome shared by every design object: branded border,
 * round white grab handles. Pure cosmetics; geometry math is untouched.
 */
function applySelectionStyle(obj: FabricObject): void {
  obj.set({
    borderColor: '#cf3f22',
    borderScaleFactor: 1.6,
    cornerColor: '#ffffff',
    cornerStrokeColor: '#cf3f22',
    cornerStyle: 'circle',
    cornerSize: 9,
    touchCornerSize: 18,
    transparentCorners: false,
  });
}

/**
 * Loads every whitelist font from the API exactly once per page. The editor must
 * measure text with the same font binaries the server renders with; until a font
 * is loaded, Fabric would silently measure with a fallback font.
 */
let fontsLoadedPromise: Promise<void> | null = null;
function ensureEditorFonts(): Promise<void> {
  if (!fontsLoadedPromise) {
    fontsLoadedPromise = Promise.all(
      FONT_WHITELIST.map(async (font) => {
        // NOTE: do NOT guard with document.fonts.check(): when no @font-face for
        // the family exists yet, check() returns TRUE (it assumes a system
        // fallback can render the name), so the guard skipped loading every
        // whitelist font and all editor text fell back to a default face.
        // Skip only if THIS exact face is already registered as loaded.
        for (const f of document.fonts) {
          if (f.family === font.family && f.status === 'loaded') return;
        }
        const face = new FontFace(font.family, `url(${apiUrl(fontFileUrl(font.key))})`);
        await face.load();
        document.fonts.add(face);
      }),
    ).then(
      () => undefined,
      (error: unknown) => {
        fontsLoadedPromise = null; // allow a retry on the next attempt
        throw error;
      },
    );
  }
  return fontsLoadedPromise;
}

/**
 * Plain HTMLImageElement loader for the overview tiles (the Fabric view-image
 * cache holds FabricImages with canvas-fit scaling baked in; the tiles draw to
 * their own 2D contexts and want the raw bitmap). Cached per URL for the page.
 */
const htmlImageCache = new Map<string, Promise<HTMLImageElement>>();
function loadHtmlImage(url: string): Promise<HTMLImageElement> {
  let promise = htmlImageCache.get(url);
  if (!promise) {
    promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        htmlImageCache.delete(url); // allow a retry on the next open
        reject(new Error(`Failed to load ${url}`));
      };
      img.src = url;
    });
    htmlImageCache.set(url, promise);
  }
  return promise;
}

/** Overview tile raster width in CSS px; height follows the template aspect. */
const OVERVIEW_TILE_WIDTH = 260;

/** Defaults for a freshly added text object. */
const TEXT_DEFAULTS = { fontKey: 'inter', fontSize: 48, color: '#1a1a1a', align: 'center' as TextAlign };

/** Curated color palette for the text panel; any #RRGGBB is valid, these are shortcuts. */
const TEXT_SWATCHES = [
  '#1a1a1a', '#6b7280', '#ffffff', '#cf3f22', '#dc2626', '#db2777',
  '#f59e0b', '#facc15', '#16a34a', '#047857', '#0ea5e9', '#1d4ed8',
  '#1e3a8a', '#7c3aed', '#9d174d', '#b45309', '#065f46', '#d4af37',
];

/**
 * One-tap text effect looks. Each entry IS the saved value, so the chip preview
 * (rendered with the same numbers) shows exactly what gets applied. Picked over
 * raw color/width/offset boxes so a first-timer reads the result at a glance;
 * the exact values still live under Advanced for fine tuning.
 */
const OUTLINE_PRESETS: { key: string; label: string; outline: TextOutline | null }[] = [
  { key: 'none', label: 'None', outline: null },
  { key: 'white', label: 'White', outline: { color: '#ffffff', width: 4 } },
  { key: 'black', label: 'Black', outline: { color: '#000000', width: 4 } },
  { key: 'gold', label: 'Gold', outline: { color: '#d4af37', width: 4 } },
  { key: 'red', label: 'Red', outline: { color: '#cf3f22', width: 4 } },
  { key: 'thick', label: 'Thick', outline: { color: '#ffffff', width: 8 } },
];

const SHADOW_PRESETS: { key: string; label: string; shadow: TextShadow | null }[] = [
  { key: 'none', label: 'None', shadow: null },
  { key: 'soft', label: 'Soft', shadow: { color: '#000000', offsetX: 2, offsetY: 2 } },
  { key: 'drop', label: 'Drop', shadow: { color: '#000000', offsetX: 4, offsetY: 4 } },
  { key: 'long', label: 'Long', shadow: { color: '#000000', offsetX: 8, offsetY: 8 } },
  { key: 'lift', label: 'Lift', shadow: { color: '#000000', offsetX: 0, offsetY: 5 } },
  { key: 'pop', label: 'Pop', shadow: { color: '#cf3f22', offsetX: 3, offsetY: 3 } },
];

/**
 * One-tap text "looks": a curated combo of font + color + outline + shadow +
 * spacing so a non-designer gets a professional result in a single click (the
 * "I don't know how to start" answer). Each look only uses straight-text props
 * (no arc) so it applies in one updateActiveText pass and never trips the
 * arc-excludes-effects contract rule. The chip preview is rendered with the same
 * values, so what you see is what you get. Showcases the expanded font library.
 */
type TextStylePreset = {
  key: string;
  label: string;
  fontKey: string;
  fill: string;
  outline: TextOutline | null;
  shadow: TextShadow | null;
  letterSpacing?: number;
};

const TEXT_STYLE_PRESETS: TextStylePreset[] = [
  { key: 'varsity', label: 'Varsity', fontKey: 'archivo-black', fill: '#1d4ed8', outline: { color: '#ffffff', width: 6 }, shadow: null },
  { key: 'sport', label: 'Sport', fontKey: 'anton', fill: '#cf3f22', outline: { color: '#ffffff', width: 5 }, shadow: { color: '#000000', offsetX: 2, offsetY: 2 } },
  { key: 'retro', label: 'Retro', fontKey: 'bungee', fill: '#b45309', outline: null, shadow: { color: '#000000', offsetX: 3, offsetY: 3 } },
  { key: 'neon', label: 'Neon', fontKey: 'oswald', fill: '#22d3ee', outline: { color: '#0e7490', width: 4 }, shadow: { color: '#000000', offsetX: 2, offsetY: 2 } },
  { key: 'vintage', label: 'Vintage', fontKey: 'dm-serif-display', fill: '#1a1a1a', outline: null, shadow: null, letterSpacing: 4 },
  { key: 'handwritten', label: 'Casual', fontKey: 'pacifico', fill: '#1a1a1a', outline: null, shadow: null },
  { key: 'minimal', label: 'Minimal', fontKey: 'montserrat', fill: '#1a1a1a', outline: null, shadow: null, letterSpacing: 8 },
  { key: 'birthday', label: 'Party', fontKey: 'lobster', fill: '#db2777', outline: null, shadow: { color: '#000000', offsetX: 3, offsetY: 3 } },
];

/**
 * Curated starter designs ("logos") a non-designer opens and edits, rather than
 * facing a blank shirt. Each is a stack of styled text lines positioned by
 * fractions of the active print area, so the same template fits any product/side.
 * They drop in as ordinary, fully-editable text objects (no special object kind),
 * so they render server-side and round-trip with zero contract changes.
 */
type StarterLine = {
  text: string;
  fontKey: string;
  fill: string;
  outline?: TextOutline;
  shadow?: TextShadow;
  /** Center Y as a fraction of the print-area height. */
  cy: number;
  /** Font size as a fraction of the print-area height. */
  sizeFrac: number;
  letterSpacing?: number;
  align?: TextAlign;
};
type DesignTemplate = { key: string; name: string; lines: StarterLine[] };

const DESIGN_TEMPLATES: DesignTemplate[] = [
  {
    key: 'varsity-stack',
    name: 'Varsity',
    lines: [
      { text: 'EST. 1994', fontKey: 'oswald', fill: '#1d4ed8', cy: 0.36, sizeFrac: 0.045, letterSpacing: 6 },
      { text: 'BROOKLYN', fontKey: 'archivo-black', fill: '#1d4ed8', outline: { color: '#ffffff', width: 6 }, cy: 0.5, sizeFrac: 0.13 },
      { text: 'ATHLETIC CLUB', fontKey: 'oswald', fill: '#1d4ed8', cy: 0.62, sizeFrac: 0.04, letterSpacing: 4 },
    ],
  },
  {
    key: 'vintage-badge',
    name: 'Vintage',
    lines: [
      { text: 'ORIGINAL', fontKey: 'oswald', fill: '#1a1a1a', cy: 0.37, sizeFrac: 0.045, letterSpacing: 6 },
      { text: 'Heritage', fontKey: 'dm-serif-display', fill: '#1a1a1a', cy: 0.5, sizeFrac: 0.12 },
      { text: 'SINCE 2010', fontKey: 'oswald', fill: '#1a1a1a', cy: 0.62, sizeFrac: 0.04, letterSpacing: 5 },
    ],
  },
  {
    key: 'bold-statement',
    name: 'Bold',
    lines: [
      { text: 'STAY', fontKey: 'anton', fill: '#1a1a1a', cy: 0.42, sizeFrac: 0.16 },
      { text: 'WILD', fontKey: 'anton', fill: '#cf3f22', cy: 0.58, sizeFrac: 0.16 },
    ],
  },
  {
    key: 'script-name',
    name: 'Script',
    lines: [
      { text: 'the', fontKey: 'oswald', fill: '#db2777', cy: 0.38, sizeFrac: 0.05 },
      { text: 'Daydream', fontKey: 'pacifico', fill: '#db2777', cy: 0.52, sizeFrac: 0.12 },
      { text: 'CLUB', fontKey: 'oswald', fill: '#db2777', cy: 0.64, sizeFrac: 0.045, letterSpacing: 8 },
    ],
  },
  {
    key: 'monogram',
    name: 'Monogram',
    lines: [
      { text: 'M', fontKey: 'archivo-black', fill: '#1a1a1a', outline: { color: '#cf3f22', width: 5 }, cy: 0.5, sizeFrac: 0.28 },
    ],
  },
  {
    key: 'good-vibes',
    name: 'Good Vibes',
    lines: [
      { text: 'GOOD VIBES', fontKey: 'bungee', fill: '#b45309', shadow: { color: '#000000', offsetX: 3, offsetY: 3 }, cy: 0.5, sizeFrac: 0.1 },
    ],
  },
  {
    key: 'minimal-line',
    name: 'Minimal',
    lines: [{ text: 'less is more', fontKey: 'montserrat', fill: '#1a1a1a', cy: 0.5, sizeFrac: 0.06, letterSpacing: 10 }],
  },
  {
    key: 'party',
    name: 'Party',
    lines: [
      { text: 'HAPPY', fontKey: 'lobster', fill: '#db2777', cy: 0.42, sizeFrac: 0.12 },
      { text: 'BIRTHDAY', fontKey: 'lobster', fill: '#7c3aed', cy: 0.58, sizeFrac: 0.1 },
    ],
  },
];

/** Alignment as glyph icons (the universal text-align pictures), not words. */
const ALIGN_CHOICES: { key: TextAlign; aria: string; icon: React.ReactNode }[] = [
  {
    key: 'left',
    aria: 'Align left',
    icon: (
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
        <path d="M4 6h16M4 12h10M4 18h13" />
      </svg>
    ),
  },
  {
    key: 'center',
    aria: 'Align center',
    icon: (
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
        <path d="M4 6h16M7 12h10M6 18h12" />
      </svg>
    ),
  },
  {
    key: 'right',
    aria: 'Align right',
    icon: (
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
        <path d="M4 6h16M10 12h10M7 18h13" />
      </svg>
    ),
  },
];

/**
 * Every design object on the canvas is tagged with its kind and the print area it
 * belongs to. Inactive-area objects stay on the canvas but are hidden and
 * non-interactive; they are still serialized on save (one Fabric canvas, no
 * per-area canvas churn). `fontKey` holds the whitelist key for text objects
 * (Fabric's own fontFamily holds the CSS family name).
 */
type DesignedObject = FabricObject & {
  kind?: 'image' | 'text';
  assetId?: string;
  printAreaKey?: string;
  fontKey?: string;
  /** Contract direction value ('auto' | 'ltr' | 'rtl'); Fabric's own `direction` holds the resolved one. */
  textDirection?: TextDirection;
  /** v1.9 tiling fill (image objects); the preview rect is rebuilt from this. */
  pattern?: ImagePattern;
};

/** Non-interactive area-sized rect carrying the live pattern preview for one image. */
type PatternPreviewRect = Rect & {
  patternPreview?: true;
  patternFor?: DesignedObject;
  printAreaKey?: string;
};

/** IText for plain text, Textbox when wrap-in-box is on (same prop surface). */
type DesignedText = (IText | Textbox) & DesignedObject;

/**
 * Arced text (v1.8) is a FabricImage carrying its text metadata, because per-glyph
 * curved layout can't live in an IText. It is still `kind: 'text'` and serializes
 * as a text object with `arc`; both the editor raster and the server render use the
 * shared layoutArcGlyphs, so they agree. Inline editing is replaced by a panel
 * wording input. `arcProps` present is the discriminator.
 */
interface ArcTextProps {
  text: string;
  fontKey: string;
  fontSize: number;
  color: string;
  align: TextAlign;
  letterSpacing: number;
  arc: number;
}
type DesignedArcText = FabricImage & DesignedObject & { arcProps: ArcTextProps };
const isArcText = (obj: DesignedObject | undefined | null): obj is DesignedArcText =>
  Boolean(obj && (obj as DesignedArcText).arcProps);

/** Visual line count: Fabric's textLines includes soft wraps for Textbox. */
const visualLineCountOf = (t: DesignedText): number =>
  t instanceof Textbox ? t.textLines.length : (t.text ?? '').split('\n').length;

interface Status {
  tone: 'idle' | 'info' | 'error' | 'success';
  message: string;
  details?: string[];
}

interface SelectionReadout {
  kind: 'image' | 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  /** Advisory print quality; null for text objects (vector-like) and unknown sources. */
  quality: { effectiveDpi: number; level: PrintQualityLevel } | null;
  /** Physical print size in inches (image only); null when the area has no usable ppi. */
  physical: { widthIn: number; heightIn: number } | null;
  /** v1.9 tiling fill (image only); null = single image. */
  pattern: ImagePattern | null;
  /** Text styling, present when kind === 'text'. */
  text: {
    fontKey: string;
    color: string;
    fontSize: number;
    align: TextAlign;
    /** Contract direction value; 'auto' resolves live via resolvedDirection. */
    direction: TextDirection;
    /** What 'auto' (or the explicit value) resolves to right now. */
    resolvedDirection: 'ltr' | 'rtl';
    /** True when the object is a wrap-in-box Textbox. */
    wrap: boolean;
    /** Current visual line count (soft wraps included for Textbox). */
    lineCount: number;
    /** v1.8 glyph outline; null = off. */
    outline: TextOutline | null;
    /** v1.8 hard drop shadow; null = off. */
    shadow: TextShadow | null;
    /** v1.8 letter spacing in canvas px at the current effective size; 0 = default. */
    letterSpacing: number;
    /** v1.8 arc sweep in degrees; null = straight. */
    arc: number | null;
  } | null;
}

/** One short phrase per quality level; advisory voice, never a hard stop. */
const QUALITY_COPY: Record<PrintQualityLevel, string> = {
  ok: 'good to print',
  warning: 'may look soft up close',
  poor: 'too low for sharp print',
};

export function EditorClient({
  template,
  initialDesign,
}: {
  template: ProductTemplateDto;
  initialDesign?: DesignProjectDto;
}) {
  const router = useRouter();
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  /** Workspace section; the fullscreen target (carries canvas + zoom widget). */
  const stageSectionRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<Canvas | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const boundaryRef = useRef<Rect | null>(null);
  /** Loaded view images per area key ('' = template-level), so tab switches don't re-fetch. */
  const baseCacheRef = useRef(new Map<string, FabricImage>());
  const overlayCacheRef = useRef(new Map<string, FabricImage>());

  const zoom = STAGE_WIDTH / template.canvasWidth;
  const stageHeight = Math.round(template.canvasHeight * zoom);

  const [activeAreaKey, setActiveAreaKey] = useState<string>(
    () =>
      initialDesign?.design.placements[0]?.printAreaKey ??
      template.printAreas[0]?.key ??
      '',
  );
  /** Mirrors activeAreaKey for canvas event handlers registered once at init. */
  const activeAreaKeyRef = useRef(activeAreaKey);
  activeAreaKeyRef.current = activeAreaKey;

  /**
   * Chosen garment color (v2.0). A stored key that no longer exists falls back to
   * the default, mirroring the server's render rule. Preview-time only: swapping
   * colors never touches object geometry, so it lives outside the undo stack.
   */
  const [colorKey, setColorKey] = useState<string>(() => {
    const stored = initialDesign?.design.colorKey;
    if (stored && template.colors.some((c) => c.key === stored)) return stored;
    return template.colors.find((c) => c.isDefault)?.key ?? template.colors[0]?.key ?? '';
  });

  /**
   * Chosen garment size (v2.3). Order-time metadata: empty string = none picked.
   * Like color, it lives outside the undo stack and never touches geometry.
   */
  const [size, setSize] = useState<GarmentSize | ''>(initialDesign?.design.size ?? '');

  /** Bumped once the canvas exists so area-dependent effects can run. */
  const [canvasReady, setCanvasReady] = useState(false);

  const [status, setStatus] = useState<Status>(
    initialDesign
      ? { tone: 'info', message: 'Editing saved design. Save your changes, then re-render the mockups.' }
      : { tone: 'idle', message: 'Upload artwork to get started.' },
  );
  /** Object count per print area key, for the tab badges and the save guard. */
  const [areaCounts, setAreaCounts] = useState<Record<string, number>>({});
  const [selection, setSelection] = useState<SelectionReadout | null>(null);
  /** The persisted design being edited; null until the first successful save. */
  const [designId, setDesignId] = useState<string | null>(initialDesign?.id ?? null);
  /** True when ANY area differs from what the server has for designId (dirty is global). */
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'upload' | 'save' | 'render' | 'removebg' | 'crop' | null>(null);
  /** Mirrors busy for the undo/redo callbacks invoked from the keyboard handler. */
  const busyRef = useRef(busy);
  busyRef.current = busy;
  /** True while a file is dragged over the stage (drop-to-upload affordance). */
  const [dropActive, setDropActive] = useState(false);

  /** Active tool in the left rail; selecting a canvas object follows its kind. */
  const [tool, setTool] = useState<StudioTool>('uploads');
  /** Mirrors tool for canvas event handlers registered once at init. */
  const toolRef = useRef(tool);
  toolRef.current = tool;

  /** View zoom multiplier over the fit zoom (1 = product fits the stage). */
  const [viewZoom, setViewZoom] = useState(1);
  /** True while the workspace section owns the browser fullscreen. */
  const [isFullscreen, setIsFullscreen] = useState(false);

  /** Placement overview (v2.0): grid of every print side with its current ink. */
  const [overviewOpen, setOverviewOpen] = useState(false);

  /** Open contextual object tool (toolbar above the stage); null = toolbar only. */
  const [objectTool, setObjectTool] = useState<'transform' | 'position' | 'pattern' | null>(null);

  /** Local mirror of the selected arc text's wording, for the panel input. */
  const [arcWording, setArcWording] = useState('');
  /** Local mirror of the selected normal text's wording, for the panel input. */
  const [textWording, setTextWording] = useState('');
  /** Text panel "Advanced" disclosure; off = beginner-clean (visual controls only). */
  const [textAdvanced, setTextAdvanced] = useState(false);
  /** Recently used text colors (most-recent first), for quick reuse across objects. */
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const pushRecentColor = useCallback((color: string) => {
    const c = color.toLowerCase();
    setRecentColors((prev) => [c, ...prev.filter((p) => p !== c)].slice(0, 8));
  }, []);

  const activeArea = useMemo(
    () => template.printAreas.find((a) => a.key === activeAreaKey),
    [template.printAreas, activeAreaKey],
  );

  const activeColor = useMemo(
    () => template.colors.find((c) => c.key === colorKey),
    [template.colors, colorKey],
  );

  /**
   * Color-aware view image URLs for one area. Same precedence the server's render
   * uses: the color's area-specific image, else the area's own (only when the area
   * carries its own view), else the color's template-level blank, else the plain
   * template image.
   */
  const viewImagesOf = useCallback(
    (a: PrintAreaDto): { baseUrl: string; thumbUrl: string } => {
      const colorArea = activeColor?.areaImages.find((img) => img.printAreaKey === a.key);
      return {
        baseUrl: colorArea?.imageUrl ?? a.imageUrl ?? activeColor?.imageUrl ?? template.imageUrl,
        thumbUrl:
          colorArea?.thumbUrl ??
          a.thumbUrl ??
          activeColor?.thumbUrl ??
          template.thumbUrl ??
          a.imageUrl ??
          template.imageUrl,
      };
    },
    [activeColor, template.imageUrl, template.thumbUrl],
  );

  /** Canvas px per inch per area key, for the advisory DPI readout. */
  const ppiByKey = useMemo(
    () => new Map(template.printAreas.map((a) => [a.key, printAreaPpi(a)])),
    [template.printAreas],
  );

  /**
   * Draws one overview tile: the area's garment view (in the chosen color), every
   * designed object of that area rasterized at tile scale (pattern fills included,
   * in canvas z-order), then the fabric overlay with the same blend the live
   * canvas uses. Objects of inactive areas are hidden on the shared canvas, so
   * each is made visible just for its own rasterization.
   */
  const drawAreaPreview = useCallback(
    async (areaKey: string, el: HTMLCanvasElement): Promise<void> => {
      const canvas = canvasRef.current;
      const area = template.printAreas.find((a) => a.key === areaKey);
      const ctx = el.getContext('2d');
      if (!canvas || !area || !ctx) return;
      const scale = el.width / template.canvasWidth;
      ctx.clearRect(0, 0, el.width, el.height);

      try {
        const base = await loadHtmlImage(apiUrl(viewImagesOf(area).baseUrl));
        ctx.drawImage(base, 0, 0, el.width, el.height);
      } catch {
        // Tile degrades to ink on a blank background.
      }

      for (const obj of canvas.getObjects()) {
        const designed = obj as DesignedObject;
        const preview = obj as PatternPreviewRect;
        if (!(designed.kind || preview.patternPreview) || designed.printAreaKey !== areaKey) continue;
        const wasVisible = obj.visible;
        obj.visible = true;
        try {
          const raster = obj.toCanvasElement({ multiplier: scale });
          // Center-anchored placement: raster padding (retina, stroke) stays symmetric
          // around the object, so the centers line up even when the sizes differ.
          const r = obj.getBoundingRect();
          ctx.drawImage(
            raster,
            (r.left + r.width / 2) * scale - raster.width / 2,
            (r.top + r.height / 2) * scale - raster.height / 2,
          );
        } finally {
          obj.visible = wasVisible;
        }
      }

      const overlayUrl = area.overlayUrl ?? template.overlayUrl;
      if (overlayUrl) {
        try {
          const overlay = await loadHtmlImage(apiUrl(overlayUrl));
          ctx.globalCompositeOperation = FABRIC_OVERLAY_BLEND[area.overlayBlend ?? template.overlayBlend];
          ctx.drawImage(overlay, 0, 0, el.width, el.height);
          ctx.globalCompositeOperation = 'source-over';
        } catch {
          // Overlay is decorative; ignore.
        }
      }
    },
    [template, viewImagesOf],
  );

  const designedObjects = useCallback((): DesignedObject[] => {
    const canvas = canvasRef.current;
    if (!canvas) return [];
    return canvas.getObjects().filter((o): o is DesignedObject => Boolean((o as DesignedObject).kind));
  }, []);

  const refreshAreaCounts = useCallback(() => {
    const counts: Record<string, number> = {};
    for (const obj of designedObjects()) {
      if (obj.printAreaKey) counts[obj.printAreaKey] = (counts[obj.printAreaKey] ?? 0) + 1;
    }
    setAreaCounts(counts);
  }, [designedObjects]);

  // ---- undo/redo (v1.9): snapshot stack over the same placements format the
  // save path serializes, so restoring a snapshot reuses the tested reopen logic.
  /** Stack of PREVIOUS states; top = what undo restores. Serialized placements JSON. */
  const undoStackRef = useRef<string[]>([]);
  const redoStackRef = useRef<string[]>([]);
  /** The current state's serialization (the baseline the next mutation pushes). */
  const lastSnapshotRef = useRef<string>('[]');
  /** True while a snapshot is being applied; mutations then never record. */
  const restoringRef = useRef(false);
  /** Bumped on stack changes so the toolbar buttons re-render their disabled state. */
  const [historyVersion, setHistoryVersion] = useState(0);
  /** Late-bound: serializes the current placements; wired below collectPlacements. */
  const serializeStateRef = useRef<() => string>(() => '[]');
  /** Late-bound: records an undo step; wired below once collectPlacements exists. */
  const markMutatedRef = useRef<() => void>(() => {});
  /** Stable mutation hook for callbacks and canvas handlers: dirty + history. */
  const markMutated = useCallback(() => markMutatedRef.current(), []);
  /** Late-bound undo/redo for the keyboard handler registered once at init. */
  const undoRedoRef = useRef<{ undo: () => void; redo: () => void }>({
    undo: () => undefined,
    redo: () => undefined,
  });

  // ---- crop mode (v1.9): an interactive rect over the selected image; Apply
  // derives a cropped asset server-side and swaps the object in place.
  const cropRectRef = useRef<(Rect & { cropTag?: boolean }) | null>(null);
  const cropImageRef = useRef<(DesignedObject & FabricImage) | null>(null);
  const [cropping, setCropping] = useState(false);
  const croppingRef = useRef(cropping);
  croppingRef.current = cropping;
  /** Late-bound clamp for the canvas handlers registered once at init. */
  const clampCropRectRef = useRef<() => void>(() => {});
  /** Late-bound cancel for the area-switch effect (defined above the callback). */
  const cancelCropRef = useRef<() => void>(() => {});

  /** The print area an object belongs to; falls back to the active one. */
  const areaOf = useCallback(
    (obj: DesignedObject): PrintAreaDto | undefined =>
      template.printAreas.find((a) => a.key === (obj.printAreaKey ?? activeAreaKeyRef.current)),
    [template.printAreas],
  );

  // ---- pattern preview (v1.9): a non-interactive area-sized rect under the tile,
  // filled with a meta-tile canvas Pattern so the repeat is visible live.

  /** Draws the meta-tile (1x1 grid, 2x2 mirror, 2-col half-drop) for a patterned image. */
  const buildMetaTile = useCallback((obj: DesignedObject & FabricImage): HTMLCanvasElement | null => {
    const el = obj.getElement() as HTMLImageElement | HTMLCanvasElement | undefined;
    const pattern = obj.pattern;
    if (!el || !pattern) return null;
    const tileW = Math.max(1, Math.round(obj.getScaledWidth()));
    const tileH = Math.max(1, Math.round(obj.getScaledHeight()));
    const spacing = Math.round(pattern.spacing);
    const stepX = tileW + spacing;
    const stepY = tileH + spacing;

    const meta = document.createElement('canvas');
    meta.width = pattern.type === 'grid' ? stepX : 2 * stepX;
    meta.height = pattern.type === 'mirror' ? 2 * stepY : stepY;
    const ctx = meta.getContext('2d');
    if (!ctx) return null;

    const draw = (x: number, y: number, flipX: boolean, flipY: boolean) => {
      ctx.save();
      ctx.translate(x + (flipX ? tileW : 0), y + (flipY ? tileH : 0));
      ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
      ctx.drawImage(el, 0, 0, tileW, tileH);
      ctx.restore();
    };
    if (pattern.type === 'grid') {
      draw(0, 0, false, false);
    } else if (pattern.type === 'mirror') {
      draw(0, 0, false, false);
      draw(stepX, 0, true, false);
      draw(0, stepY, false, true);
      draw(stepX, stepY, true, true);
    } else {
      // half-drop: second column shifted half a step, drawn twice so it wraps.
      draw(0, 0, false, false);
      draw(stepX, Math.round(stepY / 2), false, false);
      draw(stepX, Math.round(stepY / 2) - stepY, false, false);
    }
    return meta;
  }, []);

  /** Cheap per-drag update: re-phases the existing preview fill to the tile position. */
  const updatePatternOffset = useCallback(
    (obj: DesignedObject) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const preview = canvas
        .getObjects()
        .find((o) => (o as PatternPreviewRect).patternFor === obj) as PatternPreviewRect | undefined;
      const area = areaOf(obj);
      const fill = preview?.fill;
      if (!preview || !area || !(fill instanceof Pattern)) return;
      const source = fill.source as HTMLCanvasElement;
      const mod = (a: number, n: number) => ((a % n) + n) % n;
      fill.offsetX = mod((obj.left ?? 0) - obj.getScaledWidth() / 2 - area.x, source.width);
      fill.offsetY = mod((obj.top ?? 0) - obj.getScaledHeight() / 2 - area.y, source.height);
      preview.dirty = true;
      canvas.requestRenderAll();
    },
    [areaOf],
  );

  /** Removes the preview rect belonging to the given image, if any. */
  const removePatternPreviewFor = useCallback((obj: DesignedObject) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    for (const o of [...canvas.getObjects()]) {
      if ((o as PatternPreviewRect).patternFor === obj) canvas.remove(o);
    }
  }, []);

  /** Full rebuild: new meta-tile (size/spacing/type changes) + fresh preview rect. */
  const refreshPatternPreview = useCallback(
    (obj: DesignedObject) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      removePatternPreviewFor(obj);
      if (obj.kind !== 'image' || !obj.pattern) {
        canvas.requestRenderAll();
        return;
      }
      const area = areaOf(obj);
      const meta = buildMetaTile(obj as DesignedObject & FabricImage);
      if (!area || !meta) return;
      const rect = new Rect({
        left: area.x,
        top: area.y,
        originX: 'left',
        originY: 'top',
        width: area.width,
        height: area.height,
        fill: new Pattern({ source: meta, repeat: 'repeat' }),
        selectable: false,
        evented: false,
        visible: obj.visible,
      }) as PatternPreviewRect;
      rect.patternPreview = true;
      rect.patternFor = obj;
      rect.printAreaKey = obj.printAreaKey;
      canvas.add(rect);
      canvas.sendObjectToBack(rect);
      updatePatternOffset(obj);
      canvas.requestRenderAll();
    },
    [areaOf, buildMetaTile, removePatternPreviewFor, updatePatternOffset],
  );

  /** Late-bound mirrors for the canvas handlers registered once at init. */
  const patternHooksRef = useRef({
    refresh: (_obj: DesignedObject) => {},
    offset: (_obj: DesignedObject) => {},
    remove: (_obj: DesignedObject) => {},
  });
  patternHooksRef.current = {
    refresh: refreshPatternPreview,
    offset: updatePatternOffset,
    remove: removePatternPreviewFor,
  };

  /** Keep the object's bounding box inside ITS OWN print area by translating it. */
  const clampToPrintArea = useCallback(
    (obj: DesignedObject) => {
      const area = areaOf(obj);
      if (!area) return;
      const box = obj.getBoundingRect();
      let dx = 0;
      let dy = 0;
      if (box.left < area.x) dx = area.x - box.left;
      if (box.top < area.y) dy = area.y - box.top;
      if (box.left + box.width > area.x + area.width) {
        dx = area.x + area.width - (box.left + box.width);
      }
      if (box.top + box.height > area.y + area.height) {
        dy = area.y + area.height - (box.top + box.height);
      }
      if (dx !== 0 || dy !== 0) {
        obj.set({ left: (obj.left ?? 0) + dx, top: (obj.top ?? 0) + dy });
        obj.setCoords();
      }
    },
    [areaOf],
  );

  /** After scaling/rotating, shrink the object if its box no longer fits its area, then clamp. */
  const fitToPrintArea = useCallback(
    (obj: DesignedObject) => {
      const area = areaOf(obj);
      if (!area) return;
      const box = obj.getBoundingRect();
      const factor = Math.min(area.width / box.width, area.height / box.height, 1);
      if (factor < 1) {
        obj.set({
          scaleX: (obj.scaleX ?? 1) * factor,
          scaleY: (obj.scaleY ?? 1) * factor,
        });
        obj.setCoords();
      }
      clampToPrintArea(obj);
    },
    [areaOf, clampToPrintArea],
  );

  /**
   * Advisory print quality of one canvas object. A FabricImage's unscaled
   * width/height IS the source pixel size (uploads are stored at original size),
   * so the editor needs no extra API data for the DPI math.
   */
  const qualityOf = useCallback(
    (obj: DesignedObject) => {
      const ppi = ppiByKey.get(obj.printAreaKey ?? activeAreaKeyRef.current) ?? null;
      return evaluateObjectQuality(
        { width: obj.width ?? null, height: obj.height ?? null },
        { width: obj.getScaledWidth(), height: obj.getScaledHeight() },
        ppi,
      );
    },
    [ppiByKey],
  );

  const readSelection = useCallback(
    (obj: FabricObject | undefined | null) => {
      const designed = obj as DesignedObject | undefined | null;
      if (!designed?.kind) {
        setSelection(null);
        return;
      }
      // The contextual panel follows the selected object's kind, except while the
      // user is browsing the layers list (selecting from there must not yank the
      // panel away).
      if (toolRef.current !== 'layers') {
        setTool(designed.kind === 'text' ? 'text' : 'uploads');
      }
      // DPI is image-only: text is vector-like and rerenders sharp at any size.
      const quality = designed.kind === 'image' ? qualityOf(designed) : null;
      // Physical print size mirrors the layer card in commercial editors: how big
      // this artwork will actually print, in inches, on its own print area.
      const ppi = ppiByKey.get(designed.printAreaKey ?? activeAreaKeyRef.current) ?? null;
      const physical =
        designed.kind === 'image' && ppi
          ? {
              widthIn: Math.round((designed.getScaledWidth() / ppi.x) * 10) / 10,
              heightIn: Math.round((designed.getScaledHeight() / ppi.y) * 10) / 10,
            }
          : null;
      const t = designed as DesignedText;
      // Arced text is a tagged image; its panel state comes from arcProps, scaled
      // size and effects (none allowed) excluded.
      const text = isArcText(designed)
        ? {
            fontKey: designed.arcProps.fontKey,
            color: designed.arcProps.color,
            fontSize: Math.round(designed.arcProps.fontSize * (designed.scaleY ?? 1)),
            align: designed.arcProps.align,
            direction: 'ltr' as TextDirection,
            resolvedDirection: 'ltr' as const,
            wrap: false,
            lineCount: 1,
            outline: null,
            shadow: null,
            letterSpacing: designed.arcProps.letterSpacing * (designed.scaleY ?? 1),
            arc: designed.arcProps.arc,
          }
        : designed.kind === 'text'
          ? {
              fontKey: designed.fontKey ?? TEXT_DEFAULTS.fontKey,
              color: typeof t.fill === 'string' ? (t.fill as string) : TEXT_DEFAULTS.color,
              fontSize: Math.round(
                (t.fontSize ?? TEXT_DEFAULTS.fontSize) * (designed.scaleY ?? 1),
              ),
              align: (t.textAlign as TextAlign) ?? TEXT_DEFAULTS.align,
              direction: designed.textDirection ?? 'auto',
              resolvedDirection: resolveTextDirection(t.text ?? '', designed.textDirection ?? 'auto'),
              wrap: t instanceof Textbox,
              lineCount: visualLineCountOf(t),
              // Effects live in Fabric's own props: stroke pair for the outline,
              // the Shadow object for the shadow. No extra tags to drift.
              outline:
                typeof t.stroke === 'string' && (t.strokeWidth ?? 0) > 0
                  ? { color: t.stroke, width: t.strokeWidth ?? 0 }
                  : null,
              shadow:
                t.shadow && typeof t.shadow === 'object'
                  ? {
                      color: typeof t.shadow.color === 'string' ? t.shadow.color : '#000000',
                      offsetX: t.shadow.offsetX ?? 0,
                      offsetY: t.shadow.offsetY ?? 0,
                    }
                  : null,
              // Fabric charSpacing is em/1000; px at the effective (scaled) size.
              letterSpacing:
                ((t.charSpacing ?? 0) / 1000) *
                (t.fontSize ?? TEXT_DEFAULTS.fontSize) *
                (designed.scaleY ?? 1),
              arc: null,
            }
          : null;
      setSelection({
        kind: designed.kind,
        x: Math.round(designed.left ?? 0),
        y: Math.round(designed.top ?? 0),
        width: Math.round(designed.getScaledWidth()),
        height: Math.round(designed.getScaledHeight()),
        rotation: Math.round(designed.angle ?? 0),
        quality: quality
          ? { effectiveDpi: Math.round(quality.effectiveDpi), level: quality.level }
          : null,
        physical,
        pattern: designed.kind === 'image' ? (designed.pattern ?? null) : null,
        text,
      });
    },
    [qualityOf, ppiByKey],
  );

  const removeActiveObject = useCallback(() => {
    const canvas = canvasRef.current;
    const active = canvas?.getActiveObject() as DesignedObject | undefined;
    if (canvas && active?.kind) {
      patternHooksRef.current.remove(active);
      canvas.remove(active);
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      setSelection(null);
      markMutated();
      refreshAreaCounts();
    }
  }, [refreshAreaCounts]);

  /**
   * Keeps the effective font size (fontSize * scale) inside the contract bounds so a
   * corner-scaled text object can never serialize to a size the server would reject.
   */
  const clampTextScale = useCallback((obj: DesignedObject) => {
    if (obj.kind !== 'text') return;
    const t = obj as DesignedText;
    const fontSize = t.fontSize ?? TEXT_DEFAULTS.fontSize;
    const effective = fontSize * (t.scaleY ?? 1);
    const clamped = Math.min(Math.max(effective, FONT_SIZE_MIN), FONT_SIZE_MAX);
    if (clamped !== effective) {
      const scale = clamped / fontSize;
      t.set({ scaleX: scale, scaleY: scale });
      t.setCoords();
    }
  }, []);

  /**
   * Builds a tagged IText (plain) or Textbox (wrap-in-box) with the editor's
   * interaction rules. Fabric's `direction` always carries the RESOLVED direction;
   * the contract value (possibly 'auto') lives on the textDirection tag.
   */
  const makeDesignedText = useCallback(
    (
      content: string,
      areaKey: string,
      props: {
        fontKey: string;
        fontSize: number;
        color: string;
        align: TextAlign;
        direction?: TextDirection;
        wrap?: boolean;
        /** Wrap box width; Textbox only. */
        width?: number;
        /** v1.8 glyph outline; the stroke joins the measured box on purpose. */
        outline?: TextOutline;
        /** v1.8 hard drop shadow; never part of the measured box. */
        shadow?: TextShadow;
        /** v1.8 letter spacing in canvas px (mapped to em-based charSpacing). */
        letterSpacing?: number;
      },
    ): DesignedText => {
      const definition = fontDefinitionOf(props.fontKey) ?? FONT_WHITELIST[0];
      const direction = props.direction ?? 'auto';
      const common = {
        fontFamily: definition.family,
        fontSize: props.fontSize,
        fill: props.color,
        textAlign: props.align,
        originX: 'center' as const,
        originY: 'center' as const,
        direction: resolveTextDirection(content, direction),
        // px -> Fabric's em-based charSpacing (relative to the unscaled fontSize).
        ...(props.letterSpacing
          ? { charSpacing: (props.letterSpacing * 1000) / props.fontSize }
          : {}),
        // Without an outline, strokeWidth is 0: Fabric's default (1) inflates
        // getScaledWidth() by 1px even with no stroke, which can flip a
        // boundary-tight Textbox line break across save/reopen cycles. With an
        // outline the stroke joins the measurement on purpose (the server fits
        // the ring-composited raster to the same stroke-inclusive box).
        ...(props.outline
          ? {
              stroke: props.outline.color,
              strokeWidth: props.outline.width,
              paintFirst: 'stroke' as const,
              strokeLineJoin: 'round' as const,
            }
          : { strokeWidth: 0 }),
        ...(props.shadow
          ? {
              shadow: new Shadow({
                color: props.shadow.color,
                offsetX: props.shadow.offsetX,
                offsetY: props.shadow.offsetY,
                blur: 0,
              }),
            }
          : {}),
      };
      const itext = (
        props.wrap
          ? new Textbox(content, { ...common, width: props.width ?? 240 })
          : new IText(content, common)
      ) as DesignedText;
      if (props.wrap) {
        // Side middle handles change the Textbox wrap width without scaling glyphs
        // (exactly the controlled reflow we want); top/bottom stay hidden because
        // the height is derived from the wrapped lines.
        itext.setControlsVisibility({ ml: true, mr: true, mt: false, mb: false });
      } else {
        // Corner handles only: non-uniform stretching would decouple the visual size
        // from fontSize and break the save-time bake (fontSize * scale).
        itext.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
      }
      applySelectionStyle(itext);
      itext.kind = 'text';
      itext.fontKey = definition.key;
      itext.printAreaKey = areaKey;
      itext.textDirection = direction;
      return itext;
    },
    [],
  );

  /**
   * Rebuilds one stored image object on the canvas (reopen and undo/redo paths).
   * Async (network image); checks the canvas is still current before adding.
   */
  const restoreImageObject = useCallback(
    (saved: Extract<DesignObject, { type: 'image' }>, areaKey: string): Promise<void> => {
      const canvas = canvasRef.current;
      if (!canvas) return Promise.resolve();
      return FabricImage.fromURL(apiUrl(assetFileUrl(saved.assetId)), { crossOrigin: 'anonymous' })
        .then((img) => {
          if (canvasRef.current !== canvas) return;
          const naturalWidth = img.width ?? saved.width;
          const naturalHeight = img.height ?? saved.height;
          const mine = areaKey === activeAreaKeyRef.current;
          img.set({
            originX: 'center',
            originY: 'center',
            left: saved.x,
            top: saved.y,
            scaleX: saved.width / naturalWidth,
            scaleY: saved.height / naturalHeight,
            angle: saved.rotation,
            visible: mine,
            evented: mine,
            selectable: mine,
          });
          applySelectionStyle(img);
          const designed = img as DesignedObject;
          designed.kind = 'image';
          designed.assetId = saved.assetId;
          designed.printAreaKey = areaKey;
          if (saved.pattern) {
            designed.pattern = saved.pattern;
            designed.set({ lockRotation: true });
            designed.setControlsVisibility({ mtr: false });
          }
          canvas.add(img);
          if (saved.pattern) patternHooksRef.current.refresh(designed);
          canvas.requestRenderAll();
          refreshAreaCounts();
        })
        .catch(() => {
          setStatus({
            tone: 'error',
            message: 'Some saved artwork could not be loaded; it may have been removed.',
          });
        });
    },
    [refreshAreaCounts],
  );

  /**
   * Rebuilds one stored text object on the canvas (reopen and undo/redo paths).
   * Waits for the fonts: measuring with a fallback would distort the
   * scale-to-stored-box math.
   */
  /** Late-bound makeArcText (defined below) so restore can build arc text too. */
  const makeArcTextRef = useRef<(props: ArcTextProps, areaKey: string) => DesignedArcText | null>(
    () => null,
  );

  const restoreTextObject = useCallback(
    (saved: Extract<DesignObject, { type: 'text' }>, areaKey: string): Promise<void> => {
      const canvas = canvasRef.current;
      if (!canvas) return Promise.resolve();
      return ensureEditorFonts()
        .catch(() => undefined) // degraded measurement beats losing the object
        .then(() => {
          if (canvasRef.current !== canvas) return;
          const mine = areaKey === activeAreaKeyRef.current;
          // Arced text restores as a re-rastered image (same layoutArcGlyphs).
          if (saved.arc) {
            const arc = makeArcTextRef.current(
              {
                text: saved.text,
                fontKey: saved.fontFamily,
                fontSize: saved.fontSize,
                color: saved.color,
                align: saved.align,
                letterSpacing: saved.letterSpacing ?? 0,
                arc: saved.arc,
              },
              areaKey,
            );
            if (!arc) return;
            arc.set({ left: saved.x, top: saved.y, angle: saved.rotation, visible: mine, evented: mine, selectable: mine });
            const naturalWidth = arc.getScaledWidth();
            const naturalHeight = arc.getScaledHeight();
            if (naturalWidth && naturalHeight) {
              arc.set({ scaleX: saved.width / naturalWidth, scaleY: saved.height / naturalHeight });
            }
            arc.setCoords();
            canvas.add(arc);
            canvas.requestRenderAll();
            refreshAreaCounts();
            return;
          }
          const isBox = saved.wrapMode === 'box';
          const itext = makeDesignedText(saved.text, areaKey, {
            fontKey: saved.fontFamily,
            fontSize: saved.fontSize,
            color: saved.color,
            align: saved.align,
            direction: saved.direction ?? 'auto',
            wrap: isBox,
            // The stored width IS the wrap box width; the Textbox re-wraps live
            // with its own engine and regenerates wrappedLines on the next save.
            width: isBox ? saved.width : undefined,
            outline: saved.outline,
            shadow: saved.shadow,
            letterSpacing: saved.letterSpacing,
          });
          itext.set({
            left: saved.x,
            top: saved.y,
            angle: saved.rotation,
            visible: mine,
            evented: mine,
            selectable: mine,
          });
          // Faithful geometry for plain text: scale the measured natural box to the
          // stored box, so validation sees exactly the saved rectangle even if
          // metrics drifted. A Textbox already has the exact stored width and a
          // self-consistent re-wrapped height; scaling it would change the wrap.
          // Stroke-inclusive dims (getScaled* at scale 1), NOT width/height: the
          // saved box includes the v1.8 outline stroke, the raw props do not;
          // dividing mismatched boxes inflated outlined text ~11% per reopen.
          if (!isBox) {
            const naturalWidth = itext.getScaledWidth();
            const naturalHeight = itext.getScaledHeight();
            if (naturalWidth && naturalHeight) {
              itext.set({
                scaleX: saved.width / naturalWidth,
                scaleY: saved.height / naturalHeight,
              });
            }
          }
          itext.setCoords();
          canvas.add(itext);
          canvas.requestRenderAll();
          refreshAreaCounts();
        });
    },
    [makeDesignedText, refreshAreaCounts],
  );

  /**
   * Rasters arced text to an offscreen canvas using the shared layoutArcGlyphs
   * (canvas measureText advances), at 2x for crispness. The canvas is exactly the
   * layout bounds, so rotated glyphs clip identically to the server. Fonts must be
   * loaded first (the caller awaits ensureEditorFonts).
   */
  const rasterizeArcText = useCallback((props: ArcTextProps): HTMLCanvasElement | null => {
    const definition = fontDefinitionOf(props.fontKey) ?? FONT_WHITELIST[0];
    const SS = 2; // supersample
    const measure = document.createElement('canvas').getContext('2d');
    if (!measure) return null;
    measure.font = `${props.fontSize}px "${definition.family}"`;
    const chars = [...props.text];
    const advances = chars.map((c) => Math.max(1, measure.measureText(c).width));
    const layout = layoutArcGlyphs(advances, props.fontSize, props.arc, props.letterSpacing);
    if (layout.positions.length === 0 || layout.width <= 0 || layout.height <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(layout.width) * SS;
    canvas.height = Math.ceil(layout.height) * SS;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(SS, SS);
    ctx.font = `${props.fontSize}px "${definition.family}"`;
    ctx.fillStyle = props.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    chars.forEach((char, i) => {
      const p = layout.positions[i]!;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotationDeg * Math.PI) / 180);
      ctx.fillText(char, 0, 0);
      ctx.restore();
    });
    return canvas;
  }, []);

  /**
   * Builds (or rebuilds) an arced-text FabricImage from props. Display size = the
   * raster's layout px at scale 1, so getScaledWidth/Height serialize the box the
   * server fits its own arc raster into. Center/area/angle are set by the caller.
   */
  const makeArcText = useCallback(
    (props: ArcTextProps, areaKey: string): DesignedArcText | null => {
      const raster = rasterizeArcText(props);
      if (!raster) return null;
      const SS = 2;
      const img = new FabricImage(raster, {
        originX: 'center',
        originY: 'center',
        scaleX: 1 / SS,
        scaleY: 1 / SS,
      }) as DesignedArcText;
      applySelectionStyle(img);
      img.kind = 'text';
      img.printAreaKey = areaKey;
      img.arcProps = props;
      // Uniform corner scaling only; the raster is a baked unit.
      img.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
      return img;
    },
    [rasterizeArcText],
  );
  makeArcTextRef.current = makeArcText;

  /** Loads a view image (base or overlay) into the per-area cache. */
  const loadViewImage = useCallback(
    async (cache: Map<string, FabricImage>, cacheKey: string, url: string): Promise<FabricImage> => {
      const cached = cache.get(cacheKey);
      if (cached) return cached;
      const img = await FabricImage.fromURL(apiUrl(url), { crossOrigin: 'anonymous' });
      img.set({
        scaleX: template.canvasWidth / (img.width ?? template.canvasWidth),
        scaleY: template.canvasHeight / (img.height ?? template.canvasHeight),
        originX: 'left',
        originY: 'top',
      });
      cache.set(cacheKey, img);
      return img;
    },
    [template.canvasWidth, template.canvasHeight],
  );

  // ---- canvas init: create once per template/design ----
  useEffect(() => {
    const el = canvasElRef.current;
    if (!el || template.printAreas.length === 0) return;

    const canvas = new Canvas(el, {
      width: STAGE_WIDTH,
      height: stageHeight,
      selection: false,
      preserveObjectStacking: true,
    });
    canvas.setZoom(zoom);
    canvasRef.current = canvas;
    // Exposed for the Playwright smoke test.
    (window as unknown as { __studioCanvas?: Canvas }).__studioCanvas = canvas;

    let disposed = false;

    const boundary = new Rect({
      left: 0,
      top: 0,
      width: 10,
      height: 10,
      originX: 'left',
      originY: 'top',
      fill: 'transparent',
      ...BOUNDARY_QUIET,
      strokeUniform: true,
      selectable: false,
      evented: false,
      visible: false, // positioned by the area effect before first paint
    });
    canvas.add(boundary);
    boundaryRef.current = boundary;

    // Fonts load eagerly so Add Text and text reconstruction measure correctly.
    // A failure here is surfaced when text is actually used, not on every page view.
    void ensureEditorFonts().catch(() => undefined);

    // History starts fresh per canvas; the baseline lands after the restores settle.
    undoStackRef.current = [];
    redoStackRef.current = [];
    lastSnapshotRef.current = '[]';
    setHistoryVersion((v) => v + 1);

    // Re-open mode: place every saved object of every placement back exactly as persisted.
    if (initialDesign) {
      const pending: Promise<void>[] = [];
      for (const placement of initialDesign.design.placements) {
        for (const saved of placement.objects) {
          pending.push(
            saved.type === 'text'
              ? restoreTextObject(saved, placement.printAreaKey)
              : restoreImageObject(saved, placement.printAreaKey),
          );
        }
      }
      // Undo's baseline is the restored design, not the empty canvas: the first
      // undo after a reopen must revert the first EDIT, never wipe the design.
      void Promise.allSettled(pending).then(() => {
        if (!disposed) lastSnapshotRef.current = serializeStateRef.current();
      });
    }

    // Centerline snap guides: one vertical + one horizontal line per drag, added
    // lazily and removed when the drag ends. Guides are chrome, not content:
    // unselectable, excluded from export, invisible to the save path (no kind).
    const guides: { v: Line | null; h: Line | null } = { v: null, h: null };
    const setGuide = (axis: 'v' | 'h', show: boolean, areaRect?: PrintAreaDto) => {
      if (show && !guides[axis] && areaRect) {
        const cx = areaRect.x + areaRect.width / 2;
        const cy = areaRect.y + areaRect.height / 2;
        const line = new Line(
          axis === 'v'
            ? [cx, areaRect.y, cx, areaRect.y + areaRect.height]
            : [areaRect.x, cy, areaRect.x + areaRect.width, cy],
          SNAP_GUIDE_STYLE,
        );
        guides[axis] = line;
        canvas.add(line);
        canvas.bringObjectToFront(line);
      } else if (!show && guides[axis]) {
        canvas.remove(guides[axis]!);
        guides[axis] = null;
      }
    };
    const clearGuides = () => {
      setGuide('v', false);
      setGuide('h', false);
    };

    const onMoving = (e: { target?: FabricObject }) => {
      if (!e.target) return;
      // The crop rect clamps against ITS IMAGE, not the print area.
      if ((e.target as { cropTag?: boolean }).cropTag) {
        clampCropRectRef.current();
        return;
      }
      const target = e.target as DesignedObject;
      clampToPrintArea(target);

      // Snap the object center onto the print-area centerlines while dragging;
      // moving past the threshold on the next event releases the snap.
      const areaRect = areaOf(target);
      if (areaRect && target.kind) {
        const center = target.getCenterPoint();
        const dx = areaRect.x + areaRect.width / 2 - center.x;
        const dy = areaRect.y + areaRect.height / 2 - center.y;
        const snapV = Math.abs(dx) <= SNAP_THRESHOLD;
        const snapH = Math.abs(dy) <= SNAP_THRESHOLD;
        if (snapV || snapH) {
          target.set({
            left: (target.left ?? 0) + (snapV ? dx : 0),
            top: (target.top ?? 0) + (snapH ? dy : 0),
          });
          target.setCoords();
        }
        setGuide('v', snapV, areaRect);
        setGuide('h', snapH, areaRect);
      } else {
        clearGuides();
      }

      // Dragging a patterned tile re-phases its preview fill (cheap path).
      if (target.pattern) {
        patternHooksRef.current.offset(target);
      }
    };
    const onModified = (e: { target?: FabricObject }) => {
      clearGuides(); // the drag (or transform) is over; snap chrome goes away
      if (e.target && (e.target as { cropTag?: boolean }).cropTag) {
        clampCropRectRef.current();
        canvas.requestRenderAll();
        return; // adjusting the crop frame is not a design mutation
      }
      if (e.target) {
        clampTextScale(e.target as DesignedObject);
        fitToPrintArea(e.target as DesignedObject);
        // Scaling changes the tile size: rebuild the preview's meta-tile.
        if ((e.target as DesignedObject).pattern) {
          patternHooksRef.current.refresh(e.target as DesignedObject);
        }
        canvas.requestRenderAll();
        readSelection(e.target);
      }
      markMutated(); // edits make the saved design (and its previews) stale
    };
    const onSelection = () => {
      boundaryRef.current?.set(BOUNDARY_ACTIVE);
      readSelection(canvas.getActiveObject());
    };
    const onCleared = () => {
      clearGuides();
      boundaryRef.current?.set(BOUNDARY_QUIET);
      canvas.requestRenderAll();
      setSelection(null);
    };
    // Inline editing can grow the text box past the print area; re-fit when it ends
    // (per keystroke would fight the caret).
    const onTextEditingExited = (e: { target?: FabricObject }) => {
      if (e.target) {
        clampTextScale(e.target as DesignedObject);
        fitToPrintArea(e.target as DesignedObject);
        canvas.requestRenderAll();
        readSelection(e.target);
      }
      markMutated();
    };
    // Live during typing: re-resolve 'auto' direction (first strong character may
    // have changed) and refresh the readout so the overflow warning tracks the
    // current wrapped line count. No re-fit here; that would fight the caret.
    const onTextChanged = (e: { target?: FabricObject }) => {
      const target = e.target as DesignedText | undefined;
      if (!target || (target as DesignedObject).kind !== 'text') return;
      if ((target.textDirection ?? 'auto') === 'auto') {
        const resolved = resolveTextDirection(target.text ?? '');
        if (target.direction !== resolved) target.set({ direction: resolved });
      }
      readSelection(target);
    };

    canvas.on('object:moving', onMoving);
    canvas.on('object:modified', onModified);
    canvas.on('selection:created', onSelection);
    canvas.on('selection:updated', onSelection);
    canvas.on('selection:cleared', onCleared);
    canvas.on('text:editing:exited', onTextEditingExited);
    canvas.on('text:changed', onTextChanged);

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      // Inline text editing owns the keyboard (incl. its own ctrl+z behavior).
      if ((canvas.getActiveObject() as IText | undefined)?.isEditing) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) undoRedoRef.current.redo();
        else undoRedoRef.current.undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        undoRedoRef.current.redo();
        return;
      }

      // Arrow-key nudge: 1 canvas px per tap, 10 with Shift. preventDefault
      // keeps the page from scrolling while an object is selected.
      const NUDGE: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const step = NUDGE[event.key];
      if (step) {
        const active = canvas.getActiveObject() as DesignedObject | undefined;
        if (!active?.kind) return;
        event.preventDefault();
        const factor = event.shiftKey ? 10 : 1;
        active.set({
          left: (active.left ?? 0) + step[0] * factor,
          top: (active.top ?? 0) + step[1] * factor,
        });
        active.setCoords();
        clampToPrintArea(active);
        if (active.pattern) patternHooksRef.current.offset(active);
        canvas.requestRenderAll();
        readSelection(active);
        markMutated();
        return;
      }

      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      removeActiveObject();
    };
    window.addEventListener('keydown', onKeyDown);

    setCanvasReady(true);

    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKeyDown);
      setCanvasReady(false);
      baseCacheRef.current.clear();
      overlayCacheRef.current.clear();
      boundaryRef.current = null;
      void canvas.dispose();
      canvasRef.current = null;
    };
  }, [
    template,
    initialDesign,
    zoom,
    stageHeight,
    areaOf,
    clampToPrintArea,
    clampTextScale,
    fitToPrintArea,
    markMutated,
    readSelection,
    removeActiveObject,
    refreshAreaCounts,
    restoreImageObject,
    restoreTextObject,
  ]);

  // ---- view zoom: scale the viewport around the stage center ----
  // At viewZoom 1 the transform is exactly [fit, 0, 0, fit, 0, 0] (the v1 behavior);
  // zooming never touches object geometry, only the viewport.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvasReady || !canvas) return;
    const z = zoom * viewZoom;
    const offsetX = (STAGE_WIDTH - template.canvasWidth * z) / 2;
    const offsetY = (stageHeight - template.canvasHeight * z) / 2;
    canvas.setViewportTransform([z, 0, 0, z, offsetX, offsetY]);
    canvas.requestRenderAll();
  }, [canvasReady, viewZoom, zoom, stageHeight, template.canvasWidth, template.canvasHeight]);

  // ---- wheel zoom: Ctrl/Cmd + wheel over the stage (the design-tool standard) ----
  // Plain wheel is left alone; only the modifier zooms, so it never hijacks a
  // scroll. Non-passive listener so preventDefault stops the page from zooming.
  useEffect(() => {
    const el = stageWrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015); // smooth, direction-correct
      setViewZoom((v) => Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, v * factor)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [canvasReady]);

  // ---- fullscreen workspace: blow the stage up to fill the screen ----
  // Separate from view zoom: fullscreen gives ROOM, the reset button gives a
  // 1:1 fit. The state mirrors the browser so Esc (native exit) updates the icon.
  const toggleFullscreen = useCallback(() => {
    const el = stageSectionRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // ---- area switch: swap view images + boundary, toggle object visibility ----
  useEffect(() => {
    const canvas = canvasRef.current;
    const boundary = boundaryRef.current;
    const area = template.printAreas.find((a) => a.key === activeAreaKey);
    if (!canvasReady || !canvas || !boundary || !area) return;

    // A crop in progress belongs to the side being left; abandon it cleanly.
    cancelCropRef.current();

    let cancelled = false;

    // Boundary follows the active area; switching sides always lands in the quiet state
    // (the active object is discarded right below).
    boundary.set({
      left: area.x,
      top: area.y,
      width: area.width,
      height: area.height,
      visible: true,
      ...BOUNDARY_QUIET,
    });
    boundary.setCoords();

    // Only the active area's objects are visible and interactive. Hidden objects keep
    // their geometry untouched; save serializes them from the same canvas.
    for (const obj of designedObjects()) {
      const mine = obj.printAreaKey === area.key;
      obj.set({ visible: mine, evented: mine, selectable: mine });
    }
    // Pattern previews follow their area like the objects they belong to.
    for (const o of canvas.getObjects()) {
      const preview = o as PatternPreviewRect;
      if (preview.patternPreview) preview.set({ visible: preview.printAreaKey === area.key });
    }
    canvas.discardActiveObject();
    setSelection(null);
    canvas.requestRenderAll();

    // View images: color-aware base (the chosen color's blank for this view) with
    // the same fallback chain the server renders with; cached by URL so color and
    // tab switches both reuse loaded images.
    const { baseUrl } = viewImagesOf(area);
    loadViewImage(baseCacheRef.current, baseUrl, baseUrl)
      .then((img) => {
        if (cancelled) return;
        canvas.backgroundImage = img;
        canvas.requestRenderAll();
      })
      .catch(() => {
        if (!cancelled) setStatus({ tone: 'error', message: 'Could not load the template image.' });
      });

    // Overlay (fabric shading) is color-independent: same geometry for every color.
    const overlayUrl = area.overlayUrl ?? template.overlayUrl;
    if (overlayUrl) {
      // Blend follows the same area -> template fallback as the overlay asset. Set on
      // every activation: the cached template-level image is shared across areas
      // whose blends may differ.
      const blend = FABRIC_OVERLAY_BLEND[area.overlayBlend ?? template.overlayBlend];
      loadViewImage(overlayCacheRef.current, overlayUrl, overlayUrl)
        .then((img) => {
          if (cancelled) return;
          img.set({ globalCompositeOperation: blend });
          canvas.overlayImage = img;
          canvas.requestRenderAll();
        })
        .catch(() => {
          /* overlay is decorative; ignore */
        });
    } else {
      canvas.overlayImage = undefined;
      canvas.requestRenderAll();
    }

    return () => {
      cancelled = true;
    };
  }, [canvasReady, activeAreaKey, template, designedObjects, loadViewImage, viewImagesOf]);

  // A file dropped OUTSIDE the drop zone must never nuke the editor: the
  // browser's default is to NAVIGATE to the dropped image, replacing the app
  // (and the unsaved design) with the file. Intercept at the window level;
  // the stage's own drop handler still runs first and uploads the file.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  const handleStageDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropActive) setDropActive(true);
  };
  const handleStageDragLeave = (e: React.DragEvent) => {
    // Children fire dragleave too; only count actually exiting the stage.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropActive(false);
  };
  const handleStageDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleUpload(file);
  };

  const handleUpload = async (file: File) => {
    const canvas = canvasRef.current;
    const area = activeArea;
    if (!canvas || !area || busy !== null) return;
    // Reject obvious misfits before spending a request (and upload-throttle
    // budget) on them; the server still re-validates everything.
    if (!UPLOAD_MIME_TYPES.includes(file.type)) {
      setStatus({
        tone: 'error',
        message: `"${file.name}" is not a PNG or JPEG. Export the artwork as PNG and try again.`,
      });
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      setStatus({
        tone: 'error',
        message: `"${file.name}" is ${(file.size / (1024 * 1024)).toFixed(1)} MB; uploads are capped at 10 MB.`,
      });
      return;
    }
    setBusy('upload');
    setStatus({ tone: 'info', message: `Uploading ${file.name}...` });
    try {
      const asset = await uploadAsset(file);
      const img = (await FabricImage.fromURL(apiUrl(asset.url), {
        crossOrigin: 'anonymous',
      })) as DesignedObject & FabricImage;

      const naturalWidth = img.width ?? 100;
      const naturalHeight = img.height ?? 100;
      const scale = Math.min(
        (area.width * 0.7) / naturalWidth,
        (area.height * 0.7) / naturalHeight,
      );
      img.set({
        originX: 'center',
        originY: 'center',
        left: area.x + area.width / 2,
        top: area.y + area.height / 2,
        scaleX: scale,
        scaleY: scale,
      });
      applySelectionStyle(img);
      img.kind = 'image';
      img.assetId = asset.id;
      img.printAreaKey = area.key;
      canvas.add(img);
      canvas.setActiveObject(img);
      canvas.requestRenderAll();
      readSelection(img);
      refreshAreaCounts();
      markMutated();
      setStatus({
        tone: 'success',
        message: `${asset.originalFilename} added to ${area.name}. Drag, resize, and rotate it inside the print area.`,
      });
    } catch (error) {
      // The global rate limiter answers 429 with a developer-facing message;
      // translate it for the person clicking the button.
      const message =
        error instanceof ApiError
          ? error.status === 429
            ? 'Too many uploads in a row. Give it a minute, then try again.'
            : error.message
          : 'Upload failed.';
      setStatus({
        tone: 'error',
        message,
        details: error instanceof ApiError ? error.details : undefined,
      });
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /**
   * Swaps the selected image for a server-derived copy with the flat background
   * removed. Same pixel dimensions, so position/scale/rotation carry over exactly;
   * the original upload stays intact (delete + re-upload is the undo).
   */
  const handleRemoveBackground = async () => {
    const canvas = canvasRef.current;
    const active = canvas?.getActiveObject() as (DesignedObject & FabricImage) | undefined;
    if (!canvas || active?.kind !== 'image' || !active.assetId) return;
    setBusy('removebg');
    setStatus({ tone: 'info', message: 'Removing the background...' });
    try {
      const derived = await removeAssetBackground(active.assetId);
      const img = (await FabricImage.fromURL(apiUrl(derived.url), {
        crossOrigin: 'anonymous',
      })) as DesignedObject & FabricImage;
      img.set({
        originX: 'center',
        originY: 'center',
        left: active.left,
        top: active.top,
        scaleX: active.scaleX,
        scaleY: active.scaleY,
        angle: active.angle,
      });
      applySelectionStyle(img);
      img.kind = 'image';
      img.assetId = derived.id;
      img.printAreaKey = active.printAreaKey;
      if (active.pattern) {
        img.pattern = active.pattern;
        img.set({ lockRotation: true });
        img.setControlsVisibility({ mtr: false });
      }
      patternHooksRef.current.remove(active);
      canvas.remove(active);
      canvas.add(img);
      if (img.pattern) patternHooksRef.current.refresh(img);
      canvas.setActiveObject(img);
      canvas.requestRenderAll();
      readSelection(img);
      refreshAreaCounts();
      markMutated();
      setStatus({ tone: 'success', message: 'Background removed. The original upload is untouched.' });
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof ApiError ? error.message : 'Background removal failed.',
        details: error instanceof ApiError ? error.details : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  /**
   * The crop rect's position in SOURCE pixel space: the canvas offset between the
   * rect center and the image center, rotated into the image frame and divided by
   * the image scale. Works for rotated images because the rect always carries the
   * image's own angle.
   */
  const cropRectLocal = useCallback(() => {
    const rect = cropRectRef.current;
    const img = cropImageRef.current;
    if (!rect || !img) return null;
    const theta = (-(img.angle ?? 0) * Math.PI) / 180;
    const dx = (rect.left ?? 0) - (img.left ?? 0);
    const dy = (rect.top ?? 0) - (img.top ?? 0);
    const u = dx * Math.cos(theta) - dy * Math.sin(theta);
    const v = dx * Math.sin(theta) + dy * Math.cos(theta);
    const sx = img.scaleX ?? 1;
    const sy = img.scaleY ?? 1;
    const srcW = img.width ?? 1;
    const srcH = img.height ?? 1;
    const width = rect.getScaledWidth() / sx;
    const height = rect.getScaledHeight() / sy;
    return {
      srcW,
      srcH,
      left: u / sx + srcW / 2 - width / 2,
      top: v / sy + srcH / 2 - height / 2,
      width,
      height,
    };
  }, []);

  /** Clamps the crop rect inside the image (16px source-floor) and re-syncs its angle. */
  const clampCropRect = useCallback(() => {
    const rect = cropRectRef.current;
    const img = cropImageRef.current;
    const local = cropRectLocal();
    if (!rect || !img || !local) return;
    const width = Math.min(Math.max(local.width, 16), local.srcW);
    const height = Math.min(Math.max(local.height, 16), local.srcH);
    const left = Math.min(Math.max(local.left, 0), local.srcW - width);
    const top = Math.min(Math.max(local.top, 0), local.srcH - height);
    const sx = img.scaleX ?? 1;
    const sy = img.scaleY ?? 1;
    const theta = ((img.angle ?? 0) * Math.PI) / 180;
    const u = (left + width / 2 - local.srcW / 2) * sx;
    const v = (top + height / 2 - local.srcH / 2) * sy;
    rect.set({
      width: width * sx,
      height: height * sy,
      scaleX: 1,
      scaleY: 1,
      left: (img.left ?? 0) + u * Math.cos(theta) - v * Math.sin(theta),
      top: (img.top ?? 0) + u * Math.sin(theta) + v * Math.cos(theta),
      angle: img.angle ?? 0,
    });
    rect.setCoords();
  }, [cropRectLocal]);
  clampCropRectRef.current = clampCropRect;

  /** Enters crop mode for the selected image: full-frame rect, image locked. */
  const startCrop = useCallback(() => {
    const canvas = canvasRef.current;
    const active = canvas?.getActiveObject() as (DesignedObject & FabricImage) | undefined;
    if (!canvas || active?.kind !== 'image' || !active.assetId || croppingRef.current) return;
    const rect = new Rect({
      originX: 'center',
      originY: 'center',
      left: active.left,
      top: active.top,
      width: active.getScaledWidth(),
      height: active.getScaledHeight(),
      angle: active.angle ?? 0,
      fill: 'rgba(207, 63, 34, 0.10)',
      stroke: '#cf3f22',
      strokeDashArray: [6, 4],
      strokeWidth: 1.5,
      strokeUniform: true,
      lockRotation: true,
    }) as Rect & { cropTag?: boolean };
    rect.cropTag = true;
    rect.setControlsVisibility({ mtr: false });
    applySelectionStyle(rect);
    active.set({ selectable: false, evented: false });
    cropImageRef.current = active;
    cropRectRef.current = rect;
    canvas.add(rect);
    canvas.setActiveObject(rect);
    canvas.requestRenderAll();
    setCropping(true);
    setObjectTool(null);
  }, []);

  /** Leaves crop mode without touching the image. */
  const cancelCrop = useCallback(() => {
    const canvas = canvasRef.current;
    const rect = cropRectRef.current;
    const img = cropImageRef.current;
    cropRectRef.current = null;
    cropImageRef.current = null;
    setCropping(false);
    if (!canvas) return;
    if (rect) canvas.remove(rect);
    if (img) {
      img.set({ selectable: true, evented: true });
      canvas.setActiveObject(img);
    }
    canvas.requestRenderAll();
  }, []);
  cancelCropRef.current = cancelCrop;

  /**
   * Applies the crop: derives a new asset for the source-space rect and swaps the
   * object so the kept region stays exactly where it was on the garment.
   */
  const applyCrop = useCallback(async () => {
    const canvas = canvasRef.current;
    const img = cropImageRef.current;
    const local = cropRectLocal();
    if (!canvas || !img?.assetId || !local) return;

    const rect = {
      left: Math.max(0, Math.round(local.left)),
      top: Math.max(0, Math.round(local.top)),
      width: Math.round(local.width),
      height: Math.round(local.height),
    };
    rect.width = Math.min(rect.width, Math.round(local.srcW) - rect.left);
    rect.height = Math.min(rect.height, Math.round(local.srcH) - rect.top);
    if (rect.width < 16 || rect.height < 16) {
      setStatus({ tone: 'error', message: 'Crop area is too small; keep at least 16px per side.' });
      return;
    }
    // Full frame selected = nothing to crop.
    if (
      rect.left === 0 &&
      rect.top === 0 &&
      rect.width >= Math.round(local.srcW) &&
      rect.height >= Math.round(local.srcH)
    ) {
      cancelCrop();
      return;
    }

    setBusy('crop');
    setStatus({ tone: 'info', message: 'Cropping...' });
    try {
      const derived = await cropAsset(img.assetId, rect);
      const newImg = (await FabricImage.fromURL(apiUrl(derived.url), {
        crossOrigin: 'anonymous',
      })) as DesignedObject & FabricImage;
      const sx = img.scaleX ?? 1;
      const sy = img.scaleY ?? 1;
      const theta = ((img.angle ?? 0) * Math.PI) / 180;
      const u = (rect.left + rect.width / 2 - local.srcW / 2) * sx;
      const v = (rect.top + rect.height / 2 - local.srcH / 2) * sy;
      newImg.set({
        originX: 'center',
        originY: 'center',
        left: (img.left ?? 0) + u * Math.cos(theta) - v * Math.sin(theta),
        top: (img.top ?? 0) + u * Math.sin(theta) + v * Math.cos(theta),
        scaleX: sx,
        scaleY: sy,
        angle: img.angle ?? 0,
      });
      applySelectionStyle(newImg);
      newImg.kind = 'image';
      newImg.assetId = derived.id;
      newImg.printAreaKey = img.printAreaKey;
      if (img.pattern) {
        newImg.pattern = img.pattern;
        newImg.set({ lockRotation: true });
        newImg.setControlsVisibility({ mtr: false });
      }

      const cropRect = cropRectRef.current;
      cropRectRef.current = null;
      cropImageRef.current = null;
      setCropping(false);
      if (cropRect) canvas.remove(cropRect);
      patternHooksRef.current.remove(img);
      canvas.remove(img);
      canvas.add(newImg);
      if (newImg.pattern) patternHooksRef.current.refresh(newImg);
      canvas.setActiveObject(newImg);
      canvas.requestRenderAll();
      readSelection(newImg);
      refreshAreaCounts();
      markMutated();
      setStatus({ tone: 'success', message: 'Cropped. The original upload is untouched.' });
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof ApiError ? error.message : 'Crop failed.',
        details: error instanceof ApiError ? error.details : undefined,
      });
      cancelCrop();
    } finally {
      setBusy(null);
    }
  }, [cropRectLocal, cancelCrop, readSelection, refreshAreaCounts, markMutated]);

  /** Adds an editable text object centered in the active print area. */
  const handleAddText = async () => {
    const canvas = canvasRef.current;
    const area = activeArea;
    if (!canvas || !area) return;
    try {
      await ensureEditorFonts();
    } catch {
      setStatus({ tone: 'error', message: 'Fonts could not be loaded. Is the API running?' });
      return;
    }
    const itext = makeDesignedText('Your text', area.key, TEXT_DEFAULTS);
    itext.set({ left: area.x + area.width / 2, top: area.y + area.height / 2 });
    itext.setCoords();
    fitToPrintArea(itext);
    canvas.add(itext);
    canvas.setActiveObject(itext);
    canvas.requestRenderAll();
    readSelection(itext);
    refreshAreaCounts();
    markMutated();
    setStatus({
      tone: 'success',
      message: `Text added to ${area.name}. Type in the Wording field to change it.`,
    });
  };

  /**
   * Drops a starter template's lines onto the active side as editable text objects.
   * One history step (a single markMutated after all lines), positioned by the
   * template's area fractions and fit to the print area.
   */
  const applyTemplate = async (tpl: DesignTemplate) => {
    const canvas = canvasRef.current;
    const area = activeArea;
    if (!canvas || !area) return;
    try {
      await ensureEditorFonts();
    } catch {
      setStatus({ tone: 'error', message: 'Fonts could not be loaded. Is the API running?' });
      return;
    }
    if (canvasRef.current !== canvas) return;
    let last: DesignedText | null = null;
    for (const line of tpl.lines) {
      const fontSize = Math.min(
        Math.max(Math.round(line.sizeFrac * area.height), FONT_SIZE_MIN),
        FONT_SIZE_MAX,
      );
      const obj = makeDesignedText(line.text, area.key, {
        fontKey: line.fontKey,
        fontSize,
        color: line.fill,
        align: line.align ?? 'center',
        outline: line.outline,
        shadow: line.shadow,
        letterSpacing: line.letterSpacing,
      });
      obj.set({ left: area.x + area.width / 2, top: area.y + line.cy * area.height });
      obj.setCoords();
      fitToPrintArea(obj);
      canvas.add(obj);
      last = obj;
    }
    if (last) canvas.setActiveObject(last);
    canvas.requestRenderAll();
    readSelection(last);
    refreshAreaCounts();
    markMutated();
    setStatus({ tone: 'success', message: `Added "${tpl.name}". Tap any line to edit it.` });
  };

  /** Applies a styling change to the selected text object and re-fits it. */
  const updateActiveText = useCallback(
    (mutate: (t: DesignedText) => void) => {
      const canvas = canvasRef.current;
      const active = canvas?.getActiveObject() as DesignedObject | undefined;
      if (!canvas || active?.kind !== 'text') return;
      mutate(active as DesignedText);
      active.setCoords();
      clampTextScale(active);
      fitToPrintArea(active);
      canvas.requestRenderAll();
      readSelection(active);
      markMutated();
    },
    [clampTextScale, fitToPrintArea, readSelection, markMutated],
  );

  /** The contextual tool follows the selection; no selection, no tool panel. */
  useEffect(() => {
    if (!selection) setObjectTool(null);
  }, [selection]);

  /** Sync the wording inputs to the active text selection (arc vs normal). */
  useEffect(() => {
    const active = canvasRef.current?.getActiveObject() as DesignedObject | undefined;
    if (isArcText(active)) setArcWording(active.arcProps.text);
    else if (active?.kind === 'text') setTextWording((active as DesignedText).text ?? '');
  }, [selection]);

  /** Replaces the wording of the selected normal text from the panel input. */
  const applyTextWording = useCallback(() => {
    const next = textWording.replace(/\s+$/, '') || 'Your text';
    setTextWording(next); // keep the field in sync with the normalized canvas text
    updateActiveText((t) => t.set({ text: next }));
  }, [textWording, updateActiveText]);

  /** Applies a one-tap outline look (null = remove). Outline = Fabric stroke pair. */
  const applyOutlinePreset = useCallback(
    (outline: TextOutline | null) => {
      updateActiveText((t) =>
        outline
          ? t.set({
              stroke: outline.color,
              strokeWidth: outline.width,
              paintFirst: 'stroke',
              strokeLineJoin: 'round',
            })
          : t.set({ stroke: undefined, strokeWidth: 0 }),
      );
    },
    [updateActiveText],
  );

  /** Applies a full one-tap text "look" (font + color + outline + shadow + spacing). */
  const applyTextStylePreset = useCallback(
    (p: TextStylePreset) => {
      const def = fontDefinitionOf(p.fontKey) ?? FONT_WHITELIST[0];
      updateActiveText((t) => {
        t.fontKey = def.key;
        const effective = (t.fontSize ?? TEXT_DEFAULTS.fontSize) * (t.scaleY ?? 1);
        t.set({
          fontFamily: def.family,
          fill: p.fill,
          charSpacing: ((p.letterSpacing ?? 0) * 1000) / effective,
          ...(p.outline
            ? { stroke: p.outline.color, strokeWidth: p.outline.width, paintFirst: 'stroke' as const, strokeLineJoin: 'round' as const }
            : { stroke: undefined, strokeWidth: 0 }),
        });
        t.shadow = p.shadow
          ? new Shadow({ color: p.shadow.color, offsetX: p.shadow.offsetX, offsetY: p.shadow.offsetY, blur: 0 })
          : null;
      });
    },
    [updateActiveText],
  );

  /** Applies a one-tap shadow look (null = remove). Hard shadow, blur 0 per contract. */
  const applyShadowPreset = useCallback(
    (shadow: TextShadow | null) => {
      updateActiveText((t) => {
        t.shadow = shadow
          ? new Shadow({ color: shadow.color, offsetX: shadow.offsetX, offsetY: shadow.offsetY, blur: 0 })
          : null;
      });
    },
    [updateActiveText],
  );

  /**
   * Applies a geometry change to the selected object (any kind), then re-fits it
   * to its print area and refreshes the readout. The object-tools counterpart of
   * updateActiveText.
   */
  const updateActiveObject = useCallback(
    (mutate: (obj: DesignedObject) => void) => {
      const canvas = canvasRef.current;
      const active = canvas?.getActiveObject() as DesignedObject | undefined;
      if (!canvas || !active?.kind) return;
      mutate(active);
      active.setCoords();
      clampTextScale(active);
      fitToPrintArea(active);
      canvas.requestRenderAll();
      readSelection(active);
      markMutated();
    },
    [clampTextScale, fitToPrintArea, readSelection, markMutated],
  );

  /**
   * Sets the absolute rotation (degrees, normalized to [0, 360)). Designed objects
   * have a center origin, so the angle change pivots around the object center; the
   * follow-up fit shrinks the object if the rotated box no longer fits its area.
   */
  const setActiveAngle = useCallback(
    (angle: number) => {
      if (!Number.isFinite(angle)) return;
      updateActiveObject((obj) => obj.set({ angle: ((angle % 360) + 360) % 360 }));
    },
    [updateActiveObject],
  );

  /**
   * Aligns the selected object's axis-aligned bounding box against its OWN print
   * area (works for rotated objects too; the box is what clamping validates).
   */
  const alignActiveObject = useCallback(
    (action: AlignAction) =>
      updateActiveObject((obj) => {
        const area = areaOf(obj);
        if (!area) return;
        const box = obj.getBoundingRect();
        let dx = 0;
        let dy = 0;
        if (action === 'left') dx = area.x - box.left;
        if (action === 'center-h') dx = area.x + (area.width - box.width) / 2 - box.left;
        if (action === 'right') dx = area.x + area.width - (box.left + box.width);
        if (action === 'top') dy = area.y - box.top;
        if (action === 'center-v') dy = area.y + (area.height - box.height) / 2 - box.top;
        if (action === 'bottom') dy = area.y + area.height - (box.top + box.height);
        obj.set({ left: (obj.left ?? 0) + dx, top: (obj.top ?? 0) + dy });
      }),
    [updateActiveObject, areaOf],
  );

  /**
   * Applies a one-click placement preset to the selected logo: contain-fits the
   * image inside the preset's fraction of its print area and anchors its center.
   * Rotation resets to 0 so the result is predictable; patterned tiles are
   * excluded (their fill already covers the whole area).
   */
  const applyPlacementPreset = useCallback(
    (preset: PlacementPreset) =>
      updateActiveObject((obj) => {
        const area = areaOf(obj);
        if (!area || obj.kind !== 'image' || obj.pattern) return;
        const spec = PLACEMENT_SPECS[preset];
        const naturalWidth = obj.width ?? 1;
        const naturalHeight = obj.height ?? 1;
        const scale = Math.min(
          (area.width * spec.w) / naturalWidth,
          (area.height * spec.h) / naturalHeight,
        );
        obj.set({
          angle: 0,
          scaleX: scale,
          scaleY: scale,
          left: area.x + area.width * spec.cx,
          top: area.y + area.height * spec.cy,
        });
      }),
    [updateActiveObject, areaOf],
  );

  /**
   * Enables/disables the tiling fill on the selected image (v1.9). Patterned tiles
   * are axis-aligned: rotation resets to 0 and the rotate handle is hidden; the
   * server rejects rotated patterns.
   */
  const setImagePattern = useCallback(
    (pattern: ImagePattern | null) => {
      const canvas = canvasRef.current;
      const active = canvas?.getActiveObject() as DesignedObject | undefined;
      if (!canvas || active?.kind !== 'image') return;
      if (pattern) {
        active.pattern = pattern;
        active.set({ angle: 0, lockRotation: true });
        active.setControlsVisibility({ mtr: false });
      } else {
        delete active.pattern;
        active.set({ lockRotation: false });
        active.setControlsVisibility({ mtr: true });
      }
      active.setCoords();
      fitToPrintArea(active);
      refreshPatternPreview(active);
      canvas.requestRenderAll();
      readSelection(active);
      markMutated();
    },
    [fitToPrintArea, refreshPatternPreview, readSelection, markMutated],
  );

  /**
   * Rebuilds the selected arced-text image from changed props (font, color, size,
   * align, spacing, or arc value). Preserves center/angle and re-fits to the area.
   */
  const setArcProps = useCallback(
    (partial: Partial<ArcTextProps>) => {
      const canvas = canvasRef.current;
      const active = canvas?.getActiveObject() as DesignedObject | undefined;
      if (!canvas || !isArcText(active)) return;
      const replacement = makeArcText(
        { ...active.arcProps, ...partial },
        active.printAreaKey ?? activeAreaKeyRef.current,
      );
      if (!replacement) return;
      replacement.set({ left: active.left, top: active.top, angle: active.angle });
      canvas.remove(active);
      replacement.setCoords();
      fitToPrintArea(replacement);
      canvas.add(replacement);
      canvas.setActiveObject(replacement);
      canvas.requestRenderAll();
      readSelection(replacement);
      markMutated();
    },
    [makeArcText, fitToPrintArea, readSelection, markMutated],
  );

  /**
   * Toggles/sets the arc on the selected text. null straightens it back to an
   * IText; a number bends a straight IText (or re-bends an existing arc). Arc text
   * is LTR single-line with no wrap/outline/shadow, so the conversions strip those.
   */
  const setArc = useCallback(
    (arc: number | null) => {
      const canvas = canvasRef.current;
      const active = canvas?.getActiveObject() as DesignedObject | undefined;
      if (!canvas || active?.kind !== 'text') return;

      if (isArcText(active)) {
        if (arc === null) {
          // Arc -> straight IText, baking the display scale into the props.
          const scale = active.scaleY ?? 1;
          const p = active.arcProps;
          const itext = makeDesignedText(p.text, active.printAreaKey ?? activeAreaKeyRef.current, {
            fontKey: p.fontKey,
            fontSize: Math.min(Math.max(p.fontSize * scale, FONT_SIZE_MIN), FONT_SIZE_MAX),
            color: p.color,
            align: p.align,
            direction: 'auto',
            letterSpacing: p.letterSpacing * scale || undefined,
          });
          itext.set({ left: active.left, top: active.top, angle: active.angle });
          canvas.remove(active);
          itext.setCoords();
          fitToPrintArea(itext);
          canvas.add(itext);
          canvas.setActiveObject(itext);
          canvas.requestRenderAll();
          readSelection(itext);
          markMutated();
        } else {
          setArcProps({ arc });
        }
        return;
      }

      if (arc === null) return; // already straight
      // Straight IText -> arc image. Wrap boxes can't arc (guarded in the UI).
      const t = active as DesignedText;
      if (t instanceof Textbox) return;
      const scale = t.scaleY ?? 1;
      const props: ArcTextProps = {
        text: (t.text ?? 'Your text').replace(/\n+/g, ' '),
        fontKey: t.fontKey ?? TEXT_DEFAULTS.fontKey,
        fontSize: Math.min(Math.max((t.fontSize ?? TEXT_DEFAULTS.fontSize) * scale, FONT_SIZE_MIN), FONT_SIZE_MAX),
        color: typeof t.fill === 'string' ? t.fill : TEXT_DEFAULTS.color,
        align: (t.textAlign as TextAlign) ?? TEXT_DEFAULTS.align,
        letterSpacing: ((t.charSpacing ?? 0) / 1000) * (t.fontSize ?? TEXT_DEFAULTS.fontSize) * scale,
        arc,
      };
      const replacement = makeArcText(props, t.printAreaKey ?? activeAreaKeyRef.current);
      if (!replacement) return;
      replacement.set({ left: t.left, top: t.top, angle: t.angle });
      canvas.remove(t);
      replacement.setCoords();
      fitToPrintArea(replacement);
      canvas.add(replacement);
      canvas.setActiveObject(replacement);
      canvas.requestRenderAll();
      readSelection(replacement);
      markMutated();
    },
    [makeArcText, makeDesignedText, fitToPrintArea, readSelection, markMutated, setArcProps],
  );

  /** Sets the contract direction and re-resolves Fabric's rendered direction. */
  const setTextDirection = useCallback(
    (direction: TextDirection) =>
      updateActiveText((t) => {
        t.textDirection = direction;
        t.set({ direction: resolveTextDirection(t.text ?? '', direction) });
      }),
    [updateActiveText],
  );

  /** Sets text size from either the slider or the number; one path for both. */
  const applyFontSize = useCallback(
    (raw: number) => {
      if (!Number.isFinite(raw)) return;
      const clamped = Math.min(Math.max(raw, FONT_SIZE_MIN), FONT_SIZE_MAX);
      const active = canvasRef.current?.getActiveObject() as DesignedObject | undefined;
      if (isArcText(active)) {
        setArcProps({ fontSize: clamped });
        return;
      }
      // Reset any interactive scale so the chosen size IS the size.
      updateActiveText((t) => t.set({ fontSize: clamped, scaleX: 1, scaleY: 1 }));
    },
    [setArcProps, updateActiveText],
  );

  /** Sets letter spacing (canvas px) from either the slider or the number. */
  const applyLetterSpacing = useCallback(
    (raw: number) => {
      if (!Number.isFinite(raw)) return;
      const clamped = Math.min(Math.max(raw, LETTER_SPACING_MIN), LETTER_SPACING_MAX);
      const active = canvasRef.current?.getActiveObject() as DesignedObject | undefined;
      if (isArcText(active)) {
        setArcProps({ letterSpacing: clamped });
        return;
      }
      updateActiveText((t) => {
        // Target px at the current effective size -> em-based charSpacing.
        const effective = (t.fontSize ?? TEXT_DEFAULTS.fontSize) * (t.scaleY ?? 1);
        t.set({ charSpacing: (clamped * 1000) / effective });
      });
    },
    [setArcProps, updateActiveText],
  );

  /**
   * Swaps the selected text between IText (plain) and Textbox (wrap-in-box),
   * preserving text, font, size, color, align, direction, and center position.
   * The current interactive scale is baked into the font size first so the
   * replacement starts clean; the initial wrap width is the current measured
   * width. Turning wrap off simply dissolves the soft wraps (raw text keeps
   * only explicit breaks), no data loss in either direction.
   */
  const setTextWrap = useCallback(
    (wrap: boolean) => {
      const canvas = canvasRef.current;
      const active = canvas?.getActiveObject() as DesignedObject | undefined;
      if (!canvas || active?.kind !== 'text') return;
      const t = active as DesignedText;
      if ((t instanceof Textbox) === wrap) return;

      const bakedSize = Math.min(
        Math.max((t.fontSize ?? TEXT_DEFAULTS.fontSize) * (t.scaleY ?? 1), FONT_SIZE_MIN),
        FONT_SIZE_MAX,
      );
      const replacement = makeDesignedText(t.text ?? '', t.printAreaKey ?? activeAreaKeyRef.current, {
        fontKey: t.fontKey ?? TEXT_DEFAULTS.fontKey,
        fontSize: bakedSize,
        color: typeof t.fill === 'string' ? (t.fill as string) : TEXT_DEFAULTS.color,
        align: (t.textAlign as TextAlign) ?? TEXT_DEFAULTS.align,
        direction: t.textDirection ?? 'auto',
        wrap,
        width: wrap ? t.getScaledWidth() : undefined,
        // Carry the v1.8 effects across the IText <-> Textbox swap.
        outline:
          typeof t.stroke === 'string' && (t.strokeWidth ?? 0) > 0
            ? { color: t.stroke, width: t.strokeWidth ?? 1 }
            : undefined,
        shadow:
          t.shadow && typeof t.shadow === 'object'
            ? {
                color: typeof t.shadow.color === 'string' ? t.shadow.color : '#000000',
                offsetX: t.shadow.offsetX ?? 0,
                offsetY: t.shadow.offsetY ?? 0,
              }
            : undefined,
        letterSpacing:
          ((t.charSpacing ?? 0) / 1000) * bakedSize || undefined,
      });
      replacement.set({ left: t.left, top: t.top, angle: t.angle });
      canvas.remove(t);
      replacement.setCoords();
      fitToPrintArea(replacement);
      canvas.add(replacement);
      canvas.setActiveObject(replacement);
      canvas.requestRenderAll();
      readSelection(replacement);
      refreshAreaCounts();
      markMutated();
    },
    [makeDesignedText, fitToPrintArea, readSelection, refreshAreaCounts, markMutated],
  );

  /**
   * Serializes ALL areas (visible and hidden) from the one canvas into v2 placements.
   * Normalized fields only; never raw Fabric JSON. Areas with no objects are omitted.
   */
  const collectPlacements = useCallback((): DesignPlacement[] => {
    const byArea = new Map<string, DesignObject[]>();
    for (const obj of designedObjects()) {
      if (!obj.printAreaKey) continue;

      let serialized: DesignObject | null = null;
      if (isArcText(obj)) {
        // Arced text: a tagged image; emit a text object with arc. Scale bakes
        // into fontSize/letterSpacing, the box is the displayed raster box.
        const scale = obj.scaleY ?? 1;
        const p = obj.arcProps;
        serialized = {
          type: 'text',
          text: p.text,
          fontFamily: p.fontKey,
          fontSize: Math.min(Math.max(p.fontSize * scale, FONT_SIZE_MIN), FONT_SIZE_MAX),
          color: p.color,
          align: p.align,
          direction: 'ltr',
          wrapMode: 'none',
          arc: p.arc,
          ...(p.letterSpacing
            ? {
                letterSpacing: Math.min(
                  Math.max(p.letterSpacing * scale, LETTER_SPACING_MIN),
                  LETTER_SPACING_MAX,
                ),
              }
            : {}),
          x: obj.left ?? 0,
          y: obj.top ?? 0,
          width: obj.getScaledWidth(),
          height: obj.getScaledHeight(),
          rotation: (obj.angle ?? 0) % 360,
        };
        const list = byArea.get(obj.printAreaKey) ?? [];
        list.push(serialized);
        byArea.set(obj.printAreaKey, list);
        continue;
      }
      if (obj.kind === 'text') {
        const t = obj as DesignedText;
        const isBox = t instanceof Textbox;
        const scale = t.scaleY ?? 1;
        // Effects bake the interactive scale like fontSize does, then clamp to the
        // contract bounds so a corner-scaled object can never serialize out of range.
        const outline =
          typeof t.stroke === 'string' && (t.strokeWidth ?? 0) > 0
            ? {
                color: t.stroke,
                width: Math.min(
                  Math.max((t.strokeWidth ?? 1) * scale, OUTLINE_WIDTH_MIN),
                  OUTLINE_WIDTH_MAX,
                ),
              }
            : undefined;
        const clampOffset = (v: number) =>
          Math.min(Math.max(v * scale, -SHADOW_OFFSET_MAX), SHADOW_OFFSET_MAX);
        const shadowOffsetX = clampOffset(t.shadow?.offsetX ?? 0);
        const shadowOffsetY = clampOffset(t.shadow?.offsetY ?? 0);
        // A both-zero offset is an invisible shadow; the contract rejects it, so
        // it simply serializes as "no shadow".
        const shadow =
          t.shadow && typeof t.shadow === 'object' && (shadowOffsetX !== 0 || shadowOffsetY !== 0)
            ? {
                color: typeof t.shadow.color === 'string' ? t.shadow.color : '#000000',
                offsetX: shadowOffsetX,
                offsetY: shadowOffsetY,
              }
            : undefined;
        // em-based charSpacing -> contract px at the baked size; 0 = field omitted.
        const letterSpacing = Math.min(
          Math.max(
            ((t.charSpacing ?? 0) / 1000) * (t.fontSize ?? TEXT_DEFAULTS.fontSize) * scale,
            LETTER_SPACING_MIN,
          ),
          LETTER_SPACING_MAX,
        );
        serialized = {
          type: 'text',
          text: (t.text ?? '').replace(/\r\n?/g, '\n'),
          fontFamily: t.fontKey ?? TEXT_DEFAULTS.fontKey,
          // Uniform corner scaling bakes into the font size; the object never
          // persists a scale factor. For a Textbox the same bake applies to the
          // wrap width via getScaledWidth() below.
          fontSize: (t.fontSize ?? TEXT_DEFAULTS.fontSize) * (t.scaleY ?? 1),
          color: typeof t.fill === 'string' ? t.fill : TEXT_DEFAULTS.color,
          align: (t.textAlign as TextAlign) ?? TEXT_DEFAULTS.align,
          direction: t.textDirection ?? 'auto',
          wrapMode: isBox ? 'box' : 'none',
          // The exact visual lines Fabric produced (soft wraps + explicit breaks
          // flattened); the server renders these verbatim and verifies they
          // reconcile with the raw text. Regenerated on every save, never edited.
          ...(isBox ? { wrappedLines: [...t.textLines] } : {}),
          ...(outline ? { outline } : {}),
          ...(shadow ? { shadow } : {}),
          ...(letterSpacing !== 0 ? { letterSpacing } : {}),
          x: t.left ?? 0,
          y: t.top ?? 0,
          width: t.getScaledWidth(),
          height: t.getScaledHeight(),
          rotation: (t.angle ?? 0) % 360,
        };
      } else if (obj.assetId) {
        serialized = {
          type: 'image',
          assetId: obj.assetId,
          ...(obj.pattern ? { pattern: obj.pattern } : {}),
          x: obj.left ?? 0,
          y: obj.top ?? 0,
          width: obj.getScaledWidth(),
          height: obj.getScaledHeight(),
          rotation: (obj.angle ?? 0) % 360,
        };
      }
      if (!serialized) continue;

      const list = byArea.get(obj.printAreaKey) ?? [];
      list.push(serialized);
      byArea.set(obj.printAreaKey, list);
    }
    // Stable order: template area order, not canvas stacking order.
    return template.printAreas
      .filter((a) => byArea.has(a.key))
      .map((a) => ({ printAreaKey: a.key, objects: byArea.get(a.key)! }));
  }, [designedObjects, template.printAreas]);

  // ---- undo/redo engine (wires the late-bound refs declared above) ----

  const serializeState = useCallback(() => JSON.stringify(collectPlacements()), [collectPlacements]);
  serializeStateRef.current = serializeState;

  /** Pushes the pre-mutation state onto the undo stack; called via markMutated. */
  const recordHistory = useCallback(() => {
    if (restoringRef.current) return;
    const next = serializeState();
    if (next === lastSnapshotRef.current) return; // no geometric/content change
    undoStackRef.current.push(lastSnapshotRef.current);
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    redoStackRef.current = [];
    lastSnapshotRef.current = next;
    setHistoryVersion((v) => v + 1);
  }, [serializeState]);
  markMutatedRef.current = () => {
    setDirty(true);
    recordHistory();
  };

  /** Clears the design objects and rebuilds them from a placements snapshot. */
  const applySnapshot = useCallback(
    async (snapshot: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      restoringRef.current = true;
      try {
        const placements = JSON.parse(snapshot) as DesignPlacement[];
        canvas.discardActiveObject();
        for (const obj of designedObjects()) canvas.remove(obj);
        // Pattern previews belong to the removed objects; drop them all.
        for (const o of [...canvas.getObjects()]) {
          if ((o as PatternPreviewRect).patternPreview) canvas.remove(o);
        }
        setSelection(null);
        const pending: Promise<void>[] = [];
        for (const placement of placements) {
          for (const saved of placement.objects) {
            pending.push(
              saved.type === 'text'
                ? restoreTextObject(saved, placement.printAreaKey)
                : restoreImageObject(saved, placement.printAreaKey),
            );
          }
        }
        await Promise.allSettled(pending);
        canvas.requestRenderAll();
        refreshAreaCounts();
      } finally {
        restoringRef.current = false;
      }
    },
    [designedObjects, restoreImageObject, restoreTextObject, refreshAreaCounts],
  );

  const undo = useCallback(async () => {
    if (croppingRef.current) return; // resolve the crop first
    if (busyRef.current || restoringRef.current || undoStackRef.current.length === 0) return;
    const previous = undoStackRef.current.pop()!;
    redoStackRef.current.push(lastSnapshotRef.current);
    lastSnapshotRef.current = previous;
    setHistoryVersion((v) => v + 1);
    await applySnapshot(previous);
    setDirty(true); // differs from what the server has until the next save
  }, [applySnapshot]);

  const redo = useCallback(async () => {
    if (croppingRef.current) return; // resolve the crop first
    if (busyRef.current || restoringRef.current || redoStackRef.current.length === 0) return;
    const next = redoStackRef.current.pop()!;
    undoStackRef.current.push(lastSnapshotRef.current);
    lastSnapshotRef.current = next;
    setHistoryVersion((v) => v + 1);
    await applySnapshot(next);
    setDirty(true);
  }, [applySnapshot]);
  undoRedoRef.current = { undo: () => void undo(), redo: () => void redo() };

  const areaName = useCallback(
    (key: string) => template.printAreas.find((a) => a.key === key)?.name ?? key,
    [template.printAreas],
  );

  /**
   * Advisory list of poor-quality objects across all areas, shown with the save
   * status. Never blocks the save; the server recomputes its own warnings anyway.
   */
  const collectPoorNotes = useCallback((): string[] => {
    const notes: string[] = [];
    const counters = new Map<string, number>();
    for (const obj of designedObjects()) {
      if (!obj.printAreaKey) continue;
      const n = (counters.get(obj.printAreaKey) ?? 0) + 1;
      counters.set(obj.printAreaKey, n);
      if (obj.kind !== 'image') continue; // text is vector-like, DPI does not apply
      const quality = qualityOf(obj);
      if (quality?.level === 'poor') {
        notes.push(
          `${areaName(obj.printAreaKey)}, object ${n}: ~${Math.round(quality.effectiveDpi)} DPI, will likely print blurry`,
        );
      }
    }
    return notes;
  }, [designedObjects, qualityOf, areaName]);

  /** Swaps the garment color; a saved design needs a re-save (and re-render) to keep it. */
  const handleColorChange = (key: string) => {
    if (key === colorKey) return;
    setColorKey(key);
    if (designId) setDirty(true);
  };

  /** Picks the garment size; order-time metadata, a saved design needs a re-save. */
  const handleSizeChange = (next: GarmentSize | '') => {
    if (next === size) return;
    setSize(next);
    if (designId) setDirty(true);
  };

  /**
   * Opens the placement overview. The tiles snapshot the canvas state, so any
   * in-flight interaction is settled first: a crop is abandoned (same rule as
   * switching sides) and the selection chrome is dropped.
   */
  const openOverview = () => {
    cancelCropRef.current();
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.discardActiveObject();
      canvas.requestRenderAll();
    }
    setSelection(null);
    setOverviewOpen(true);
  };

  // Escape closes the overview (listener exists only while it is open).
  useEffect(() => {
    if (!overviewOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverviewOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overviewOpen]);

  const handleSave = async () => {
    const placements = collectPlacements();
    if (placements.length === 0) {
      setStatus({ tone: 'error', message: 'Add at least one artwork or text before saving.' });
      return;
    }

    // Clear reason before the round-trip: the server would reject the line count
    // anyway, this just says why up front (mirrors the inline panel warning).
    const overflowing = designedObjects().filter(
      (obj) => obj.kind === 'text' && visualLineCountOf(obj as DesignedText) > TEXT_MAX_LINES,
    );
    if (overflowing.length > 0) {
      setStatus({
        tone: 'error',
        message: `Text wraps to more than ${TEXT_MAX_LINES} lines. Shorten it or widen its box before saving.`,
      });
      return;
    }

    const validation = validateDesignPlacements(placements, template.printAreas);
    if (!validation.valid) {
      setStatus({
        tone: 'error',
        message: 'Keep every object inside its print area.',
        details: validation.errors.map((e) => {
          const key = placements[e.placementIndex]?.printAreaKey ?? '?';
          const objectPart = e.objectIndex !== undefined ? `, object ${e.objectIndex + 1}` : '';
          return `${areaName(key)}${objectPart}: ${e.message}`;
        }),
      });
      return;
    }

    // Advisory only: low-resolution artwork is reported with the result, never blocked.
    const poorNotes = collectPoorNotes();

    setBusy('save');
    setStatus({ tone: 'info', message: designId ? 'Updating design...' : 'Saving design...' });
    try {
      const payload = {
        templateId: template.id,
        // Only sent when the template has colors; the server validates the key.
        ...(colorKey ? { colorKey } : {}),
        // Order-time size, sent only when picked.
        ...(size ? { size } : {}),
        placements,
      };
      if (designId) {
        await updateDesign(designId, payload);
        setDirty(false);
        setStatus({
          tone: 'success',
          message: 'Design updated. The old previews are stale; render the mockups again.',
          details: poorNotes.length > 0 ? poorNotes : undefined,
        });
      } else {
        const design = await saveDesign(payload);
        setDesignId(design.id);
        setDirty(false);
        setStatus({
          tone: 'success',
          message: 'Design saved. Generate the mockups when ready.',
          details: poorNotes.length > 0 ? poorNotes : undefined,
        });
      }
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof ApiError ? error.message : 'Saving failed.',
        details: error instanceof ApiError ? error.details : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const handleRender = async () => {
    if (!designId || dirty) return;
    setBusy('render');
    setStatus({ tone: 'info', message: 'Rendering mockups on the server...' });
    try {
      const result = await renderDesign(designId);
      router.push(`/designs/${result.designId}`);
    } catch (error) {
      setBusy(null);
      setStatus({
        tone: 'error',
        message: error instanceof ApiError ? error.message : 'Rendering failed.',
        details: error instanceof ApiError ? error.details : undefined,
      });
    }
  };

  const statusClass = useMemo(() => {
    if (status.tone === 'error') return 'status status--error';
    if (status.tone === 'success') return 'status status--success';
    return 'status';
  }, [status.tone]);

  /** Selects a layer row's object on the canvas (fires Fabric's selection events). */
  const selectLayer = useCallback(
    (obj: DesignedObject) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.setActiveObject(obj);
      canvas.requestRenderAll();
      readSelection(obj);
    },
    [readSelection],
  );

  if (template.printAreas.length === 0) {
    return (
      <div className="studio-notice">
        <div className="notice">
          <strong>This template has no active print area.</strong>
          <p>Seed data is incomplete; re-run the seed.</p>
        </div>
      </div>
    );
  }

  const totalObjects = Object.values(areaCounts).reduce((sum, n) => sum + n, 0);
  const placedAreas = Object.keys(areaCounts).length;
  const zoomPercent = Math.round(zoom * viewZoom * 100);
  /** Rotation normalized to [0, 359] for the Transform tool inputs. */
  const selectionAngle = selection ? ((selection.rotation % 360) + 360) % 360 : 0;
  const layerObjects = designedObjects().filter((o) => o.printAreaKey === activeAreaKey);
  const activeCanvasObject = canvasRef.current?.getActiveObject() ?? null;

  const saveLabel = busy === 'save'
    ? 'Saving...'
    : designId
      ? dirty
        ? 'Save changes'
        : 'Saved'
      : 'Save design';

  /* Selection details shown under the uploads/text/layers panels. Rendered once
     (only the active tool's panel mounts it), so the testids stay unique. */
  const selectionSection = selection ? (
    <div className="studio__panel-section">
      <p className="studio__panel-title">Selected {selection.kind}</p>
      <div className="readout" data-testid="selection-readout">
        <span>
          center <b>{selection.x}, {selection.y}</b>
        </span>
        <span>
          size <b>{selection.width} x {selection.height}</b>
        </span>
        <span>
          angle <b>{selection.rotation}deg</b>
        </span>
        {selection.quality && (
          <span
            className={`readout__quality readout__quality--${selection.quality.level}`}
            data-testid="dpi-readout"
            data-level={selection.quality.level}
          >
            print <b>~{selection.quality.effectiveDpi} DPI</b>,{' '}
            {QUALITY_COPY[selection.quality.level]}
          </span>
        )}
        {selection.physical && (
          <span data-testid="physical-size-readout">
            prints at <b>{selection.physical.widthIn} x {selection.physical.heightIn} in</b>
          </span>
        )}
      </div>
      {selection.text && (
        <div className="text-panel" data-testid="text-panel">
          <p className="text-panel__hint">
            {selection.text.arc !== null
              ? 'Edit the curved wording in the field below.'
              : 'Type below. The design updates as you type. Enter starts a new line.'}
          </p>
          {selection.text.arc !== null ? (
            <label className="text-panel__field">
              Wording
              <input
                type="text"
                data-testid="arc-text-input"
                value={arcWording}
                onChange={(e) => setArcWording(e.target.value)}
                onBlur={() => {
                  const next = arcWording.trim() || 'Your text';
                  setArcProps({ text: next });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />
            </label>
          ) : (
            <label className="text-panel__field">
              Wording
              <textarea
                rows={3}
                data-testid="text-wording-input"
                value={textWording}
                onChange={(e) => {
                  // Live WYSIWYG: the canvas mirrors every keystroke, including
                  // spaces and newlines (Enter), with no apply/preview/blur step.
                  // Empty is allowed mid-edit (zero-width box); blur normalizes it
                  // back to the 'Your text' fallback.
                  const raw = e.target.value;
                  setTextWording(raw);
                  updateActiveText((t) => t.set({ text: raw }));
                }}
                onBlur={applyTextWording}
              />
            </label>
          )}
          {selection.text.arc === null && (
            <div className="text-panel__field" role="group" aria-label="Text styles">
              <span className="text-panel__label">Styles</span>
              <p className="text-panel__sub">One tap for a ready-made look.</p>
              <div className="fx-row fx-row--styles">
                {TEXT_STYLE_PRESETS.map((p) => {
                  const def = fontDefinitionOf(p.fontKey);
                  return (
                    <button
                      key={p.key}
                      type="button"
                      data-testid={`text-style-${p.key}`}
                      className="fx-chip"
                      title={p.label}
                      onClick={() => applyTextStylePreset(p)}
                    >
                      <span
                        className="fx-chip__preview"
                        style={{
                          fontFamily: def?.family,
                          color: p.fill,
                          ...(p.outline
                            ? { WebkitTextStroke: `${(p.outline.width * 0.4).toFixed(1)}px ${p.outline.color}` }
                            : {}),
                          ...(p.shadow
                            ? { textShadow: `${(p.shadow.offsetX * 0.5).toFixed(1)}px ${(p.shadow.offsetY * 0.5).toFixed(1)}px 0 ${p.shadow.color}` }
                            : {}),
                        }}
                      >
                        Aa
                      </span>
                      <span className="fx-chip__label">{p.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="text-panel__field">
            Font
            <div
              className="font-picker"
              data-testid="text-font-select"
              role="radiogroup"
              aria-label="Font"
            >
              {FONT_CATEGORY_ORDER.map((cat) => {
                const fonts = FONT_WHITELIST.filter((f) => f.category === cat);
                if (fonts.length === 0) return null;
                // Preview each font with the user's own first line so they see their
                // real text in the face; fall back to the family name when empty.
                const sample = (textWording.split('\n')[0] ?? '').trim().slice(0, 16);
                return (
                  <div key={cat} className="font-picker__group">
                    <p className="font-picker__cat">{cat}</p>
                    {fonts.map((font) => {
                      const active = selection.text!.fontKey === font.key;
                      return (
                        <button
                          key={font.key}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          data-testid={`font-pick-${font.key}`}
                          className={`font-picker__item${active ? ' font-picker__item--active' : ''}`}
                          onClick={() => {
                            if (selection.text!.arc !== null) {
                              setArcProps({ fontKey: font.key });
                              return;
                            }
                            updateActiveText((t) => {
                              t.fontKey = font.key;
                              t.set({ fontFamily: font.family });
                            });
                          }}
                        >
                          <span className="font-picker__sample" style={{ fontFamily: font.family }}>
                            {sample || font.family}
                          </span>
                          <span className="font-picker__name">{font.family}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="text-panel__field">
            <span className="text-panel__label">Color</span>
            {recentColors.length > 0 && (
              <div className="text-panel__swatches text-panel__swatches--recent" aria-label="Recent colors">
                {recentColors.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="text-panel__swatch"
                    data-testid={`text-recent-${c.slice(1)}`}
                    style={{ background: c }}
                    aria-label={`Recent color ${c}`}
                    onClick={() => {
                      pushRecentColor(c);
                      selection.text!.arc !== null
                        ? setArcProps({ color: c })
                        : updateActiveText((t) => t.set({ fill: c }));
                    }}
                  />
                ))}
              </div>
            )}
            <div className="text-panel__swatches">
              {TEXT_SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  className="text-panel__swatch"
                  data-testid={`text-swatch-${swatch.slice(1)}`}
                  style={{ background: swatch }}
                  aria-label={`Text color ${swatch}`}
                  onClick={() => {
                    pushRecentColor(swatch);
                    selection.text!.arc !== null
                      ? setArcProps({ color: swatch })
                      : updateActiveText((t) => t.set({ fill: swatch }));
                  }}
                />
              ))}
              <input
                type="color"
                data-testid="text-color-input"
                value={selection.text.color}
                onChange={(e) => {
                  const color = e.target.value; // native input always emits #rrggbb
                  pushRecentColor(color);
                  if (selection.text!.arc !== null) {
                    setArcProps({ color });
                    return;
                  }
                  updateActiveText((t) => t.set({ fill: color }));
                }}
              />
            </div>
          </div>
          <div className="text-panel__field" role="group" aria-label="Text size">
            <span className="text-panel__label">Size</span>
            <div className="fx-slider">
              <span className="fx-slider__hint" aria-hidden>A</span>
              <input
                type="range"
                className="fx-slider__range"
                data-testid="text-size-range"
                min={FONT_SIZE_MIN}
                max={200}
                value={Math.min(Math.round(selection.text.fontSize), 200)}
                aria-label="Text size"
                onChange={(e) => applyFontSize(Number(e.target.value))}
              />
              <span className="fx-slider__hint fx-slider__hint--big" aria-hidden>A</span>
              <input
                type="number"
                className="fx-slider__num"
                data-testid="text-size-input"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                value={Math.round(selection.text.fontSize)}
                aria-label="Text size value"
                onChange={(e) => applyFontSize(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="text-panel__field" role="group" aria-label="Letter spacing">
            <span className="text-panel__label">Spacing</span>
            <div className="fx-slider">
              <span className="fx-slider__hint" aria-hidden>AA</span>
              <input
                type="range"
                className="fx-slider__range"
                data-testid="text-letter-spacing-range"
                min={LETTER_SPACING_MIN}
                max={LETTER_SPACING_MAX}
                value={Math.round(selection.text.letterSpacing)}
                aria-label="Letter spacing"
                onChange={(e) => applyLetterSpacing(Number(e.target.value))}
              />
              <span className="fx-slider__hint" aria-hidden>A&nbsp;A</span>
              <input
                type="number"
                className="fx-slider__num"
                data-testid="text-letter-spacing-input"
                min={LETTER_SPACING_MIN}
                max={LETTER_SPACING_MAX}
                value={Math.round(selection.text.letterSpacing)}
                aria-label="Letter spacing value"
                onChange={(e) => applyLetterSpacing(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="text-panel__field" role="group" aria-label="Text alignment">
            <span className="text-panel__label">Align</span>
            <div className="fx-icons">
              {ALIGN_CHOICES.map((choice) => (
                <button
                  key={choice.key}
                  type="button"
                  data-testid={`text-align-${choice.key}`}
                  aria-pressed={selection.text?.align === choice.key}
                  aria-label={choice.aria}
                  title={choice.aria}
                  className={selection.text?.align === choice.key ? 'fx-icon fx-icon--active' : 'fx-icon'}
                  onClick={() =>
                    selection.text!.arc !== null
                      ? setArcProps({ align: choice.key })
                      : updateActiveText((t) => t.set({ textAlign: choice.key }))
                  }
                >
                  {choice.icon}
                </button>
              ))}
            </div>
          </div>
          <div className="text-panel__field" role="group" aria-label="Text curve">
            <span className="text-panel__label">Curve</span>
            <div className="fx-icons">
              <button
                type="button"
                data-testid="text-arc-none"
                aria-pressed={selection.text.arc === null}
                aria-label="Straight text"
                title="Straight"
                className={selection.text.arc === null ? 'fx-icon fx-icon--active' : 'fx-icon'}
                onClick={() => setArc(null)}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                  <path d="M5 9h14M5 15h9" />
                </svg>
              </button>
              <button
                type="button"
                data-testid="text-arc-toggle"
                aria-pressed={selection.text.arc !== null}
                aria-label="Curved text"
                title={selection.text.wrap ? 'Turn off Wrap (Advanced) to curve text' : 'Curved'}
                disabled={selection.text.wrap}
                className={selection.text.arc !== null ? 'fx-icon fx-icon--active' : 'fx-icon'}
                onClick={() => setArc(selection.text!.arc ?? 90)}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 15a8 8 0 0 1 16 0" />
                </svg>
              </button>
            </div>
          </div>
          {selection.text.arc !== null && (
            <div className="text-panel__field">
              Bend
              <input
                type="range"
                data-testid="text-arc-slider"
                min={ARC_SWEEP_MIN}
                max={ARC_SWEEP_MAX}
                step={5}
                value={selection.text.arc}
                aria-label="Arc bend in degrees"
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (!Number.isFinite(value) || value === 0) return;
                  setArc(value);
                }}
              />
            </div>
          )}
          {selection.text.arc === null && (
            <>
              <div className="text-panel__field" role="group" aria-label="Outline">
                <span className="text-panel__label">Outline</span>
                <div className="fx-row">
                  {OUTLINE_PRESETS.map((preset) => {
                    const cur = selection.text!.outline;
                    const active = preset.outline
                      ? Boolean(cur) &&
                        cur!.color === preset.outline.color &&
                        Math.round(cur!.width) === preset.outline.width
                      : !cur;
                    return (
                      <button
                        key={preset.key}
                        type="button"
                        data-testid={`fx-outline-${preset.key}`}
                        aria-pressed={active}
                        className={active ? 'fx-chip fx-chip--active' : 'fx-chip'}
                        onClick={() => applyOutlinePreset(preset.outline)}
                      >
                        <span
                          className="fx-chip__preview"
                          style={
                            preset.outline
                              ? {
                                  WebkitTextStroke: `${(preset.outline.width * 0.45).toFixed(1)}px ${preset.outline.color}`,
                                }
                              : undefined
                          }
                        >
                          Ag
                        </span>
                        <span className="fx-chip__label">{preset.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="text-panel__field" role="group" aria-label="Shadow">
                <span className="text-panel__label">Shadow</span>
                <div className="fx-row">
                  {SHADOW_PRESETS.map((preset) => {
                    const cur = selection.text!.shadow;
                    const active = preset.shadow
                      ? Boolean(cur) &&
                        Math.round(cur!.offsetX) === preset.shadow.offsetX &&
                        Math.round(cur!.offsetY) === preset.shadow.offsetY
                      : !cur;
                    return (
                      <button
                        key={preset.key}
                        type="button"
                        data-testid={`fx-shadow-${preset.key}`}
                        aria-pressed={active}
                        className={active ? 'fx-chip fx-chip--active' : 'fx-chip'}
                        onClick={() => applyShadowPreset(preset.shadow)}
                      >
                        <span
                          className="fx-chip__preview"
                          style={
                            preset.shadow
                              ? {
                                  textShadow: `${(preset.shadow.offsetX * 0.5).toFixed(1)}px ${(preset.shadow.offsetY * 0.5).toFixed(1)}px 0 ${preset.shadow.color}`,
                                }
                              : undefined
                          }
                        >
                          Ag
                        </span>
                        <span className="fx-chip__label">{preset.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <button
                type="button"
                className="text-panel__advanced-toggle"
                data-testid="text-advanced-toggle"
                aria-expanded={textAdvanced}
                onClick={() => setTextAdvanced((v) => !v)}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                  style={{ transform: textAdvanced ? 'rotate(90deg)' : undefined, transition: 'transform 140ms ease' }}
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
                Advanced
              </button>
              {textAdvanced && (
                <div className="text-panel__advanced" data-testid="text-advanced">
                  <div className="text-panel__field" role="group" aria-label="Text direction">
                    <span className="text-panel__label">Direction</span>
                    <div className="text-panel__align">
                      {(['auto', 'ltr', 'rtl'] as const).map((dir) => (
                        <button
                          key={dir}
                          type="button"
                          data-testid={`text-direction-${dir}`}
                          data-resolved={dir === 'auto' ? selection.text?.resolvedDirection : undefined}
                          className={
                            selection.text?.direction === dir
                              ? 'btn btn--ghost btn--small btn--active'
                              : 'btn btn--ghost btn--small'
                          }
                          onClick={() => setTextDirection(dir)}
                        >
                          {dir === 'auto' ? `auto (${selection.text?.resolvedDirection})` : dir}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="text-panel__field text-panel__wrap">
                    <span>
                      <input
                        type="checkbox"
                        data-testid="text-wrap-toggle"
                        checked={selection.text.wrap}
                        onChange={(e) => setTextWrap(e.target.checked)}
                      />{' '}
                      Wrap in box
                    </span>
                    <small>Side handles set the box width; text reflows inside it.</small>
                  </label>
                  {selection.text.outline && (
                    <div className="text-panel__field text-panel__effect" data-testid="text-outline-section">
                      <span className="text-panel__label">Outline color &amp; width</span>
                      <div className="text-panel__effect-row">
                        <input
                          type="color"
                          data-testid="text-outline-color"
                          value={selection.text.outline.color}
                          onChange={(e) => {
                            const color = e.target.value;
                            updateActiveText((t) => t.set({ stroke: color }));
                          }}
                        />
                        <input
                          type="number"
                          data-testid="text-outline-width"
                          min={OUTLINE_WIDTH_MIN}
                          max={OUTLINE_WIDTH_MAX}
                          value={Math.round(selection.text.outline.width)}
                          aria-label="Outline width"
                          onChange={(e) => {
                            const width = Number(e.target.value);
                            if (!Number.isFinite(width)) return;
                            const clamped = Math.min(Math.max(width, OUTLINE_WIDTH_MIN), OUTLINE_WIDTH_MAX);
                            updateActiveText((t) => t.set({ strokeWidth: clamped }));
                          }}
                        />
                      </div>
                    </div>
                  )}
                  {selection.text.shadow && (
                    <div className="text-panel__field text-panel__effect" data-testid="text-shadow-section">
                      <span className="text-panel__label">Shadow color &amp; offset</span>
                      <div className="text-panel__effect-row">
                        <input
                          type="color"
                          data-testid="text-shadow-color"
                          value={selection.text.shadow.color}
                          onChange={(e) => {
                            const color = e.target.value;
                            updateActiveText((t) => {
                              if (t.shadow) t.shadow.color = color;
                            });
                          }}
                        />
                        {(['offsetX', 'offsetY'] as const).map((axis) => (
                          <input
                            key={axis}
                            type="number"
                            data-testid={`text-shadow-${axis === 'offsetX' ? 'x' : 'y'}`}
                            min={-SHADOW_OFFSET_MAX}
                            max={SHADOW_OFFSET_MAX}
                            // Non-null: this row only renders inside the shadow guard above;
                            // TS just cannot see through the map callback.
                            value={Math.round(selection.text!.shadow![axis])}
                            aria-label={`Shadow ${axis}`}
                            onChange={(e) => {
                              const value = Number(e.target.value);
                              if (!Number.isFinite(value)) return;
                              const clamped = Math.min(Math.max(value, -SHADOW_OFFSET_MAX), SHADOW_OFFSET_MAX);
                              updateActiveText((t) => {
                                if (t.shadow) t.shadow[axis] = clamped;
                              });
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {selection.text.arc === null && selection.text.lineCount > TEXT_MAX_LINES && (
            <p
              className="text-panel__warning"
              role="alert"
              data-testid="text-overflow-warning"
            >
              Text wraps to more than {TEXT_MAX_LINES} lines and cannot be saved.
              Shorten it or widen the box.
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        className="btn btn--ghost btn--small"
        data-testid="delete-object"
        onClick={removeActiveObject}
        style={{ marginTop: 10 }}
      >
        Remove selected
      </button>
    </div>
  ) : null;

  return (
    <div className="studio">
      {/* Always mounted so programmatic uploads work from any panel. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        style={{ display: 'none' }}
        data-testid="upload-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleUpload(file);
        }}
      />

      <header className="studio__topbar">
        <Link href="/" className="studio__back" aria-label="Back to products">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <div className="studio__product">
          <span className="studio__product-name">{template.name}</span>
          <Link href="/" className="studio__change-product">
            Change product
          </Link>
        </div>
        {designId && (
          <div className="badge" data-testid="editing-badge">
            Editing saved design · {designId.slice(0, 8)}
            {dirty ? ' · unsaved changes' : ''}
          </div>
        )}
        <div className="studio__topbar-spacer" />
        {/* data-history-version ties the buttons' disabled state to stack changes. */}
        <div className="studio__history" data-history-version={historyVersion}>
          <button
            type="button"
            data-testid="undo-button"
            disabled={busy !== null || undoStackRef.current.length === 0}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
            onClick={() => void undo()}
          >
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 5L3 10l5 5" />
              <path d="M3 10h11a6 6 0 0 1 0 12h-3" />
            </svg>
          </button>
          <button
            type="button"
            data-testid="redo-button"
            disabled={busy !== null || redoStackRef.current.length === 0}
            title="Redo (Ctrl+Y)"
            aria-label="Redo"
            onClick={() => void redo()}
          >
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M16 5l5 5-5 5" />
              <path d="M21 10H10a6 6 0 0 0 0 12h3" />
            </svg>
          </button>
        </div>
        <div className="studio__mode-tabs" role="group" aria-label="Editor mode">
          <button type="button" className="studio__mode-tab studio__mode-tab--active">
            Design
          </button>
          {/* Save clears the previous render, so this tab RENDERS then navigates
              (same as the Generate button) instead of linking to an empty page.
              Disabled until the design is saved with no pending edits. */}
          <button
            type="button"
            className="studio__mode-tab"
            data-testid="mode-mockups"
            disabled={busy !== null || !designId || dirty}
            title={
              !designId
                ? 'Save the design first'
                : dirty
                  ? 'Save your changes first'
                  : 'Render and view the mockups'
            }
            onClick={() => void handleRender()}
          >
            {busy === 'render' ? 'Rendering...' : 'Mockups'}
          </button>
        </div>
        <Link href="/designs" className="studio__close" aria-label="Close editor">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </Link>
      </header>

      <div className="studio__body">
        <nav className="studio__toolrail" aria-label="Tools">
          {TOOL_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              className={tool === key ? 'studio__tool studio__tool--active' : 'studio__tool'}
              data-testid={`tool-${key}`}
              aria-pressed={tool === key}
              onClick={() => setTool(key)}
            >
              {TOOL_ICONS[key]}
              <span>{TOOL_LABELS[key]}</span>
            </button>
          ))}
        </nav>

        <aside className="studio__panel">
          {tool === 'product' && (
            <>
              <p className="studio__panel-title">Product</p>
              <div className="studio__panel-product">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={apiUrl(activeColor?.thumbUrl ?? template.thumbUrl ?? template.imageUrl)}
                  alt={template.name}
                  width={56}
                  height={56}
                />
                <div>
                  <b>{template.name}</b>
                  <span>
                    {template.canvasWidth} x {template.canvasHeight} px canvas
                  </span>
                </div>
              </div>
              {template.colors.length > 0 && (
                <div className="studio__panel-section">
                  <p className="studio__panel-title">Color</p>
                  <div className="studio__swatches" role="radiogroup" aria-label="Garment color">
                    {template.colors.map((c) => (
                      <button
                        key={c.key}
                        type="button"
                        role="radio"
                        aria-checked={c.key === colorKey}
                        aria-label={c.name}
                        title={c.name}
                        className={c.key === colorKey ? 'swatch swatch--active' : 'swatch'}
                        data-testid={`color-swatch-${c.key}`}
                        onClick={() => handleColorChange(c.key)}
                      >
                        <span className="swatch__chip" style={{ background: c.hex }} />
                      </button>
                    ))}
                  </div>
                  <p className="studio__panel-copy" data-testid="active-color-name">
                    {activeColor?.name ?? ''}
                  </p>
                </div>
              )}
              <div className="studio__panel-section">
                <p className="studio__panel-title">Size</p>
                <div className="studio__sizes" role="radiogroup" aria-label="Garment size">
                  {GARMENT_SIZES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={s === size}
                      className={s === size ? 'size-chip size-chip--active' : 'size-chip'}
                      data-testid={`size-chip-${s}`}
                      onClick={() => handleSizeChange(s === size ? '' : s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <p className="studio__panel-copy">
                  {size ? `Size ${size}` : 'No size selected (optional).'}
                </p>
              </div>
              <div className="studio__panel-section">
                <p className="studio__panel-title">Print sides</p>
                <ul className="studio__area-list">
                  {template.printAreas.map((a) => (
                    <li key={a.key}>
                      <button
                        type="button"
                        className={
                          a.key === activeAreaKey
                            ? 'studio__area-row studio__area-row--active'
                            : 'studio__area-row'
                        }
                        onClick={() => setActiveAreaKey(a.key)}
                      >
                        {a.name}
                        {areaCounts[a.key] ? (
                          <span className="area-tab__count">{areaCounts[a.key]}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="studio__panel-section">
                <Link href="/" className="studio__change-product">
                  Change product
                </Link>
              </div>
            </>
          )}

          {tool === 'templates' && (
            <>
              <p className="studio__panel-title">Templates</p>
              <p className="studio__panel-copy">
                Start from a ready-made look on <b>{activeArea?.name ?? 'the active side'}</b>, then
                edit any line.
              </p>
              <div className="template-gallery" data-testid="template-gallery">
                {DESIGN_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.key}
                    type="button"
                    className="template-card"
                    data-testid={`template-${tpl.key}`}
                    disabled={busy !== null}
                    title={tpl.name}
                    onClick={() => void applyTemplate(tpl)}
                  >
                    <span className="template-card__preview" aria-hidden>
                      {tpl.lines.map((line, i) => {
                        const def = fontDefinitionOf(line.fontKey);
                        return (
                          <span
                            key={i}
                            className="template-card__line"
                            style={{
                              fontFamily: def?.family,
                              color: line.fill,
                              fontSize: `${Math.max(8, Math.round(line.sizeFrac * 150))}px`,
                              letterSpacing: line.letterSpacing ? `${Math.min(line.letterSpacing / 8, 3)}px` : undefined,
                              ...(line.outline
                                ? { WebkitTextStroke: `${(line.outline.width * 0.3).toFixed(1)}px ${line.outline.color}` }
                                : {}),
                              ...(line.shadow
                                ? { textShadow: `${(line.shadow.offsetX * 0.4).toFixed(1)}px ${(line.shadow.offsetY * 0.4).toFixed(1)}px 0 ${line.shadow.color}` }
                                : {}),
                            }}
                          >
                            {line.text}
                          </span>
                        );
                      })}
                    </span>
                    <span className="template-card__name">{tpl.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {tool === 'uploads' && (
            <>
              <p className="studio__panel-title">Uploads</p>
              <p className="studio__panel-copy">
                PNG or JPEG, up to 10 MB. Artwork lands on <b>{activeArea?.name ?? 'the active side'}</b>.
              </p>
              <button
                type="button"
                className="btn"
                data-testid="upload-button"
                disabled={busy !== null}
                onClick={() => fileInputRef.current?.click()}
              >
                {busy === 'upload' ? 'Uploading...' : 'Upload artwork'}
              </button>
              {selectionSection}
            </>
          )}

          {tool === 'text' && (
            <>
              <p className="studio__panel-title">Text</p>
              <p className="studio__panel-copy">
                Add a line of text to <b>{activeArea?.name ?? 'the active side'}</b>, then style it
                below.
              </p>
              <button
                type="button"
                className="btn"
                data-testid="add-text-button"
                disabled={busy !== null}
                onClick={() => void handleAddText()}
              >
                Add text
              </button>
              {selectionSection}
            </>
          )}

          {tool === 'saved' && (
            <>
              <p className="studio__panel-title">Saved design</p>
              {designId ? (
                <p className="studio__panel-copy">
                  Editing <b>{designId.slice(0, 8)}</b>
                  {dirty ? ', with unsaved changes.' : ', all changes saved.'}
                </p>
              ) : (
                <p className="studio__panel-copy">
                  This design has not been saved yet. Save it from the bar below to render mockups
                  and find it in the library later.
                </p>
              )}
              <div className="studio__panel-section">
                <ul className="studio__area-list">
                  {designId && (
                    <li>
                      <Link href={`/designs/${designId}`} className="studio__area-row">
                        View mockups
                      </Link>
                    </li>
                  )}
                  <li>
                    <Link href="/designs" className="studio__area-row">
                      Open design library
                    </Link>
                  </li>
                  <li>
                    <Link href={`/editor/${template.slug}`} className="studio__area-row">
                      Start a fresh design
                    </Link>
                  </li>
                </ul>
              </div>
            </>
          )}

          {tool === 'layers' && (
            <>
              <p className="studio__panel-title">Layers · {activeArea?.name ?? 'this side'}</p>
              {layerObjects.length > 0 ? (
                <ul className="studio__layer-list">
                  {layerObjects.map((obj, index) => (
                    <li key={index}>
                      <button
                        type="button"
                        className={
                          obj === activeCanvasObject
                            ? 'studio__layer studio__layer--active'
                            : 'studio__layer'
                        }
                        onClick={() => selectLayer(obj)}
                      >
                        {TOOL_ICONS[obj.kind === 'text' ? 'text' : 'uploads']}
                        <span>
                          {obj.kind === 'text'
                            ? ((obj as DesignedText).text ?? 'Text').split('\n')[0]!.slice(0, 26) || 'Text'
                            : 'Image'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="studio__layer-empty">
                  Nothing on this side yet. Upload artwork or add text to see it here.
                </p>
              )}
              {selectionSection}
            </>
          )}
        </aside>

        <section
          ref={stageSectionRef}
          className="studio__stage"
          aria-label="Design workspace"
          onDragOver={handleStageDragOver}
          onDragLeave={handleStageDragLeave}
          onDrop={handleStageDrop}
        >
          {dropActive && (
            <div className="studio__dropzone" data-testid="stage-dropzone">
              <span>
                Drop to upload to <strong>{activeArea?.name ?? 'this side'}</strong>
              </span>
            </div>
          )}
          {cropping && (
            <div
              className="studio__context-bar"
              role="toolbar"
              aria-label="Crop"
              data-testid="crop-toolbar"
            >
              <button
                type="button"
                className="studio__context-tool"
                data-testid="crop-cancel"
                disabled={busy !== null}
                onClick={cancelCrop}
              >
                <span>Cancel</span>
              </button>
              <button
                type="button"
                className="studio__context-tool studio__context-tool--active"
                data-testid="crop-apply"
                disabled={busy !== null}
                onClick={() => void applyCrop()}
              >
                <span>{busy === 'crop' ? 'Cropping...' : 'Apply crop'}</span>
              </button>
            </div>
          )}
          {selection && !cropping && (
            <div
              className="studio__context-bar"
              role="toolbar"
              aria-label="Object tools"
              data-testid="context-toolbar"
            >
              {(selection.kind === 'image'
                ? (['transform', 'position', 'pattern'] as const)
                : (['transform', 'position'] as const)
              ).map((key) => (
                <button
                  key={key}
                  type="button"
                  data-testid={`context-tool-${key}`}
                  aria-pressed={objectTool === key}
                  className={
                    objectTool === key
                      ? 'studio__context-tool studio__context-tool--active'
                      : 'studio__context-tool'
                  }
                  onClick={() => setObjectTool((open) => (open === key ? null : key))}
                >
                  {CONTEXT_TOOL_ICONS[key]}
                  <span>
                    {key === 'transform' ? 'Transform' : key === 'position' ? 'Position' : 'Pattern'}
                  </span>
                </button>
              ))}
              {selection.kind === 'image' && (
                <>
                  <button
                    type="button"
                    data-testid="context-tool-crop"
                    className="studio__context-tool"
                    disabled={busy !== null}
                    onClick={startCrop}
                  >
                    {CONTEXT_TOOL_ICONS.crop}
                    <span>Crop</span>
                  </button>
                  <button
                    type="button"
                    data-testid="context-tool-remove-bg"
                    className="studio__context-tool"
                    disabled={busy !== null}
                    onClick={() => void handleRemoveBackground()}
                  >
                    {CONTEXT_TOOL_ICONS['remove-bg']}
                    <span>{busy === 'removebg' ? 'Removing...' : 'Remove background'}</span>
                  </button>
                </>
              )}
            </div>
          )}

          {selection && objectTool === 'transform' && (
            <div className="studio__object-panel" data-testid="object-panel-transform">
              <p className="studio__object-panel-title">Rotate</p>
              {selection.pattern && (
                <p style={{ margin: '0 0 8px', fontSize: 12.5 }}>
                  Patterned tiles are axis-aligned; turn the pattern off to rotate.
                </p>
              )}
              <div className="studio__rotate-row" style={selection.pattern ? { display: 'none' } : undefined}>
                <input
                  type="range"
                  min={0}
                  max={359}
                  step={1}
                  value={selectionAngle}
                  data-testid="rotate-slider"
                  aria-label="Rotation in degrees"
                  onChange={(e) => setActiveAngle(Number(e.target.value))}
                />
                <input
                  type="number"
                  min={0}
                  max={359}
                  value={selectionAngle}
                  data-testid="rotate-input"
                  aria-label="Rotation in degrees"
                  onChange={(e) => {
                    const angle = Number(e.target.value);
                    if (Number.isFinite(angle)) setActiveAngle(angle);
                  }}
                />
              </div>
            </div>
          )}

          {selection && objectTool === 'pattern' && (
            <div className="studio__object-panel" data-testid="object-panel-pattern">
              <p className="studio__object-panel-title">Pattern</p>
              <div className="fx-row fx-row--pattern" role="group" aria-label="Pattern type">
                {PATTERN_CHOICES.map((choice) => {
                  const active = (selection.pattern?.type ?? null) === choice.key;
                  return (
                    <button
                      key={choice.label}
                      type="button"
                      aria-pressed={active}
                      className={active ? 'fx-chip fx-chip--active' : 'fx-chip'}
                      data-testid={`pattern-type-${choice.key ?? 'none'}`}
                      onClick={() =>
                        setImagePattern(
                          choice.key
                            ? { type: choice.key, spacing: selection.pattern?.spacing ?? 0 }
                            : null,
                        )
                      }
                    >
                      <span className="fx-chip__tile">{choice.icon}</span>
                      <span className="fx-chip__label">{choice.label}</span>
                    </button>
                  );
                })}
              </div>
              {selection.pattern && (
                <div className="studio__rotate-row" style={{ marginTop: 10 }}>
                  <span style={{ fontSize: 12.5 }}>Spacing</span>
                  <input
                    type="range"
                    min={PATTERN_SPACING_MIN}
                    max={PATTERN_SPACING_MAX}
                    step={1}
                    value={Math.round(selection.pattern.spacing)}
                    data-testid="pattern-spacing-slider"
                    aria-label="Pattern spacing"
                    onChange={(e) => {
                      const spacing = Number(e.target.value);
                      if (!Number.isFinite(spacing) || !selection.pattern) return;
                      setImagePattern({ type: selection.pattern.type, spacing });
                    }}
                  />
                  <input
                    type="number"
                    min={PATTERN_SPACING_MIN}
                    max={PATTERN_SPACING_MAX}
                    value={Math.round(selection.pattern.spacing)}
                    data-testid="pattern-spacing-input"
                    aria-label="Pattern spacing"
                    onChange={(e) => {
                      const spacing = Number(e.target.value);
                      if (!Number.isFinite(spacing) || !selection.pattern) return;
                      const clamped = Math.min(
                        Math.max(spacing, PATTERN_SPACING_MIN),
                        PATTERN_SPACING_MAX,
                      );
                      setImagePattern({ type: selection.pattern.type, spacing: clamped });
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {selection && objectTool === 'position' && (
            <div className="studio__object-panel" data-testid="object-panel-position">
              <p className="studio__object-panel-title">Align to print area</p>
              <div className="studio__align-row" role="group" aria-label="Align object">
                {ALIGN_ACTIONS.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    className="studio__align-btn"
                    data-testid={`align-${action.key}`}
                    title={action.label}
                    aria-label={action.label}
                    onClick={() => alignActiveObject(action.key)}
                  >
                    {action.icon}
                  </button>
                ))}
              </div>
              {/* One-click logo placements, per side; single images only
                  (patterned tiles already fill the area). */}
              {selection.kind === 'image' &&
                !selection.pattern &&
                (activeArea?.key === 'front' || activeArea?.key === 'back') && (
                  <>
                    <p className="studio__object-panel-title">Placement</p>
                    <div className="studio__preset-row" role="group" aria-label="Placement presets">
                      {PLACEMENT_PRESETS[activeArea.key].map((preset) => (
                        <button
                          key={preset.key}
                          type="button"
                          className="studio__preset-btn"
                          data-testid={`placement-${preset.key}`}
                          onClick={() => applyPlacementPreset(preset.key)}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
            </div>
          )}

          <div
            ref={stageWrapRef}
            className="studio__canvas-wrap"
            style={{ width: STAGE_WIDTH, height: stageHeight }}
            data-testid="editor-stage"
          >
            <canvas ref={canvasElRef} width={STAGE_WIDTH} height={stageHeight} />
          </div>

          <p className="studio__hint">
            The dashed <strong>frame</strong> is the printable area for{' '}
            {activeArea?.name ?? 'this side'}.
          </p>

          <div className="studio__zoom" role="group" aria-label="Zoom">
            <button
              type="button"
              aria-label="Zoom out"
              disabled={viewZoom <= VIEW_ZOOM_MIN}
              onClick={() => setViewZoom((v) => Math.max(VIEW_ZOOM_MIN, v / VIEW_ZOOM_STEP))}
            >
              −
            </button>
            <span className="studio__zoom-value" data-testid="zoom-value">
              {zoomPercent}%
            </span>
            <button
              type="button"
              aria-label="Zoom in"
              disabled={viewZoom >= VIEW_ZOOM_MAX}
              onClick={() => setViewZoom((v) => Math.min(VIEW_ZOOM_MAX, v * VIEW_ZOOM_STEP))}
            >
              +
            </button>
            <button
              type="button"
              aria-label="Reset to normal view"
              title="Reset to normal view"
              disabled={viewZoom === 1}
              onClick={() => setViewZoom(1)}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4" />
              </svg>
            </button>
            <span className="studio__zoom-divider" aria-hidden />
            <button
              type="button"
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              aria-pressed={isFullscreen}
              onClick={toggleFullscreen}
            >
              {isFullscreen ? (
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
                </svg>
              )}
            </button>
          </div>

          <div className="studio__status">
            <div className={statusClass} data-testid="editor-status" aria-live="polite">
              {status.message}
              {status.details && status.details.length > 0 && (
                <ul>
                  {status.details.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      </div>

      <footer className="studio__bottombar">
        <div className="studio__sides" role="tablist" aria-label="Print areas">
          {template.printAreas.map((a) => (
            <button
              key={a.key}
              type="button"
              role="tab"
              aria-selected={a.key === activeAreaKey}
              className={a.key === activeAreaKey ? 'area-tab area-tab--active' : 'area-tab'}
              data-testid={`area-tab-${a.key}`}
              onClick={() => setActiveAreaKey(a.key)}
            >
              <span className="area-tab__thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={apiUrl(viewImagesOf(a).thumbUrl)} alt="" width={46} height={46} />
              </span>
              {a.name}
              {areaCounts[a.key] ? <span className="area-tab__count">{areaCounts[a.key]}</span> : null}
            </button>
          ))}
          {template.printAreas.length > 1 && (
            <button
              type="button"
              className="area-tab area-tab--overview"
              data-testid="overview-button"
              onClick={openOverview}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              Overview
            </button>
          )}
        </div>
        <p className="studio__bottom-meta">
          {totalObjects} object{totalObjects === 1 ? '' : 's'} across {placedAreas || 'no'} side
          {placedAreas === 1 ? '' : 's'} · server validates every save per print area
        </p>
        <div className="studio__ctas">
          {/* The accent highlight follows the next logical step: Save while there
              are unsaved edits, then Generate once the design is saved & clean. */}
          <button
            type="button"
            className={`btn${totalObjects > 0 && (designId === null || dirty) ? ' btn--accent' : ''}`}
            data-testid="save-design"
            disabled={busy !== null || totalObjects === 0 || (designId !== null && !dirty)}
            onClick={() => void handleSave()}
          >
            {saveLabel}
          </button>
          <button
            type="button"
            className={`btn${Boolean(designId) && !dirty ? ' btn--accent' : ''}`}
            data-testid="generate-mockup"
            disabled={busy !== null || !designId || dirty}
            onClick={() => void handleRender()}
            title={
              !designId
                ? 'Save the design first to see mockups'
                : dirty
                  ? 'Save your changes first'
                  : undefined
            }
          >
            {busy === 'render' ? 'Rendering...' : 'Generate mockups'}
          </button>
        </div>
      </footer>

      {overviewOpen && (
        <div
          className="overview"
          role="dialog"
          aria-modal="true"
          aria-label="Placement overview"
          data-testid="overview-modal"
          onClick={() => setOverviewOpen(false)}
        >
          <div className="overview__sheet" onClick={(e) => e.stopPropagation()}>
            <div className="overview__head">
              <p>All placements</p>
              <button
                type="button"
                className="overview__close"
                aria-label="Close overview"
                data-testid="overview-close"
                onClick={() => setOverviewOpen(false)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="overview__grid">
              {template.printAreas.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  className={
                    a.key === activeAreaKey ? 'overview__tile overview__tile--active' : 'overview__tile'
                  }
                  data-testid={`overview-tile-${a.key}`}
                  onClick={() => {
                    setActiveAreaKey(a.key);
                    setOverviewOpen(false);
                  }}
                >
                  <canvas
                    ref={(el) => {
                      if (el) void drawAreaPreview(a.key, el);
                    }}
                    width={OVERVIEW_TILE_WIDTH}
                    height={Math.round(
                      (OVERVIEW_TILE_WIDTH * template.canvasHeight) / template.canvasWidth,
                    )}
                  />
                  <span className="overview__name">
                    {a.name}
                    {areaCounts[a.key] ? (
                      <span className="area-tab__count">{areaCounts[a.key]}</span>
                    ) : (
                      <span className="overview__empty">empty</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
            <p className="overview__hint">Click a side to jump to it.</p>
          </div>
        </div>
      )}
    </div>
  );
}
