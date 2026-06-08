/**
 * Vector shapes (v2.7): pure geometry + bounds for the rect/circle/star object kind.
 *
 * Shapes are vector-like (no source bitmap, so they never participate in the DPI
 * quality math, exactly like text). The star vertex math lives HERE so the editor
 * (Fabric Polygon) and the renderer (SVG <polygon>) compute byte-identical points
 * and can never disagree about the silhouette, the same discipline arc text uses
 * with layoutArcGlyphs.
 */

import type { Point } from './types';

/** Fixed five-point star; the inner radius is half the outer (classic star). */
export const STAR_POINTS = 5;
export const STAR_INNER_RATIO = 0.5;

/**
 * Vertices of a `points`-pointed star that exactly fills the width x height box
 * (origin top-left), with one outer point at top-center. Outer vertices ride the
 * box edges; inner vertices sit at `innerRatio` of the outer radius. x and y are
 * scaled independently so the star stretches with a non-square box. Shared by the
 * editor and the renderer so the two silhouettes are identical.
 */
export function starPolygonPoints(
  width: number,
  height: number,
  points: number = STAR_POINTS,
  innerRatio: number = STAR_INNER_RATIO,
): Point[] {
  const cx = width / 2;
  const cy = height / 2;
  const rx = width / 2;
  const ry = height / 2;
  const step = Math.PI / points; // half a point per vertex (outer, inner, outer, ...)
  const start = -Math.PI / 2; // first outer vertex points straight up
  const vertices: Point[] = [];
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? 1 : innerRatio;
    const angle = start + i * step;
    vertices.push({
      x: cx + radius * rx * Math.cos(angle),
      y: cy + radius * ry * Math.sin(angle),
    });
  }
  return vertices;
}
