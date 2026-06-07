/**
 * Arc text layout (v1.8): pure per-glyph placement along a circular arc.
 *
 * The editor (canvas measureText) and the renderer (Pango glyph rasters) both
 * measure their own per-glyph advances, then run THIS one function, so the two
 * sides can never disagree about the layout model. Residual metric drift is
 * absorbed by the renderer's fit-to-stored-box step, exactly like straight text.
 */

export const ARC_SWEEP_MIN = -180;
export const ARC_SWEEP_MAX = 180;

/** Glyph box height proxy (ascent+descent) as a fontSize multiple, both sides. */
export const ARC_GLYPH_HEIGHT_FACTOR = 1.2;

export interface ArcGlyphPlacement {
  /** Glyph center, in layout px, relative to the TOP-LEFT of the arc bounds. */
  x: number;
  y: number;
  /** Tangent rotation, degrees clockwise. */
  rotationDeg: number;
}

export interface ArcLayout {
  positions: ArcGlyphPlacement[];
  /** Tight bounds of all glyph boxes; the stored object box maps onto this. */
  width: number;
  height: number;
  radius: number;
}

/**
 * Lays glyph centers along an arc of `sweepDeg` degrees. Positive sweep bows the
 * text upward (circle center below the glyphs), negative downward. Each glyph is
 * centered on its advance-midpoint along the arc and rotated to the tangent.
 */
export function layoutArcGlyphs(
  advances: number[],
  fontSize: number,
  sweepDeg: number,
  letterSpacing = 0,
): ArcLayout {
  const n = advances.length;
  const glyphHeight = fontSize * ARC_GLYPH_HEIGHT_FACTOR;
  const totalLength =
    advances.reduce((sum, a) => sum + a, 0) + letterSpacing * Math.max(0, n - 1);
  const sweepRad = (Math.abs(sweepDeg) * Math.PI) / 180;
  const upward = sweepDeg > 0;
  const radius = totalLength / sweepRad;

  // Arc-length offset of each glyph center from the run start.
  const centers: number[] = [];
  let run = 0;
  for (let i = 0; i < n; i++) {
    centers.push(run + advances[i]! / 2);
    run += advances[i]! + letterSpacing;
  }

  // Circle center at (0, 0); glyphs sit on the radius at angle theta measured
  // from the arc's angular midpoint. For an upward bow the glyphs are ABOVE the
  // circle center (top of the circle).
  const raw: { x: number; y: number; rotationDeg: number }[] = [];
  for (const center of centers) {
    const t = totalLength === 0 ? 0.5 : center / totalLength; // 0..1 along the arc
    const theta = (t - 0.5) * sweepRad; // -sweep/2 .. +sweep/2
    if (upward) {
      raw.push({
        x: radius * Math.sin(theta),
        y: -radius * Math.cos(theta),
        rotationDeg: (theta * 180) / Math.PI,
      });
    } else {
      raw.push({
        x: radius * Math.sin(theta),
        y: radius * Math.cos(theta),
        rotationDeg: (-theta * 180) / Math.PI,
      });
    }
  }

  // Bounds from glyph centers expanded by the glyph box (height proxy; width of
  // a rotated glyph contributes via its own advance, approximated by the height
  // proxy on the extremes). A consistent approximation on both sides is what
  // matters, not tightness.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  raw.forEach((p, i) => {
    const half = Math.max(advances[i]! / 2, glyphHeight / 2);
    minX = Math.min(minX, p.x - half);
    maxX = Math.max(maxX, p.x + half);
    minY = Math.min(minY, p.y - glyphHeight / 2);
    maxY = Math.max(maxY, p.y + glyphHeight / 2);
  });
  if (n === 0 || !Number.isFinite(minX)) {
    return { positions: [], width: 0, height: 0, radius };
  }

  return {
    positions: raw.map((p) => ({
      x: p.x - minX,
      y: p.y - minY,
      rotationDeg: p.rotationDeg,
    })),
    width: maxX - minX,
    height: maxY - minY,
    radius,
  };
}
