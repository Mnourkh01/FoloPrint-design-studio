import type { PrintQualityLevel, Rect, StoredDesignPlacement } from './types';

/**
 * Print quality (DPI) math for image objects.
 *
 * Everything here is advisory: levels never feed into design validation and never
 * block a save or render. Pure and dependency-free so the editor (live UX) and the
 * API (authoritative response data) run the exact same numbers.
 *
 * Rotation is deliberately ignored: rotating a rigid rectangle does not change its
 * scale, so it cannot change the effective DPI.
 */

/** At or above this effective DPI the artwork prints sharp. */
export const DPI_OK_THRESHOLD = 150;
/** Below this effective DPI the artwork will likely print blurry. */
export const DPI_POOR_THRESHOLD = 100;
/** Assumed physical width of a print area when the template does not specify one (DTG platen). */
export const ASSUMED_PRINT_AREA_WIDTH_INCHES = 12;

/** A print area rect (canvas px) plus its optional physical size in inches. */
export interface PhysicalPrintArea extends Rect {
  widthInches?: number | null;
  heightInches?: number | null;
}

/** Canvas px per physical inch, per axis. */
export interface PixelsPerInch {
  x: number;
  y: number;
}

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Resolves the px-per-inch scale of a print area, applying the documented fallbacks:
 * a null/invalid physical width assumes ASSUMED_PRINT_AREA_WIDTH_INCHES; a
 * null/invalid physical height derives from the resolved width preserving the canvas
 * rect aspect (uniform ppi). Returns null when the canvas rect itself is unusable.
 */
export function printAreaPpi(area: PhysicalPrintArea): PixelsPerInch | null {
  if (!isPositiveFinite(area.width) || !isPositiveFinite(area.height)) return null;

  const widthInches = isPositiveFinite(area.widthInches)
    ? area.widthInches
    : ASSUMED_PRINT_AREA_WIDTH_INCHES;
  const heightInches = isPositiveFinite(area.heightInches)
    ? area.heightInches
    : widthInches * (area.height / area.width);

  return { x: area.width / widthInches, y: area.height / heightInches };
}

/** Level for an effective DPI value. Boundary values land on the better level. */
export function qualityLevelOf(dpi: number): PrintQualityLevel {
  if (dpi >= DPI_OK_THRESHOLD) return 'ok';
  if (dpi >= DPI_POOR_THRESHOLD) return 'warning';
  return 'poor';
}

export interface ObjectQuality {
  dpiX: number;
  dpiY: number;
  /** min(dpiX, dpiY): the worse axis governs perceived quality. */
  effectiveDpi: number;
  level: PrintQualityLevel;
}

/**
 * Effective print DPI of one placed image object.
 *
 * `asset` is the source bitmap in pixels, `object` the placed size in canvas px,
 * `ppi` the canvas-to-physical scale of the print area the object sits on.
 * Returns null ("unknown") when any input is unusable; unknown never warns, so bad
 * metadata can not produce a false positive.
 */
export function evaluateObjectQuality(
  asset: { width: number | null | undefined; height: number | null | undefined },
  object: { width: number; height: number },
  ppi: PixelsPerInch | null,
): ObjectQuality | null {
  if (!ppi || !isPositiveFinite(ppi.x) || !isPositiveFinite(ppi.y)) return null;
  if (!isPositiveFinite(asset.width) || !isPositiveFinite(asset.height)) return null;
  if (!isPositiveFinite(object.width) || !isPositiveFinite(object.height)) return null;

  const dpiX = (asset.width * ppi.x) / object.width;
  const dpiY = (asset.height * ppi.y) / object.height;
  const effectiveDpi = Math.min(dpiX, dpiY);

  return { dpiX, dpiY, effectiveDpi, level: qualityLevelOf(effectiveDpi) };
}

/** One advisory warning for a placed object whose effective DPI is below the ok threshold. */
export interface ObjectQualityWarning {
  printAreaKey: string;
  /** Index into that placement's objects array. */
  objectIndex: number;
  assetId: string;
  /** Rounded to an integer for display and payload stability. */
  effectiveDpi: number;
  level: 'warning' | 'poor';
}

/**
 * Walks a v2 document's placements and returns warnings only: ok-level objects and
 * objects with unknown inputs (missing asset dims, unknown area) stay silent.
 * Text objects are vector-like (no source bitmap), so DPI does not apply and they
 * are skipped entirely; objectIndex still refers to the full objects array.
 */
export function collectQualityWarnings(
  placements: Pick<StoredDesignPlacement, 'printAreaKey' | 'objects'>[],
  areas: (PhysicalPrintArea & { key: string })[],
  assetDimsById: Map<string, { width: number | null; height: number | null }>,
): ObjectQualityWarning[] {
  const ppiByKey = new Map(areas.map((area) => [area.key, printAreaPpi(area)]));
  const warnings: ObjectQualityWarning[] = [];

  for (const placement of placements) {
    const ppi = ppiByKey.get(placement.printAreaKey) ?? null;
    placement.objects.forEach((object, objectIndex) => {
      // Missing type = legacy image; only explicit text objects are skipped.
      if (object.type === 'text') return;
      const asset = assetDimsById.get(object.assetId);
      if (!asset) return;
      const quality = evaluateObjectQuality(asset, object, ppi);
      if (!quality || quality.level === 'ok') return;
      warnings.push({
        printAreaKey: placement.printAreaKey,
        objectIndex,
        assetId: object.assetId,
        effectiveDpi: Math.round(quality.effectiveDpi),
        level: quality.level,
      });
    });
  }

  return warnings;
}

/** The worse of two levels (poor > warning > ok). */
export function worseQualityLevel(a: PrintQualityLevel, b: PrintQualityLevel): PrintQualityLevel {
  const rank: Record<PrintQualityLevel, number> = { ok: 0, warning: 1, poor: 2 };
  return rank[a] >= rank[b] ? a : b;
}
