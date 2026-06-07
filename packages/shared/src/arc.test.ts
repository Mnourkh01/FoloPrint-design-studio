import { describe, expect, it } from 'vitest';
import { ARC_GLYPH_HEIGHT_FACTOR, layoutArcGlyphs } from './arc';

const advances = (n: number, w = 20) => Array.from({ length: n }, () => w);

describe('layoutArcGlyphs', () => {
  it('lays glyphs left to right with increasing x and tangent rotations', () => {
    const layout = layoutArcGlyphs(advances(5), 40, 90);
    expect(layout.positions).toHaveLength(5);
    for (let i = 1; i < 5; i++) {
      expect(layout.positions[i]!.x).toBeGreaterThan(layout.positions[i - 1]!.x);
    }
    // Rotations sweep symmetrically from negative to positive around the middle.
    expect(layout.positions[0]!.rotationDeg).toBeLessThan(0);
    expect(layout.positions[4]!.rotationDeg).toBeGreaterThan(0);
    expect(layout.positions[2]!.rotationDeg).toBeCloseTo(0, 5);
  });

  it('bows upward for positive sweep: ends sit lower than the middle', () => {
    const layout = layoutArcGlyphs(advances(5), 40, 120);
    const [first, , mid, , last] = layout.positions;
    expect(first!.y).toBeGreaterThan(mid!.y);
    expect(last!.y).toBeGreaterThan(mid!.y);
  });

  it('bows downward for negative sweep: ends sit higher than the middle', () => {
    const layout = layoutArcGlyphs(advances(5), 40, -120);
    const [first, , mid, , last] = layout.positions;
    expect(first!.y).toBeLessThan(mid!.y);
    expect(last!.y).toBeLessThan(mid!.y);
    // Tangents flip sign versus the upward bow.
    expect(layout.positions[0]!.rotationDeg).toBeGreaterThan(0);
  });

  it('keeps every glyph center inside the reported bounds', () => {
    for (const sweep of [30, 180, -30, -180]) {
      const layout = layoutArcGlyphs(advances(8, 25), 36, sweep, 4);
      for (const p of layout.positions) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(layout.width);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(layout.height);
      }
      expect(layout.height).toBeGreaterThanOrEqual(36 * ARC_GLYPH_HEIGHT_FACTOR);
    }
  });

  it('letter spacing widens the run (larger radius for the same sweep)', () => {
    const tight = layoutArcGlyphs(advances(6), 40, 90, 0);
    const spaced = layoutArcGlyphs(advances(6), 40, 90, 12);
    expect(spaced.radius).toBeGreaterThan(tight.radius);
    expect(spaced.width).toBeGreaterThan(tight.width);
  });

  it('handles empty input', () => {
    const layout = layoutArcGlyphs([], 40, 90);
    expect(layout.positions).toEqual([]);
    expect(layout.width).toBe(0);
  });
});
